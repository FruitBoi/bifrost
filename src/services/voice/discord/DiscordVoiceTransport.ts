import { EventEmitter } from 'events';
import { Readable } from 'stream';
import {
    type Client,
    Events,
    type Guild,
    type VoiceState,
    PermissionFlagsBits,
} from 'discord.js';
import {
    type AudioPlayer,
    type AudioReceiveStream,
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
    NetworkingStatusCode,
    NoSubscriberBehavior,
    StreamType,
    type VoiceConnection,
    VoiceConnectionStatus,
} from '@discordjs/voice';
import logger from '../../../utils/logging/logger';
import type {
    OpusPacket,
    VoiceParticipant,
    VoiceParticipantUpdate,
    VoiceSession,
    VoiceTransport,
} from '../VoiceTransport';

/** How long to wait for the voice connection to become Ready on join. */
const JOIN_TIMEOUT_MS = 20_000;
/** Grace period for @discordjs/voice to recover from a Disconnected state. */
const RECONNECT_GRACE_MS = 5_000;
/**
 * Outbound frames queued for the player before we trim the backlog. The
 * mixer and the player each run their own wall-clock-locked 20 ms timer, so
 * the queue normally holds 0–2 frames; anything near this is 1 s of latency.
 */
const MAX_SEND_BACKLOG_FRAMES = 50;
/** Where a trimmed backlog is cut back to (100 ms). */
const BACKLOG_TRIM_TARGET_FRAMES = 5;
/** Frames the player tolerates without input before going Idle. */
const PLAYER_MAX_MISSED_FRAMES = 250; // 5 s at 20 ms
/** First playback stats line after the first frame; then every minute at debug. */
const FIRST_HEARTBEAT_MS = 5_000;
const HEARTBEAT_MS = 60_000;
/** Warn if DAVE E2EE negotiated a protocol but the session is still not ready. */
const DAVE_READY_WARN_MS = 10_000;

const TAG = '[DiscordVoice]';
/**
 * Library debug lines worth forwarding. Raw `<<`/`>>` WebSocket dumps and
 * networking state dumps are skipped: both include the transport secret key.
 */
const SAFE_DEBUG_LINE = /^\[NW\] \[(?:DAVE|UDP)\] |^\[NW\] \[WS\] (?!<<|>>)/;

/**
 * {@link VoiceTransport} for discord.js using @discordjs/voice.
 *
 * The client needs the `GuildVoiceStates` intent for voice state events
 * (and therefore for participant tracking and SSRC → user mapping on
 * receive). DAVE end-to-end encryption is negotiated automatically by
 * @discordjs/voice because `@snazzah/davey` is installed; transport
 * encryption uses `sodium-native`.
 */
export default class DiscordVoiceTransport
    extends EventEmitter
    implements VoiceTransport
{
    readonly platform = 'discord' as const;

    constructor(private readonly client: Client) {
        super();
        client.on(Events.VoiceStateUpdate, (oldState, newState) => {
            this.emit('participantUpdate', {
                ...this.toParticipant(newState),
                guildId: newState.guild.id,
                channelId: newState.channelId,
                previousChannelId: oldState.channelId,
            });
        });
    }

    botUserId(): string | null {
        return this.client.user?.id ?? null;
    }

    listParticipants(guildId: string, channelId: string): VoiceParticipant[] {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) return [];
        const botId = this.botUserId();
        return guild.voiceStates.cache
            .filter((vs) => vs.channelId === channelId && vs.id !== botId)
            .map((vs) => this.toParticipant(vs));
    }

    userVoiceChannel(guildId: string, userId: string): string | null {
        const guild = this.client.guilds.cache.get(guildId);
        return guild?.voiceStates.cache.get(userId)?.channelId ?? null;
    }

    async join(guildId: string, channelId: string): Promise<VoiceSession> {
        const guild =
            this.client.guilds.cache.get(guildId) ??
            (await this.client.guilds.fetch(guildId));

        const existing = getVoiceConnection(guildId);
        if (existing && existing.joinConfig.channelId !== channelId) {
            throw new Error(
                `Already connected to voice channel ${existing.joinConfig.channelId} in guild ${guildId}`
            );
        }

        const channel =
            guild.channels.cache.get(channelId) ??
            (await guild.channels.fetch(channelId));
        if (!channel || !channel.isVoiceBased()) {
            throw new Error(`Channel ${channelId} is not a voice channel`);
        }
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const permissions = channel.permissionsFor(me);
        if (
            !permissions.has(PermissionFlagsBits.Connect) ||
            !permissions.has(PermissionFlagsBits.Speak)
        ) {
            throw new Error(
                `Missing Connect/Speak permission in voice channel ${channelId}`
            );
        }

        logger.info(
            `${TAG} 🔗 Joining Discord voice channel ${channelId} in guild ${guildId}`
        );
        const connection = joinVoiceChannel({
            channelId,
            guildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            // Surfaces the library's networking + DAVE negotiation trace at debug level.
            debug: true,
        });
        connection.on('debug', (message) => {
            if (SAFE_DEBUG_LINE.test(message)) {
                logger.debug(`${TAG} 🐛 ${channelId}: ${message}`);
            }
        });

        try {
            await entersState(
                connection,
                VoiceConnectionStatus.Ready,
                JOIN_TIMEOUT_MS
            );
        } catch (err) {
            // Rethrown as-is: tsconfig's lib predates `new Error(msg, { cause })`.
            connection.destroy();
            logger.warn(
                `${TAG} ⚠️ Failed to become Ready in voice channel ${channelId} within ${JOIN_TIMEOUT_MS} ms`
            );
            throw err;
        }

        return new DiscordVoiceSession(this, connection, guild, channelId);
    }

    private toParticipant(state: VoiceState): VoiceParticipant {
        return {
            userId: state.id,
            isBot:
                state.id === this.botUserId() ||
                (state.member?.user.bot ?? false),
            selfMute: state.selfMute ?? false,
            selfDeaf: state.selfDeaf ?? false,
        };
    }
}

/**
 * Object-mode queue of Opus frames that an {@link AudioResource} pulls from,
 * one per 20 ms audio-cycle tick.
 *
 * A plain `PassThrough` is unsuitable here for two reasons verified against
 * @discordjs/voice 0.19: its readable side saturates at the 16-object
 * high-water mark (the rest piles up invisibly on the writable side, so a
 * `readableLength` backlog check never trips), and the player destroys the
 * resource's stream whenever it goes Idle, which would silently swallow
 * every later write. `push()` buffers past the high-water mark, so
 * `readableLength` is the true backlog, and the session creates a fresh
 * queue for every resource.
 */
class OpusFrameQueue extends Readable {
    /** Frames the player has actually pulled out of this queue. */
    framesOut = 0;

    constructor(private readonly onFirstFrameOut: () => void) {
        super({ objectMode: true, highWaterMark: MAX_SEND_BACKLOG_FRAMES });
    }

    /** Frames arrive via {@link enqueue}; there is nothing to pull on demand. */
    _read(): void {
        // no-op
    }

    /** Queue a frame for the player. Returns false once the queue is closed. */
    enqueue(packet: OpusPacket): boolean {
        if (this.destroyed || this.readableEnded) return false;
        this.push(packet);
        return true;
    }

    /** Drop the oldest queued frame without counting it as played. */
    discardOldest(): boolean {
        return super.read() !== null;
    }

    override read(size?: number): OpusPacket | null {
        const packet = super.read(size) as OpusPacket | null;
        if (packet) {
            this.framesOut++;
            if (this.framesOut === 1) this.onFirstFrameOut();
        }
        return packet;
    }
}

export interface DiscordVoiceSessionStats {
    /** Opus frames accepted by {@link DiscordVoiceSession.sendOpus} and queued. */
    framesIn: number;
    /** Frames the audio player actually pulled from the queue for dispatch. */
    packetsOut: number;
    /** Human participants currently in the channel. */
    participants: number;
}

export class DiscordVoiceSession extends EventEmitter implements VoiceSession {
    readonly platform = 'discord' as const;
    readonly guildId: string;

    private readonly player: AudioPlayer;
    private outbound!: OpusFrameQueue;
    private readonly subscriptions = new Map<string, AudioReceiveStream>();
    private closed = false;
    private framesIn = 0;
    private droppedFrames = 0;
    /** `framesOut` of queues already replaced after an Idle restart. */
    private framesOutRetired = 0;
    private lastBacklogTrimAt = 0;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly onParticipantUpdate = (
        update: VoiceParticipantUpdate
    ): void => {
        if (update.guildId !== this.guildId) return;
        const inChannel = update.channelId === this.channelId;
        const wasInChannel = update.previousChannelId === this.channelId;
        if (!inChannel && !wasInChannel) return;

        if (update.userId === this.transport.botUserId()) {
            // We were moved, kicked or (un)muted; @discordjs/voice emits
            // Disconnected if the connection is affected. Just report mutes.
            this.logBotVoiceState('voice state changed');
            return;
        }
        if (!inChannel) this.unsubscribe(update.userId);
        this.emit('participantUpdate', update);
    };

    constructor(
        private readonly transport: DiscordVoiceTransport,
        private readonly connection: VoiceConnection,
        private readonly guild: Guild,
        readonly channelId: string
    ) {
        super();
        this.guildId = guild.id;

        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                maxMissedFrames: PLAYER_MAX_MISSED_FRAMES,
            },
        });
        this.player.on('error', (err) => {
            logger.warn(
                `${TAG} ⚠️ Audio player error in ${this.channelId}: ${err.message}`
            );
            this.emit('error', err);
        });
        this.player.on('stateChange', (oldState, newState) => {
            if (oldState.status === newState.status) return;
            logger.info(
                `${TAG} 🔊 Player ${oldState.status} → ${newState.status} in ${this.channelId}`
            );
        });
        this.player.on(AudioPlayerStatus.Idle, () => this.restartPlayback());

        const subscription = connection.subscribe(this.player);
        if (!subscription) {
            logger.warn(
                `${TAG} ⚠️ Could not subscribe the audio player to the connection in ${this.channelId} (connection ${connection.state.status})`
            );
        }
        this.startPlayback();
        this.logBotVoiceState('joined');

        // Inbound: subscribe to each non-bot user as soon as they speak.
        connection.receiver.speaking.on('start', (userId) =>
            this.subscribe(userId)
        );
        for (const userId of connection.receiver.speaking.users.keys()) {
            this.subscribe(userId);
        }

        connection.on('error', (err) => {
            logger.warn(
                `${TAG} ⚠️ Connection error in ${this.channelId}: ${err.message}`
            );
            this.emit('error', err);
        });
        connection.on('stateChange', (oldState, newState) => {
            if (oldState.status === newState.status) return;
            logger.info(
                `${TAG} 🔗 Connection ${oldState.status} → ${newState.status} in ${this.channelId}`
            );
        });
        connection.on('transitioned', (transitionId) => {
            logger.info(
                `${TAG} 🔐 DAVE E2EE transition ${transitionId} applied in ${this.channelId}; ${this.describeDave()}`
            );
        });
        connection.on(
            VoiceConnectionStatus.Disconnected,
            () => void this.handleDisconnected()
        );
        connection.on(VoiceConnectionStatus.Destroyed, () =>
            this.close('destroyed')
        );

        transport.on('participantUpdate', this.onParticipantUpdate);
        logger.info(
            `${TAG} 🔊 Playback pipeline armed in ${this.channelId}: player ${this.player.state.status}, ${this.describeDave()}`
        );
    }

    participants(): VoiceParticipant[] {
        return this.transport.listParticipants(this.guildId, this.channelId);
    }

    stats(): DiscordVoiceSessionStats {
        return {
            framesIn: this.framesIn,
            packetsOut: this.framesOutRetired + this.outbound.framesOut,
            participants: this.participants().length,
        };
    }

    sendOpus(packet: OpusPacket): void {
        if (this.closed) return;
        if (this.outbound.readableLength >= MAX_SEND_BACKLOG_FRAMES) {
            this.trimBacklog();
        }
        if (!this.outbound.enqueue(packet)) {
            // Only between the player destroying an Idle queue and the restart.
            this.droppedFrames++;
            if (this.droppedFrames % 100 === 1) {
                logger.warn(
                    `${TAG} ⚠️ Outbound queue closed in ${this.channelId}; dropped ${this.droppedFrames} frame(s) so far`
                );
            }
            return;
        }
        this.framesIn++;
    }

    async leave(): Promise<void> {
        this.close('left');
    }

    /**
     * Discard queued frames down to the trim target. Both 20 ms clocks are
     * wall-clock locked, so a full backlog means the player stalled (e.g. an
     * event-loop hiccup); skipping is better than a permanent 1 s delay.
     */
    private trimBacklog(): void {
        let discarded = 0;
        while (
            this.outbound.readableLength > BACKLOG_TRIM_TARGET_FRAMES &&
            this.outbound.discardOldest()
        ) {
            discarded++;
        }
        this.droppedFrames += discarded;
        const now = Date.now();
        if (now - this.lastBacklogTrimAt > 10_000) {
            logger.warn(
                `${TAG} ⚠️ Outbound backlog hit ${MAX_SEND_BACKLOG_FRAMES} frames in ${this.channelId} (player ${this.player.state.status}); skipped ${discarded} frame(s), ${this.droppedFrames} total`
            );
        }
        this.lastBacklogTrimAt = now;
    }

    /** Create a fresh frame queue + resource and hand it to the player. */
    private startPlayback(): void {
        this.outbound = new OpusFrameQueue(() => this.onFirstFrameOut());
        const resource = createAudioResource(this.outbound, {
            inputType: StreamType.Opus,
        });
        this.player.play(resource);
    }

    /**
     * The player drops to Idle after PLAYER_MAX_MISSED_FRAMES without input
     * (the mixer normally never lets that happen) and destroys the resource's
     * stream as it does so, so playback resumes on a brand-new queue.
     */
    private restartPlayback(): void {
        if (this.closed) return;
        this.framesOutRetired += this.outbound.framesOut;
        logger.info(
            `${TAG} 🔊 Player went idle in ${this.channelId} (no frames for ${(PLAYER_MAX_MISSED_FRAMES * 20) / 1000} s); restarting playback on a fresh queue`
        );
        try {
            this.startPlayback();
        } catch (err) {
            this.emit(
                'error',
                err instanceof Error ? err : new Error(String(err))
            );
        }
    }

    private onFirstFrameOut(): void {
        if (this.closed) return;
        const which =
            this.framesOutRetired === 0
                ? 'First Opus frame'
                : 'First Opus frame after idle restart';
        logger.info(
            `${TAG} 🔊 ${which} handed to the Discord player in ${this.channelId} (dispatched on the next 20 ms tick); player ${this.player.state.status}, ${this.describeDave()}`
        );
        if (this.heartbeatTimer) return; // only after the very first frame
        this.scheduleTimer(DAVE_READY_WARN_MS, () => {
            if (this.daveNegotiatedButNotReady()) {
                logger.warn(
                    `${TAG} ⚠️ DAVE E2EE still not ready in ${this.channelId} after ${DAVE_READY_WARN_MS / 1000} s; audio goes out without E2EE and Discord clients will discard it`
                );
            }
        });
        this.heartbeatTimer = setTimeout(() => {
            this.logPlaybackStats('info');
            this.heartbeatTimer = setInterval(
                () => this.logPlaybackStats('debug'),
                HEARTBEAT_MS
            );
        }, FIRST_HEARTBEAT_MS);
    }

    private logPlaybackStats(level: 'info' | 'debug'): void {
        if (this.closed) return;
        const stats = this.stats();
        logger[level](
            `${TAG} 🔊 Playback in ${this.channelId}: framesIn=${stats.framesIn}, packetsOut=${stats.packetsOut}, udpPacketsSent=${this.udpPacketsSent() ?? 'n/a'}, dropped=${this.droppedFrames}, backlog=${this.outbound.readableLength}, player ${this.player.state.status}, ${this.describeDave()}, participants=${stats.participants}`
        );
    }

    /** The bot's own voice state; server mutes and stage suppression silence us. */
    private logBotVoiceState(context: string): void {
        const voice = this.guild.members.me?.voice;
        if (!voice) {
            logger.info(
                `${TAG} 🔗 Bot voice state unknown in ${this.channelId} (${context})`
            );
            return;
        }
        const summary = `channel=${voice.channelId ?? 'none'} selfMute=${voice.selfMute ?? false} selfDeaf=${voice.selfDeaf ?? false} serverMute=${voice.serverMute ?? false} suppress=${voice.suppress ?? false}`;
        if (voice.serverMute) {
            logger.warn(
                `${TAG} ⚠️ Bot is server-muted in ${this.channelId} (${context}); Discord users will not hear the bridge until unmuted. ${summary}`
            );
        } else if (voice.suppress) {
            logger.warn(
                `${TAG} ⚠️ Bot is suppressed in ${this.channelId} (${context}); it must be made a speaker before Discord users can hear it. ${summary}`
            );
        } else {
            logger.info(
                `${TAG} 🔗 Bot voice state in ${this.channelId} (${context}): ${summary}`
            );
        }
    }

    private describeDave(): string {
        const state = this.connection.state;
        if (state.status !== VoiceConnectionStatus.Ready) {
            return `connection ${state.status}`;
        }
        const net = state.networking.state;
        if (net.code !== NetworkingStatusCode.Ready) {
            return `networking not ready (code ${net.code})`;
        }
        const dave = net.dave;
        if (!dave || dave.protocolVersion === 0) {
            return 'DAVE off (protocol v0, transport encryption only)';
        }
        return dave.session?.ready
            ? `DAVE v${dave.protocolVersion} ready`
            : `DAVE v${dave.protocolVersion} negotiated but session NOT ready`;
    }

    private daveNegotiatedButNotReady(): boolean {
        const state = this.connection.state;
        if (state.status !== VoiceConnectionStatus.Ready) return false;
        const net = state.networking.state;
        if (net.code !== NetworkingStatusCode.Ready) return false;
        const dave = net.dave;
        return !!dave && dave.protocolVersion > 0 && !dave.session?.ready;
    }

    /** RTP packets the networking layer has actually written to the UDP socket. */
    private udpPacketsSent(): number | undefined {
        const state = this.connection.state;
        if (state.status !== VoiceConnectionStatus.Ready) return undefined;
        const net = state.networking.state;
        if (net.code !== NetworkingStatusCode.Ready) return undefined;
        return net.connectionData.packetsPlayed;
    }

    private scheduleTimer(delay: number, fn: () => void): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            fn();
        }, delay);
        this.timers.add(timer);
    }

    private subscribe(userId: string): void {
        if (this.closed || this.subscriptions.has(userId)) return;
        if (userId === this.transport.botUserId()) return;
        const member = this.guild.members.cache.get(userId);
        if (member?.user.bot) return;
        const state = this.guild.voiceStates.cache.get(userId);
        if (state && state.channelId !== this.channelId) return;

        logger.debug(`${TAG} 🎧 Listening to ${userId} in ${this.channelId}`);
        const stream = this.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.Manual },
        });
        stream.on('data', (packet: Buffer) =>
            this.emit('audio', userId, packet)
        );
        stream.on('error', (err) => {
            logger.debug(
                `${TAG} 🎧 Receive stream error for ${userId}: ${err.message}`
            );
            this.subscriptions.delete(userId);
        });
        stream.on('close', () => this.subscriptions.delete(userId));
        this.subscriptions.set(userId, stream);
    }

    private unsubscribe(userId: string): void {
        const stream = this.subscriptions.get(userId);
        if (!stream) return;
        this.subscriptions.delete(userId);
        stream.destroy();
    }

    /**
     * Reconnect dance from the @discordjs/voice guide: a Disconnected state
     * followed quickly by Signalling/Connecting means Discord is moving us
     * (region change, channel move) and the library recovers on its own.
     * Otherwise treat it as a real disconnect and tear down.
     */
    private async handleDisconnected(): Promise<void> {
        if (this.closed) return;
        try {
            await Promise.race([
                entersState(
                    this.connection,
                    VoiceConnectionStatus.Signalling,
                    RECONNECT_GRACE_MS
                ),
                entersState(
                    this.connection,
                    VoiceConnectionStatus.Connecting,
                    RECONNECT_GRACE_MS
                ),
            ]);
            logger.info(
                `${TAG} 🔗 Connection in ${this.channelId} is reconnecting`
            );
        } catch {
            this.close('disconnected');
        }
    }

    private close(reason: string): void {
        if (this.closed) return;
        const stats = this.stats();
        const udp = this.udpPacketsSent();
        // Set first: destroy() emits Destroyed synchronously, which re-enters here.
        this.closed = true;
        this.teardown();
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
        }
        this.finish(reason, stats, udp);
    }

    private teardown(): void {
        this.transport.off('participantUpdate', this.onParticipantUpdate);
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const userId of [...this.subscriptions.keys()]) {
            this.unsubscribe(userId);
        }
        this.player.removeAllListeners(AudioPlayerStatus.Idle);
        this.player.stop(true);
        this.outbound.destroy();
    }

    private finish(
        reason: string,
        stats: DiscordVoiceSessionStats,
        udpPacketsSent: number | undefined
    ): void {
        logger.info(
            `${TAG} 👋 Left Discord voice channel ${this.channelId} (${reason}); framesIn=${stats.framesIn}, packetsOut=${stats.packetsOut}, udpPacketsSent=${udpPacketsSent ?? 'n/a'}, dropped=${this.droppedFrames}`
        );
        this.emit('closed', reason);
    }
}
