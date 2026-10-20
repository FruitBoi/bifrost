import { GuildLink } from '../../db/entities/GuildLink';
import { VoiceLink } from '../../db/entities/VoiceLink';
import { LinkService, VoiceLinkListener } from '../LinkService';
import MetricsService from '../MetricsService';
import logger from '../../utils/logging/logger';
import { AudioMixer, AudioMixerFactory } from './AudioMixer';
import {
    OpusPacket,
    VoiceParticipant,
    VoiceParticipantUpdate,
    VoicePlatform,
    VoiceSession,
    VoiceTransport,
} from './VoiceTransport';

export interface VoiceBridgeServiceOptions {
    linkService: LinkService;
    discord: VoiceTransport;
    fluxer: VoiceTransport;
    createMixer: AudioMixerFactory;
    metricsService?: MetricsService;
    /** How long both channels may stay empty before the bot leaves. */
    leaveGraceMs?: number;
    /** Delays between successive join attempts after a failure or a drop. */
    joinRetryBackoffMs?: number[];
    /** How often a live bridge logs its per-direction audio counters. */
    statsIntervalMs?: number;
    /** How long after going live a side with people but no audio is flagged. */
    silentSideWarnMs?: number;
}

export interface LiveVoiceBridge {
    voiceLinkId: string;
    guildLinkId: string;
    discordChannelId: string;
    fluxerChannelId: string;
    since: Date;
    discordParticipants: number;
    fluxerParticipants: number;
}

export interface VoiceBridgeStatus {
    live: LiveVoiceBridge[];
}

const DEFAULT_LEAVE_GRACE_MS = 30_000;
const DEFAULT_JOIN_RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];
const DEFAULT_STATS_INTERVAL_MS = 15_000;
const DEFAULT_SILENT_SIDE_WARN_MS = 10_000;

/**
 * idle (no entry in `bridges`) → joining → live → leaving → idle.
 * A bridge that loses a session goes back to `joining` while it retries.
 */
type BridgeState = 'joining' | 'live' | 'leaving';

/** Cumulative audio counters of one side since it was wired. */
interface SideCounters {
    /** `audio` packets received from this side's session. */
    audioIn: number;
    /** Mixer frames sent to the other side. */
    framesOut: number;
    /** Sent frames that were not the mixer's silence frame. */
    voicedOut: number;
}

/** Optional per-session counters a transport may expose (duck-typed). */
interface SessionStats {
    framesIn: number;
    packetsOut: number;
    participants: number;
}

/** One side of a live bridge: the session we sit in and what it feeds. */
interface BridgeSide {
    platform: VoicePlatform;
    session: VoiceSession;
    /** Mixer this side's participants feed; its output goes to the other side. */
    mixer: AudioMixer;
    /** Non-bot participants currently in this side's channel. */
    participants: Map<string, VoiceParticipant>;
    counters: SideCounters;
    /** Snapshot of `counters` at the previous stats report. */
    reported: SideCounters;
    /** Removes every listener this side registered. */
    detach: () => void;
}

interface Bridge {
    link: VoiceLink;
    guildLink: GuildLink;
    state: BridgeState;
    since: Date;
    /** Bumped whenever the bridge is released so in-flight joins notice. */
    generation: number;
    retryAttempt: number;
    retryTimer: NodeJS.Timeout | null;
    leaveTimer: NodeJS.Timeout | null;
    statsTimer: NodeJS.Timeout | null;
    silentSideTimer: NodeJS.Timeout | null;
    discord: BridgeSide | null;
    fluxer: BridgeSide | null;
}

/**
 * Keeps the bot in both channels of a voice link while humans are around and
 * relays each side's mixed audio into the other.
 *
 * Joins are triggered by voice state updates seen on either transport (or by
 * a link being created/enabled while people are already in voice). Once the
 * bot is in, the sessions' own participant events drive mute mapping and the
 * auto-leave grace timer. Only one bridge per guild link can be live, since
 * a bot can only sit in one voice channel per guild on each platform.
 *
 * While live, every bridge counts the audio flowing in each direction and
 * logs the deltas periodically, so a one-way audio problem shows up in the
 * logs as a direction with `in=0` or `out=0`.
 */
export default class VoiceBridgeService implements VoiceLinkListener {
    private readonly linkService: LinkService;
    private readonly discord: VoiceTransport;
    private readonly fluxer: VoiceTransport;
    private readonly createMixer: AudioMixerFactory;
    private readonly metrics: MetricsService | null;
    private readonly leaveGraceMs: number;
    private readonly joinRetryBackoffMs: number[];
    private readonly statsIntervalMs: number;
    private readonly silentSideWarnMs: number;

    /** Every known voice link, kept current through onVoiceLinkChanged. */
    private readonly links = new Map<string, VoiceLink>();
    /** Bridges that are joining, live or leaving, keyed by voice link id. */
    private readonly bridges = new Map<string, Bridge>();

    private started = false;

    private readonly onDiscordUpdate = (update: VoiceParticipantUpdate) =>
        this.handleTransportUpdate('discord', update);
    private readonly onFluxerUpdate = (update: VoiceParticipantUpdate) =>
        this.handleTransportUpdate('fluxer', update);
    private readonly onDiscordError = (err: Error) =>
        logger.error('[VoiceBridge] ❌ Discord voice transport error', err);
    private readonly onFluxerError = (err: Error) =>
        logger.error('[VoiceBridge] ❌ Fluxer voice transport error', err);

    constructor(options: VoiceBridgeServiceOptions) {
        this.linkService = options.linkService;
        this.discord = options.discord;
        this.fluxer = options.fluxer;
        this.createMixer = options.createMixer;
        this.metrics = options.metricsService ?? null;
        this.leaveGraceMs = options.leaveGraceMs ?? DEFAULT_LEAVE_GRACE_MS;
        this.joinRetryBackoffMs = [
            ...(options.joinRetryBackoffMs ?? DEFAULT_JOIN_RETRY_BACKOFF_MS),
        ];
        this.statsIntervalMs =
            options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
        this.silentSideWarnMs =
            options.silentSideWarnMs ?? DEFAULT_SILENT_SIDE_WARN_MS;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.linkService.setVoiceLinkListener(this);
        this.discord.on('participantUpdate', this.onDiscordUpdate);
        this.discord.on('error', this.onDiscordError);
        this.fluxer.on('participantUpdate', this.onFluxerUpdate);
        this.fluxer.on('error', this.onFluxerError);

        let links: VoiceLink[] = [];
        try {
            links = await this.linkService.getAllVoiceLinks();
        } catch (err) {
            logger.error('[VoiceBridge] ❌ Failed to load voice links', err);
        }
        for (const link of links) {
            this.links.set(link.id, link);
        }

        logger.info(
            `[VoiceBridge] ✅ Started with ${links.length} voice link(s), ${links.filter((l) => l.enabled).length} enabled`
        );

        await Promise.all(
            links.filter((l) => l.enabled).map((l) => this.evaluate(l))
        );
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        this.linkService.setVoiceLinkListener(null);
        this.discord.off('participantUpdate', this.onDiscordUpdate);
        this.discord.off('error', this.onDiscordError);
        this.fluxer.off('participantUpdate', this.onFluxerUpdate);
        this.fluxer.off('error', this.onFluxerError);

        await Promise.all(
            [...this.bridges.values()].map((bridge) =>
                this.teardown(bridge, 'service stopping', false)
            )
        );
        this.links.clear();
    }

    onVoiceLinkChanged(voiceLinkId: string, link: VoiceLink | null): void {
        const bridge = this.bridges.get(voiceLinkId);

        if (!link) {
            this.links.delete(voiceLinkId);
            if (bridge) void this.teardown(bridge, 'voice link removed');
            return;
        }

        this.links.set(link.id, link);
        if (bridge) bridge.link = link;

        if (!link.enabled) {
            if (bridge) void this.teardown(bridge, 'voice link disabled');
            return;
        }

        void this.evaluate(link);
    }

    status(): VoiceBridgeStatus {
        const live: LiveVoiceBridge[] = [];
        for (const bridge of this.bridges.values()) {
            if (bridge.state !== 'live') continue;
            live.push({
                voiceLinkId: bridge.link.id,
                guildLinkId: bridge.link.guildLinkId,
                discordChannelId: bridge.link.discordChannelId,
                fluxerChannelId: bridge.link.fluxerChannelId,
                since: bridge.since,
                discordParticipants: bridge.discord?.participants.size ?? 0,
                fluxerParticipants: bridge.fluxer?.participants.size ?? 0,
            });
        }
        return { live };
    }

    // ---------------------------------------------------------------------
    // Join triggers
    // ---------------------------------------------------------------------

    private handleTransportUpdate(
        platform: VoicePlatform,
        update: VoiceParticipantUpdate
    ) {
        if (!this.started) return;
        if (update.channelId === null) return;
        if (update.isBot || this.isBotUser(update.userId)) return;

        for (const link of this.links.values()) {
            if (!link.enabled) continue;
            const channelId =
                platform === 'discord'
                    ? link.discordChannelId
                    : link.fluxerChannelId;
            if (channelId !== update.channelId) continue;
            void this.evaluate(link);
        }
    }

    /** Re-checks every enabled link of a guild link, e.g. after one left. */
    private evaluateGuildLink(guildLinkId: string) {
        if (!this.started) return;
        for (const link of this.links.values()) {
            if (link.guildLinkId === guildLinkId && link.enabled) {
                void this.evaluate(link);
            }
        }
    }

    /** Starts a bridge for `link` if humans are present and nothing blocks it. */
    private async evaluate(link: VoiceLink): Promise<void> {
        if (!this.started || !link.enabled) return;
        if (this.bridges.has(link.id)) return;

        let guildLink: GuildLink | null;
        try {
            guildLink = await this.linkService.getGuildLinkById(
                link.guildLinkId
            );
        } catch (err) {
            logger.error(
                `[VoiceBridge] ❌ Failed to load guild link ${link.guildLinkId} for voice link ${link.id}`,
                err
            );
            return;
        }
        if (!guildLink) {
            logger.warn(
                `[VoiceBridge] ⚠️ Voice link ${link.id} references missing guild link ${link.guildLinkId}`
            );
            return;
        }

        // Everything after the await is synchronous, so concurrent
        // evaluations of the same link cannot both get past these checks.
        const current = this.links.get(link.id);
        if (!this.started || !current || !current.enabled) return;
        if (this.bridges.has(link.id)) return;

        const other = this.bridgeForGuildLink(link.guildLinkId);
        if (other) {
            logger.info(
                `[VoiceBridge] ⏭️ Skipping voice link ${link.id}: voice link ${other.link.id} of the same guild link is already ${other.state}`
            );
            return;
        }

        if (!this.humansPresent(current, guildLink)) return;

        const bridge: Bridge = {
            link: current,
            guildLink,
            state: 'joining',
            since: new Date(),
            generation: 0,
            retryAttempt: 0,
            retryTimer: null,
            leaveTimer: null,
            statsTimer: null,
            silentSideTimer: null,
            discord: null,
            fluxer: null,
        };
        this.bridges.set(link.id, bridge);
        await this.attemptJoin(bridge);
    }

    private bridgeForGuildLink(guildLinkId: string): Bridge | null {
        for (const bridge of this.bridges.values()) {
            if (bridge.link.guildLinkId === guildLinkId) return bridge;
        }
        return null;
    }

    private humansPresent(link: VoiceLink, guildLink: GuildLink): boolean {
        return (
            this.humansIn(
                this.discord,
                guildLink.discordGuildId,
                link.discordChannelId
            ) ||
            this.humansIn(
                this.fluxer,
                guildLink.fluxerGuildId,
                link.fluxerChannelId
            )
        );
    }

    private humansIn(
        transport: VoiceTransport,
        guildId: string,
        channelId: string
    ): boolean {
        try {
            return transport
                .listParticipants(guildId, channelId)
                .some((p) => this.isHuman(p));
        } catch (err) {
            logger.error(
                `[VoiceBridge] ❌ Failed to list ${transport.platform} participants of ${channelId}`,
                err
            );
            return false;
        }
    }

    private isHuman(participant: VoiceParticipant): boolean {
        return !participant.isBot && !this.isBotUser(participant.userId);
    }

    private isBotUser(userId: string): boolean {
        return (
            userId === this.discord.botUserId() ||
            userId === this.fluxer.botUserId()
        );
    }

    // ---------------------------------------------------------------------
    // Joining
    // ---------------------------------------------------------------------

    private async attemptJoin(bridge: Bridge): Promise<void> {
        const { link, guildLink } = bridge;
        const generation = bridge.generation;
        const stale = () =>
            this.bridges.get(link.id) !== bridge ||
            bridge.generation !== generation;

        if (!this.humansPresent(link, guildLink)) {
            logger.info(
                `[VoiceBridge] 👋 Not joining voice link ${link.id}: both channels are empty`
            );
            this.bridges.delete(link.id);
            return;
        }

        logger.info(
            `[VoiceBridge] 🔗 Joining voice link ${link.id}: Discord ${link.discordChannelId} + Fluxer ${link.fluxerChannelId}`
        );

        let discordSession: VoiceSession;
        try {
            discordSession = await this.discord.join(
                guildLink.discordGuildId,
                link.discordChannelId
            );
        } catch (err) {
            if (!stale()) this.handleJoinFailure(bridge, 'discord', err);
            return;
        }
        if (stale()) {
            await this.safeLeave(discordSession);
            return;
        }

        let discordClosedEarly: string | null = null;
        const onEarlyClose = (reason: string) => {
            discordClosedEarly = reason;
        };
        discordSession.on('closed', onEarlyClose);

        let fluxerSession: VoiceSession;
        try {
            fluxerSession = await this.fluxer.join(
                guildLink.fluxerGuildId,
                link.fluxerChannelId
            );
        } catch (err) {
            discordSession.off('closed', onEarlyClose);
            await this.safeLeave(discordSession);
            if (!stale()) this.handleJoinFailure(bridge, 'fluxer', err);
            return;
        }
        discordSession.off('closed', onEarlyClose);

        if (stale()) {
            await Promise.all([
                this.safeLeave(discordSession),
                this.safeLeave(fluxerSession),
            ]);
            return;
        }
        if (discordClosedEarly !== null) {
            await this.safeLeave(fluxerSession);
            if (!stale()) {
                this.handleJoinFailure(
                    bridge,
                    'discord',
                    new Error(
                        `Discord session closed before the Fluxer join finished: ${discordClosedEarly}`
                    )
                );
            }
            return;
        }

        this.wire(bridge, discordSession, fluxerSession);
        bridge.state = 'live';
        bridge.since = new Date();
        bridge.retryAttempt = 0;
        this.metrics?.voiceBridgeJoins.inc({ result: 'success' });
        this.updateLiveGauge();
        logger.info(
            `[VoiceBridge] 🎙️ Bridge live for voice link ${link.id}: Discord ${link.discordChannelId} <-> Fluxer ${link.fluxerChannelId}`
        );
        logger.info(
            `[VoiceBridge] 👥 link ${link.id} participants: ${this.describeParticipants(bridge)} · bots D=${this.discord.botUserId() ?? '?'} F=${this.fluxer.botUserId() ?? '?'}`
        );
        this.startDiagnostics(bridge);

        this.reconcileOccupancy(bridge);
    }

    private handleJoinFailure(
        bridge: Bridge,
        platform: VoicePlatform,
        err: unknown
    ) {
        this.metrics?.voiceBridgeJoins.inc({ result: 'failure' });
        logger.error(
            `[VoiceBridge] ❌ Failed to join ${platform} voice channel for voice link ${bridge.link.id}`,
            err
        );
        this.scheduleRetry(bridge);
    }

    private scheduleRetry(bridge: Bridge) {
        const attempt = bridge.retryAttempt;
        if (attempt >= this.joinRetryBackoffMs.length) {
            logger.warn(
                `[VoiceBridge] ⚠️ Giving up on voice link ${bridge.link.id} after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}; will try again when someone joins`
            );
            this.bridges.delete(bridge.link.id);
            this.updateLiveGauge();
            return;
        }

        const delay = this.joinRetryBackoffMs[attempt];
        bridge.retryAttempt = attempt + 1;
        bridge.state = 'joining';
        logger.info(
            `[VoiceBridge] 🔁 Retrying voice link ${bridge.link.id} in ${delay} ms (attempt ${attempt + 1}/${this.joinRetryBackoffMs.length})`
        );
        bridge.retryTimer = setTimeout(() => {
            bridge.retryTimer = null;
            void this.attemptJoin(bridge);
        }, delay);
    }

    // ---------------------------------------------------------------------
    // Live bridge wiring
    // ---------------------------------------------------------------------

    private wire(
        bridge: Bridge,
        discordSession: VoiceSession,
        fluxerSession: VoiceSession
    ) {
        // Discord participants feed `toFluxer`, whose frames go to Fluxer.
        const toFluxer = this.createMixer();
        const toDiscord = this.createMixer();

        bridge.discord = this.wireSide(
            bridge,
            'discord',
            discordSession,
            toFluxer,
            fluxerSession
        );
        bridge.fluxer = this.wireSide(
            bridge,
            'fluxer',
            fluxerSession,
            toDiscord,
            discordSession
        );

        toFluxer.start();
        toDiscord.start();
    }

    private wireSide(
        bridge: Bridge,
        platform: VoicePlatform,
        session: VoiceSession,
        mixer: AudioMixer,
        target: VoiceSession
    ): BridgeSide {
        const side: BridgeSide = {
            platform,
            session,
            mixer,
            participants: new Map(),
            counters: { audioIn: 0, framesOut: 0, voicedOut: 0 },
            reported: { audioIn: 0, framesOut: 0, voicedOut: 0 },
            detach: () => undefined,
        };

        const onAudio = (userId: string, packet: OpusPacket) => {
            if (this.isBotUser(userId)) return;
            side.counters.audioIn++;
            try {
                mixer.push(userId, packet);
            } catch (err) {
                logger.error(
                    `[VoiceBridge] ❌ Mixer rejected ${platform} audio for voice link ${bridge.link.id}`,
                    err
                );
            }
        };
        const onFrame = (packet: OpusPacket, silent?: boolean) => {
            try {
                target.sendOpus(packet);
            } catch (err) {
                logger.error(
                    `[VoiceBridge] ❌ Failed to send audio to ${target.platform} for voice link ${bridge.link.id}`,
                    err
                );
                return;
            }
            side.counters.framesOut++;
            if (silent !== true) side.counters.voicedOut++;
        };
        const onParticipant = (update: VoiceParticipantUpdate) =>
            this.handleSessionParticipant(bridge, side, update);
        const onClosed = (reason: string) =>
            void this.handleClosed(bridge, platform, reason);
        const onSessionError = (err: Error) =>
            logger.error(
                `[VoiceBridge] ❌ ${platform} session error for voice link ${bridge.link.id}`,
                err
            );
        const onMixerError = (err: Error) =>
            logger.error(
                `[VoiceBridge] ❌ Mixer error (${platform} side) for voice link ${bridge.link.id}`,
                err
            );

        session.on('audio', onAudio);
        session.on('participantUpdate', onParticipant);
        session.on('closed', onClosed);
        session.on('error', onSessionError);
        mixer.on('frame', onFrame);
        mixer.on('error', onMixerError);

        side.detach = () => {
            session.off('audio', onAudio);
            session.off('participantUpdate', onParticipant);
            session.off('closed', onClosed);
            session.off('error', onSessionError);
            mixer.off('frame', onFrame);
            mixer.off('error', onMixerError);
        };

        try {
            for (const participant of session.participants()) {
                if (!this.isHuman(participant)) continue;
                side.participants.set(participant.userId, participant);
                if (participant.selfMute || participant.selfDeaf) {
                    mixer.setSourceMuted(participant.userId, true);
                }
            }
        } catch (err) {
            logger.error(
                `[VoiceBridge] ❌ Failed to read ${platform} participants for voice link ${bridge.link.id}`,
                err
            );
        }

        return side;
    }

    private handleSessionParticipant(
        bridge: Bridge,
        side: BridgeSide,
        update: VoiceParticipantUpdate
    ) {
        if (bridge.state !== 'live') return;
        if (update.isBot || this.isBotUser(update.userId)) return;

        if (update.channelId === side.session.channelId) {
            const known = side.participants.get(update.userId);
            const muted = update.selfMute || update.selfDeaf;
            if (!known) {
                logger.info(
                    `[VoiceBridge] 🔗 ${update.userId} joined the ${side.platform} side of voice link ${bridge.link.id}${muted ? ' (muted)' : ''}`
                );
            } else if ((known.selfMute || known.selfDeaf) !== muted) {
                logger.info(
                    `[VoiceBridge] ${muted ? '🔇' : '🔊'} ${update.userId} ${muted ? 'muted' : 'unmuted'} on the ${side.platform} side of voice link ${bridge.link.id}`
                );
            }
            side.participants.set(update.userId, {
                userId: update.userId,
                isBot: update.isBot,
                selfMute: update.selfMute,
                selfDeaf: update.selfDeaf,
            });
            side.mixer.setSourceMuted(update.userId, muted);
        } else {
            if (side.participants.has(update.userId)) {
                logger.info(
                    `[VoiceBridge] 👋 ${update.userId} left the ${side.platform} side of voice link ${bridge.link.id}`
                );
            }
            side.participants.delete(update.userId);
            side.mixer.removeSource(update.userId);
        }

        this.reconcileOccupancy(bridge);
    }

    private humanCount(bridge: Bridge): number {
        return (
            (bridge.discord?.participants.size ?? 0) +
            (bridge.fluxer?.participants.size ?? 0)
        );
    }

    /** Starts or cancels the auto-leave grace timer based on who is left. */
    private reconcileOccupancy(bridge: Bridge) {
        if (bridge.state !== 'live') return;

        if (this.humanCount(bridge) === 0) {
            if (bridge.leaveTimer) return;
            logger.info(
                `[VoiceBridge] 👋 Both channels of voice link ${bridge.link.id} are empty; leaving in ${this.leaveGraceMs} ms`
            );
            bridge.leaveTimer = setTimeout(() => {
                bridge.leaveTimer = null;
                void this.teardown(bridge, 'both channels empty');
            }, this.leaveGraceMs);
        } else if (bridge.leaveTimer) {
            clearTimeout(bridge.leaveTimer);
            bridge.leaveTimer = null;
            logger.info(
                `[VoiceBridge] 🔗 Someone returned to voice link ${bridge.link.id}; staying`
            );
        }
    }

    // ---------------------------------------------------------------------
    // Diagnostics
    // ---------------------------------------------------------------------

    /**
     * Arms the periodic stats report and the one-shot "people but no audio"
     * check for a bridge that just went live. Both are cleared by
     * {@link clearTimers} when the bridge drops or leaves.
     */
    private startDiagnostics(bridge: Bridge) {
        bridge.statsTimer = setInterval(
            () => this.logStats(bridge),
            this.statsIntervalMs
        );
        bridge.silentSideTimer = setTimeout(() => {
            bridge.silentSideTimer = null;
            this.warnSilentSides(bridge);
        }, this.silentSideWarnMs);
    }

    /** One INFO line per bridge with the counter deltas since the last report. */
    private logStats(bridge: Bridge) {
        if (bridge.state !== 'live' || !bridge.discord || !bridge.fluxer) {
            return;
        }
        const d = this.takeDelta(bridge.discord);
        const f = this.takeDelta(bridge.fluxer);

        let line =
            `[VoiceBridge] 📊 link ${bridge.link.id}: ` +
            `Discord→Fluxer in=${d.audioIn} out=${d.framesOut} (${d.voicedOut} voiced) · ` +
            `Fluxer→Discord in=${f.audioIn} out=${f.framesOut} (${f.voicedOut} voiced) · ` +
            `participants D=${bridge.discord.participants.size} F=${bridge.fluxer.participants.size}`;

        for (const side of [bridge.discord, bridge.fluxer]) {
            const stats = this.sessionStats(side.session);
            if (!stats) continue;
            const label = side.platform === 'discord' ? 'Discord' : 'Fluxer';
            line += ` · ${label} session framesIn=${stats.framesIn} packetsOut=${stats.packetsOut} participants=${stats.participants}`;
        }

        logger.info(line);
    }

    private takeDelta(side: BridgeSide): SideCounters {
        const { counters, reported } = side;
        const delta: SideCounters = {
            audioIn: counters.audioIn - reported.audioIn,
            framesOut: counters.framesOut - reported.framesOut,
            voicedOut: counters.voicedOut - reported.voicedOut,
        };
        side.reported = { ...counters };
        return delta;
    }

    /** Reads `session.stats()` if the transport happens to provide one. */
    private sessionStats(session: VoiceSession): SessionStats | null {
        const candidate = (session as unknown as { stats?: unknown }).stats;
        if (typeof candidate !== 'function') return null;
        try {
            const stats = (candidate as () => unknown).call(session);
            if (!stats || typeof stats !== 'object') return null;
            const { framesIn, packetsOut, participants } =
                stats as Partial<SessionStats>;
            return {
                framesIn: Number(framesIn ?? 0),
                packetsOut: Number(packetsOut ?? 0),
                participants: Number(participants ?? 0),
            };
        } catch (err) {
            logger.debug(
                `[VoiceBridge] ⚠️ ${session.platform} session stats() threw: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
            return null;
        }
    }

    /**
     * Flags a side that has unmuted people in it but has not delivered a
     * single `audio` packet since the bridge went live: that is the shape
     * of a one-way audio bug, and it is otherwise invisible.
     */
    private warnSilentSides(bridge: Bridge) {
        if (bridge.state !== 'live') return;
        for (const side of [bridge.discord, bridge.fluxer]) {
            if (!side || side.counters.audioIn > 0) continue;
            const unmuted = [...side.participants.values()].filter(
                (p) => !p.selfMute && !p.selfDeaf
            );
            if (unmuted.length === 0) continue;
            const other = side.platform === 'discord' ? 'Fluxer' : 'Discord';
            const self = side.platform === 'discord' ? 'Discord' : 'Fluxer';
            logger.warn(
                `[VoiceBridge] ⚠️ link ${bridge.link.id}: no audio received from ${self} in the first ${this.silentSideWarnMs} ms although ${unmuted.length} unmuted participant(s) are there (${unmuted.map((p) => p.userId).join(', ')}); ${self}→${other} is silent — check the ${side.platform} transport's receive path`
            );
        }
    }

    private describeParticipants(bridge: Bridge): string {
        const list = (side: BridgeSide | null) => {
            if (!side || side.participants.size === 0) return '[]';
            const ids = [...side.participants.values()].map(
                (p) =>
                    `${p.userId}${p.selfDeaf ? ' (deaf)' : p.selfMute ? ' (muted)' : ''}`
            );
            return `[${ids.join(', ')}]`;
        };
        return `Discord ${list(bridge.discord)} · Fluxer ${list(bridge.fluxer)}`;
    }

    // ---------------------------------------------------------------------
    // Leaving and reconnecting
    // ---------------------------------------------------------------------

    private async handleClosed(
        bridge: Bridge,
        platform: VoicePlatform,
        reason: string
    ): Promise<void> {
        if (bridge.state !== 'live') return;

        const humans = this.humanCount(bridge);
        logger.warn(
            `[VoiceBridge] ⚠️ ${platform} voice session closed for voice link ${bridge.link.id}: ${reason}`
        );

        bridge.state = 'joining';
        bridge.generation++;
        this.clearTimers(bridge);
        this.updateLiveGauge();
        await this.releaseSides(bridge);

        // Torn down (link removed, service stopped) while we were leaving.
        if (this.bridges.get(bridge.link.id) !== bridge) return;

        const current = this.links.get(bridge.link.id);
        if (!this.started || !current?.enabled || humans === 0) {
            logger.info(
                `[VoiceBridge] 👋 Not reconnecting voice link ${bridge.link.id}: ${
                    humans === 0
                        ? 'nobody left in either channel'
                        : 'link no longer enabled'
                }`
            );
            this.bridges.delete(bridge.link.id);
            return;
        }

        bridge.retryAttempt = 0;
        this.scheduleRetry(bridge);
    }

    private async teardown(
        bridge: Bridge,
        reason: string,
        reevaluate = true
    ): Promise<void> {
        if (bridge.state === 'leaving') return;
        const wasLive = bridge.state === 'live';
        bridge.state = 'leaving';
        bridge.generation++;
        this.clearTimers(bridge);
        this.updateLiveGauge();

        if (wasLive) {
            logger.info(
                `[VoiceBridge] 👋 Leaving voice link ${bridge.link.id}: ${reason}`
            );
        }

        await this.releaseSides(bridge);

        if (this.bridges.get(bridge.link.id) === bridge) {
            this.bridges.delete(bridge.link.id);
        }

        // Someone may have arrived while we were leaving, or another link of
        // the same guild link may have been waiting for this one to go.
        if (reevaluate) this.evaluateGuildLink(bridge.link.guildLinkId);
    }

    private clearTimers(bridge: Bridge) {
        if (bridge.retryTimer) {
            clearTimeout(bridge.retryTimer);
            bridge.retryTimer = null;
        }
        if (bridge.leaveTimer) {
            clearTimeout(bridge.leaveTimer);
            bridge.leaveTimer = null;
        }
        if (bridge.statsTimer) {
            clearInterval(bridge.statsTimer);
            bridge.statsTimer = null;
        }
        if (bridge.silentSideTimer) {
            clearTimeout(bridge.silentSideTimer);
            bridge.silentSideTimer = null;
        }
    }

    /** Detaches listeners, stops mixers and leaves both sessions. Idempotent. */
    private async releaseSides(bridge: Bridge): Promise<void> {
        const sides = [bridge.discord, bridge.fluxer];
        bridge.discord = null;
        bridge.fluxer = null;

        const leaving: Promise<void>[] = [];
        for (const side of sides) {
            if (!side) continue;
            side.detach();
            try {
                side.mixer.stop();
            } catch (err) {
                logger.error(
                    `[VoiceBridge] ❌ Failed to stop mixer for voice link ${bridge.link.id}`,
                    err
                );
            }
            leaving.push(this.safeLeave(side.session));
        }
        await Promise.all(leaving);
    }

    private async safeLeave(session: VoiceSession): Promise<void> {
        try {
            await session.leave();
        } catch (err) {
            logger.error(
                `[VoiceBridge] ❌ Failed to leave ${session.platform} voice channel ${session.channelId}`,
                err
            );
        }
    }

    private updateLiveGauge() {
        if (!this.metrics) return;
        let live = 0;
        for (const bridge of this.bridges.values()) {
            if (bridge.state === 'live') live++;
        }
        this.metrics.voiceBridgesLive.set(live);
    }
}
