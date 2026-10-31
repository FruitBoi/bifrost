import logger from '../../utils/logging/logger';
import type VoiceBridgeService from '../voice/VoiceBridgeService';
import type { VoiceBridgeInjection } from '../voice/VoiceBridgeService';
import type {
    OpusPacket,
    VoiceParticipantUpdate,
    VoicePlatform,
    VoiceSession,
    VoiceTransport,
} from '../voice/VoiceTransport';
import {
    EnqueueRequest,
    EnqueueResult,
    MusicController,
    MusicError,
    MusicQueueView,
    PlaybackEndReason,
    PlaybackHandle,
    QueuedTrack,
    TrackPlayer,
    TrackResolver,
} from './types';

export interface MusicServiceOptions {
    /**
     * Getters, because the Fluxer transport (and with it the bridge) is
     * re-created when its client restarts while this service lives on.
     */
    transports: {
        discord: () => VoiceTransport | null;
        fluxer: () => VoiceTransport | null;
    };
    bridge: () => VoiceBridgeService | null;
    resolver: TrackResolver;
    player: TrackPlayer;
    /** Most tracks that may wait in a guild's queue (excluding the playing one). */
    maxQueueLength?: number;
    /** How long the bot stays in voice with nothing left to play. */
    idleLeaveMs?: number;
    /** How long the bot stays in voice once no humans are left in the channel. */
    aloneLeaveMs?: number;
    /** How often each guild's player re-checks the bridge and the channel. */
    monitorIntervalMs?: number;
    /** How long playback may wait for the voice bridge before giving up. */
    bridgeWaitMs?: number;
}

const DEFAULT_MAX_QUEUE_LENGTH = 50;
const DEFAULT_IDLE_LEAVE_MS = 120_000;
const DEFAULT_ALONE_LEAVE_MS = 30_000;
const DEFAULT_MONITOR_INTERVAL_MS = 1_000;
/** Covers the bridge's whole default retry backoff (2 + 5 + 15 + 60 s). */
const DEFAULT_BRIDGE_WAIT_MS = 90_000;

const TAG = '[Music]';

/**
 * Where a guild's audio goes:
 * - `none`: nowhere yet (just created, or between outputs);
 * - `joining`: our own join is in flight;
 * - `session`: our own voice session in the channel;
 * - `bridge`: injected into the live voice bridge sitting in the channel, so
 *   both platforms hear it;
 * - `waiting`: the bridge is joining/rejoining this very channel; playback
 *   is held until it goes live (or gives up, and we join ourselves).
 */
type Output =
    | { kind: 'none' }
    | { kind: 'joining' }
    | { kind: 'session'; session: VoiceSession; detach: () => void }
    | { kind: 'bridge'; injection: VoiceBridgeInjection }
    | { kind: 'waiting'; since: number };

/** Music state of one guild on one platform. */
interface GuildMusic {
    key: string;
    platform: VoicePlatform;
    guildId: string;
    /** Voice channel the music plays in; fixed for the state's lifetime. */
    channelId: string;
    /** Playing track, or the first track while the output is being set up. */
    current: QueuedTrack | null;
    handle: PlaybackHandle | null;
    upcoming: QueuedTrack[];
    /** Paused by a user (as opposed to held while waiting for an output). */
    paused: boolean;
    /** Posts in the text channel of the latest `enqueue`. */
    announce: (text: string) => void;
    output: Output;
    /** Our own join while it is in flight, so yieldToBridge can wait for it. */
    joining: Promise<void> | null;
    idleTimer: NodeJS.Timeout | null;
    aloneTimer: NodeJS.Timeout | null;
    monitorTimer: NodeJS.Timeout | null;
}

const mention = (channelId: string) => `<#${channelId}>`;

/**
 * Per-guild music queues played into voice on Discord and Fluxer.
 *
 * Each (platform, guild) has at most one queue, bound to the voice channel
 * of whoever started it. Audio goes either into the voice bridge, when a
 * live bridge sits in that channel (so both platforms hear it), or into our
 * own voice session. The bridge always has priority: it calls
 * {@link yieldToBridge} before joining, and the music hands its channel
 * over (same channel: continue through the bridge once it is live; another
 * channel: stop). If the bridge goes away mid-song, the music rejoins with
 * its own session.
 *
 * Gaps in the frame stream (pause, between tracks, waiting for the bridge)
 * need no keep-alive: the player sends a few silence frames on pause/end,
 * the Discord session restarts its audio player on a fresh queue after it
 * idles, and the Fluxer session simply publishes nothing.
 */
export default class MusicService implements MusicController {
    private readonly transports: MusicServiceOptions['transports'];
    private readonly bridge: () => VoiceBridgeService | null;
    private readonly resolver: TrackResolver;
    private readonly player: TrackPlayer;
    private readonly maxQueueLength: number;
    private readonly idleLeaveMs: number;
    private readonly aloneLeaveMs: number;
    private readonly monitorIntervalMs: number;
    private readonly bridgeWaitMs: number;

    /** Keyed by {@link key}. */
    private readonly states = new Map<string, GuildMusic>();

    constructor(options: MusicServiceOptions) {
        this.transports = options.transports;
        this.bridge = options.bridge;
        this.resolver = options.resolver;
        this.player = options.player;
        this.maxQueueLength =
            options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
        this.idleLeaveMs = options.idleLeaveMs ?? DEFAULT_IDLE_LEAVE_MS;
        this.aloneLeaveMs = options.aloneLeaveMs ?? DEFAULT_ALONE_LEAVE_MS;
        this.monitorIntervalMs =
            options.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
        this.bridgeWaitMs = options.bridgeWaitMs ?? DEFAULT_BRIDGE_WAIT_MS;
    }

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------

    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
        const { platform, guildId, userId } = request;
        const channelId = this.requesterChannel(platform, guildId, userId);
        this.checkCanPlayIn(platform, guildId, channelId);

        const track: QueuedTrack = {
            ...(await this.resolver.resolve(request.query)),
            requestedBy: request.requesterName,
        };

        // Re-checked: another enqueue or the bridge may have moved while
        // the resolver ran.
        this.checkCanPlayIn(platform, guildId, channelId);

        const existing = this.states.get(this.key(platform, guildId));
        if (existing) {
            existing.announce = request.announce;
            this.clearIdleTimer(existing);
            if (existing.current) {
                existing.upcoming.push(track);
                return { track, position: existing.upcoming.length };
            }
            this.startTrack(existing, track, false);
            return { track, position: 0 };
        }

        const state = this.createState(
            platform,
            guildId,
            channelId,
            request.announce
        );
        state.current = track;
        try {
            await this.connect(state);
        } catch (err) {
            await this.end(state);
            throw err;
        }
        if (this.states.get(state.key) !== state) {
            throw new MusicError('The music was stopped before it started.');
        }
        // Unless someone skipped it while we were joining.
        if (state.current === track && !state.handle) {
            this.startTrack(state, track, false);
        }
        return { track, position: 0 };
    }

    skip(
        platform: VoicePlatform,
        guildId: string,
        userId: string
    ): QueuedTrack {
        const state = this.requireControl(platform, guildId, userId);
        const track = state.current;
        if (!track) throw new MusicError('Nothing is playing right now.');
        const handle = state.handle;
        if (handle) {
            // Its `end` advances the queue.
            handle.stop();
        } else {
            this.advance(state);
        }
        return track;
    }

    stop(platform: VoicePlatform, guildId: string, userId: string): void {
        const state = this.requireControl(platform, guildId, userId, false);
        void this.end(state);
    }

    pause(platform: VoicePlatform, guildId: string, userId: string): void {
        const state = this.requireControl(platform, guildId, userId);
        if (state.paused) throw new MusicError('The music is already paused.');
        state.paused = true;
        this.applyHold(state);
    }

    resume(platform: VoicePlatform, guildId: string, userId: string): void {
        const state = this.requireControl(platform, guildId, userId);
        if (!state.paused) throw new MusicError('The music is not paused.');
        state.paused = false;
        this.applyHold(state);
    }

    queue(platform: VoicePlatform, guildId: string): MusicQueueView | null {
        const state = this.states.get(this.key(platform, guildId));
        if (!state || (!state.current && state.upcoming.length === 0)) {
            return null;
        }
        let elapsedMs = 0;
        try {
            elapsedMs = state.handle?.elapsedMs() ?? 0;
        } catch (err) {
            logger.debug(`${TAG} elapsedMs() threw: ${String(err)}`);
        }
        return {
            channelId: state.channelId,
            nowPlaying: state.current
                ? {
                      ...state.current,
                      elapsedSec: Math.floor(elapsedMs / 1000),
                  }
                : null,
            upcoming: [...state.upcoming],
            paused: state.paused,
        };
    }

    // ---------------------------------------------------------------------
    // Lifecycle and bridge coordination
    // ---------------------------------------------------------------------

    /** Stops every queue and leaves voice everywhere (shutdown, restarts). */
    async stopAll(): Promise<void> {
        await Promise.all([...this.states.values()].map((s) => this.end(s)));
    }

    /**
     * Called by the voice bridge right before it joins `channelId`. Releases
     * any session the music holds in that guild on that platform: in the
     * same channel playback is held until the bridge is live and then
     * continues through it; in another channel the music stops. Never throws.
     */
    async yieldToBridge(
        platform: VoicePlatform,
        guildId: string,
        channelId: string
    ): Promise<void> {
        try {
            const state = this.states.get(this.key(platform, guildId));
            if (!state) return;
            if (state.joining) await state.joining.catch(() => undefined);
            if (this.states.get(state.key) !== state) return;
            const output = state.output;
            if (output.kind !== 'session') return;

            if (state.channelId !== channelId) {
                logger.info(
                    `${TAG} ⏹️ Stopping ${this.describe(state)}: the voice bridge needs ${platform} channel ${channelId}`
                );
                this.say(
                    state,
                    `⏹️ Stopped the music: the voice bridge needs me in ${mention(channelId)}.`
                );
                await this.end(state);
                return;
            }

            logger.info(
                `${TAG} 🔗 Handing ${this.describe(state)} over to the voice bridge`
            );
            output.detach();
            this.setOutput(state, { kind: 'waiting', since: Date.now() });
            await this.safeLeave(output.session);
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to yield to the voice bridge`, err);
        }
    }

    // ---------------------------------------------------------------------
    // Checks
    // ---------------------------------------------------------------------

    private key(platform: VoicePlatform, guildId: string): string {
        return `${platform}:${guildId}`;
    }

    private describe(state: GuildMusic): string {
        return `music in ${state.platform} guild ${state.guildId} (channel ${state.channelId})`;
    }

    private transport(platform: VoicePlatform): VoiceTransport | null {
        return this.transports[platform]();
    }

    private requireTransport(platform: VoicePlatform): VoiceTransport {
        const transport = this.transport(platform);
        if (!transport) {
            throw new MusicError(
                'Voice is not available right now. Try again in a moment.'
            );
        }
        return transport;
    }

    /** The requester's voice channel; MusicError when they are not in one. */
    private requesterChannel(
        platform: VoicePlatform,
        guildId: string,
        userId: string
    ): string {
        const channelId = this.requireTransport(platform).userVoiceChannel(
            guildId,
            userId
        );
        if (!channelId) {
            throw new MusicError('You need to be in a voice channel first.');
        }
        return channelId;
    }

    /** MusicError when music cannot play in `channelId` right now. */
    private checkCanPlayIn(
        platform: VoicePlatform,
        guildId: string,
        channelId: string
    ) {
        const state = this.states.get(this.key(platform, guildId));
        if (state) {
            if (state.channelId !== channelId) {
                throw new MusicError(
                    `I'm already playing music in ${mention(state.channelId)}. Join that channel to add songs.`
                );
            }
            if (state.upcoming.length >= this.maxQueueLength) {
                throw new MusicError(
                    `The queue is full (${this.maxQueueLength} songs). Try again later.`
                );
            }
            return;
        }
        const busy = this.bridge()?.busyChannel(platform, guildId) ?? null;
        if (busy && busy !== channelId) {
            throw new MusicError(
                `I'm busy bridging voice in ${mention(busy)}.`
            );
        }
    }

    /**
     * The state of that guild, if `userId` may control it. With
     * `needsTrack`, something must be playing (or about to).
     */
    private requireControl(
        platform: VoicePlatform,
        guildId: string,
        userId: string,
        needsTrack = true
    ): GuildMusic {
        const state = this.states.get(this.key(platform, guildId));
        if (!state || (needsTrack && !state.current)) {
            throw new MusicError('Nothing is playing right now.');
        }
        const channelId = this.requireTransport(platform).userVoiceChannel(
            guildId,
            userId
        );
        if (channelId !== state.channelId) {
            throw new MusicError(
                `You need to be in ${mention(state.channelId)} to control the music.`
            );
        }
        return state;
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    private createState(
        platform: VoicePlatform,
        guildId: string,
        channelId: string,
        announce: (text: string) => void
    ): GuildMusic {
        const state: GuildMusic = {
            key: this.key(platform, guildId),
            platform,
            guildId,
            channelId,
            current: null,
            handle: null,
            upcoming: [],
            paused: false,
            announce,
            output: { kind: 'none' },
            joining: null,
            idleTimer: null,
            aloneTimer: null,
            monitorTimer: null,
        };
        this.states.set(state.key, state);
        state.monitorTimer = setInterval(
            () => this.monitor(state),
            this.monitorIntervalMs
        );
        logger.info(`${TAG} 🎵 Started ${this.describe(state)}`);
        return state;
    }

    /**
     * Stops playback, releases the output and forgets the state, then posts
     * `announcement` if given. Idempotent; never throws.
     */
    private async end(state: GuildMusic, announcement?: string) {
        if (this.states.get(state.key) !== state) return;
        this.states.delete(state.key);
        this.clearIdleTimer(state);
        this.clearAloneTimer(state);
        if (state.monitorTimer) {
            clearInterval(state.monitorTimer);
            state.monitorTimer = null;
        }

        const handle = state.handle;
        state.handle = null;
        state.current = null;
        state.upcoming = [];
        if (handle) {
            try {
                handle.stop();
            } catch (err) {
                logger.error(`${TAG} ❌ Failed to stop playback`, err);
            }
        }

        const output = state.output;
        state.output = { kind: 'none' };
        logger.info(`${TAG} 👋 Ended ${this.describe(state)}`);
        if (announcement) this.say(state, announcement);

        if (output.kind === 'session') {
            output.detach();
            await this.safeLeave(output.session);
        } else if (output.kind === 'bridge') {
            try {
                output.injection.detach();
            } catch (err) {
                logger.error(`${TAG} ❌ Failed to detach from the bridge`, err);
            }
        }
    }

    private say(state: GuildMusic, text: string) {
        try {
            state.announce(text);
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to announce`, err);
        }
    }

    private async safeLeave(session: VoiceSession) {
        try {
            await session.leave();
        } catch (err) {
            logger.error(
                `${TAG} ❌ Failed to leave ${session.platform} voice channel ${session.channelId}`,
                err
            );
        }
    }

    private clearIdleTimer(state: GuildMusic) {
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }
    }

    private clearAloneTimer(state: GuildMusic) {
        if (state.aloneTimer) {
            clearTimeout(state.aloneTimer);
            state.aloneTimer = null;
        }
    }

    // ---------------------------------------------------------------------
    // Playback
    // ---------------------------------------------------------------------

    private startTrack(
        state: GuildMusic,
        track: QueuedTrack,
        announce: boolean
    ) {
        this.clearIdleTimer(state);
        state.current = track;

        let handle: PlaybackHandle;
        try {
            handle = this.player.play(track, (packet) =>
                this.send(state, packet)
            );
        } catch (err) {
            this.onTrackEnd(state, null, 'error', toError(err));
            return;
        }
        state.handle = handle;
        handle.once('end', (reason, err) =>
            this.onTrackEnd(state, handle, reason, err)
        );
        this.applyHold(state);

        logger.info(
            `${TAG} ▶️ Playing "${track.title}" in ${this.describe(state)}`
        );
        if (announce) {
            this.say(
                state,
                `🎶 Now playing **${track.title}** (requested by ${track.requestedBy})`
            );
        }
    }

    private onTrackEnd(
        state: GuildMusic,
        handle: PlaybackHandle | null,
        reason: PlaybackEndReason,
        err?: Error
    ) {
        try {
            if (this.states.get(state.key) !== state) return;
            if (handle !== state.handle) return;
            const track = state.current;
            state.handle = null;
            if (reason === 'error' && track) {
                logger.warn(
                    `${TAG} ⚠️ Playback of "${track.title}" failed in ${this.describe(state)}: ${err?.message ?? 'unknown error'}`
                );
                const detail =
                    err instanceof MusicError ? `: ${err.message}` : '';
                this.say(
                    state,
                    `⚠️ Couldn't play **${track.title}**${detail}. Skipping it.`
                );
            }
            this.advance(state);
        } catch (e) {
            logger.error(`${TAG} ❌ Failed to advance the queue`, e);
        }
    }

    /** Plays the next queued track, or arms the idle timer. */
    private advance(state: GuildMusic) {
        state.current = null;
        const next = state.upcoming.shift();
        if (next) {
            this.startTrack(state, next, true);
            return;
        }
        if (state.idleTimer) return;
        state.idleTimer = setTimeout(() => {
            state.idleTimer = null;
            void this.end(
                state,
                '👋 Nothing left to play, so I left the voice channel.'
            );
        }, this.idleLeaveMs);
    }

    private send(state: GuildMusic, packet: OpusPacket) {
        const output = state.output;
        try {
            if (output.kind === 'session') output.session.sendOpus(packet);
            else if (output.kind === 'bridge') output.injection.push(packet);
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to send audio`, err);
        }
    }

    /** Pauses the handle while a user paused it or there is no output. */
    private applyHold(state: GuildMusic) {
        const handle = state.handle;
        if (!handle) return;
        const ready =
            state.output.kind === 'session' || state.output.kind === 'bridge';
        const hold = state.paused || !ready;
        try {
            if (hold && !handle.paused) handle.pause();
            else if (!hold && handle.paused) handle.resume();
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to pause/resume playback`, err);
        }
    }

    private setOutput(state: GuildMusic, output: Output) {
        state.output = output;
        this.applyHold(state);
        this.checkAlone(state);
    }

    // ---------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------

    /**
     * Picks and sets up the output of a state whose output is `none`:
     * the live bridge in the channel, waiting for a bridge that is joining
     * the channel, or our own session. Rejects with a MusicError.
     */
    private async connect(state: GuildMusic): Promise<void> {
        const { platform, guildId, channelId } = state;
        const bridge = this.bridge();
        if (bridge) {
            if (bridge.liveBridgeFor(platform, guildId, channelId)) {
                const injection = bridge.injectSource(
                    platform,
                    guildId,
                    channelId,
                    (reason) => this.onInjectionLost(state, injection, reason)
                );
                if (injection) {
                    logger.info(
                        `${TAG} 🔗 Playing ${this.describe(state)} through the voice bridge`
                    );
                    this.setOutput(state, { kind: 'bridge', injection });
                    return;
                }
            }
            const busy = bridge.busyChannel(platform, guildId);
            if (busy && busy !== channelId) {
                throw new MusicError(
                    `I'm busy bridging voice in ${mention(busy)}.`
                );
            }
            if (busy === channelId) {
                this.setOutput(state, { kind: 'waiting', since: Date.now() });
                return;
            }
        }

        const transport = this.requireTransport(platform);
        this.setOutput(state, { kind: 'joining' });
        const joining = this.joinOwn(state, transport);
        state.joining = joining;
        try {
            await joining;
        } finally {
            if (state.joining === joining) state.joining = null;
        }
    }

    private async joinOwn(state: GuildMusic, transport: VoiceTransport) {
        let session: VoiceSession;
        try {
            session = await transport.join(state.guildId, state.channelId);
        } catch (err) {
            logger.warn(
                `${TAG} ⚠️ Failed to join ${state.platform} voice channel ${state.channelId}: ${toError(err).message}`
            );
            if (state.output.kind === 'joining') {
                state.output = { kind: 'none' };
            }
            throw new MusicError(
                `I couldn't join ${mention(state.channelId)}. Check that I'm allowed to connect and speak there.`
            );
        }
        if (this.states.get(state.key) !== state) {
            await this.safeLeave(session);
            return;
        }

        const onParticipant = (update: VoiceParticipantUpdate) => {
            if (update.channelId === state.channelId)
                this.clearAloneTimer(state);
            this.checkAlone(state);
        };
        const onClosed = (reason: string) =>
            void this.onSessionClosed(state, session, reason);
        const onError = (err: Error) =>
            logger.error(
                `${TAG} ❌ Voice session error in ${this.describe(state)}`,
                err
            );
        session.on('participantUpdate', onParticipant);
        session.on('closed', onClosed);
        session.on('error', onError);
        const detach = () => {
            session.off('participantUpdate', onParticipant);
            session.off('closed', onClosed);
            session.off('error', onError);
        };
        logger.info(`${TAG} 🔊 Joined voice for ${this.describe(state)}`);
        this.setOutput(state, { kind: 'session', session, detach });
    }

    private async onSessionClosed(
        state: GuildMusic,
        session: VoiceSession,
        reason: string
    ) {
        try {
            const output = state.output;
            if (output.kind !== 'session' || output.session !== session) return;
            logger.warn(
                `${TAG} ⚠️ Voice session closed for ${this.describe(state)}: ${reason}`
            );
            output.detach();
            state.output = { kind: 'none' };
            await this.end(
                state,
                '⚠️ I got disconnected from voice, so the music stopped.'
            );
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to handle a closed session`, err);
        }
    }

    private onInjectionLost(
        state: GuildMusic,
        injection: VoiceBridgeInjection | null,
        reason: string
    ) {
        try {
            const output = state.output;
            if (output.kind !== 'bridge' || output.injection !== injection) {
                return;
            }
            if (this.states.get(state.key) !== state) return;
            logger.info(
                `${TAG} 🔌 Voice bridge went away under ${this.describe(state)} (${reason}); rejoining on our own`
            );
            this.setOutput(state, { kind: 'none' });
            void this.reconnect(state);
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to handle a lost bridge`, err);
        }
    }

    /** {@link connect} for a running state; stops it with an announcement on failure. */
    private async reconnect(state: GuildMusic) {
        try {
            await this.connect(state);
        } catch (err) {
            if (!(err instanceof MusicError)) {
                logger.error(`${TAG} ❌ Failed to reconnect`, err);
            }
            const why = err instanceof MusicError ? ` ${err.message}` : '';
            await this.end(state, `⏹️ The music stopped.${why}`);
        }
    }

    // ---------------------------------------------------------------------
    // Monitoring
    // ---------------------------------------------------------------------

    /** Periodic: moves a waiting state on and checks who is listening. */
    private monitor(state: GuildMusic) {
        try {
            if (this.states.get(state.key) !== state) return;
            if (state.output.kind === 'waiting')
                this.checkWaiting(state, state.output.since);
            this.checkAlone(state);
        } catch (err) {
            logger.error(`${TAG} ❌ Monitor failed`, err);
        }
    }

    private checkWaiting(state: GuildMusic, since: number) {
        const bridge = this.bridge();
        const live =
            bridge?.liveBridgeFor(
                state.platform,
                state.guildId,
                state.channelId
            ) ?? null;
        const busy = bridge?.busyChannel(state.platform, state.guildId) ?? null;
        if (!live && busy === state.channelId) {
            if (Date.now() - since < this.bridgeWaitMs) return;
            logger.warn(
                `${TAG} ⚠️ Gave up waiting for the voice bridge for ${this.describe(state)}`
            );
            void this.end(
                state,
                '⏹️ The music stopped: the voice bridge never came back.'
            );
            return;
        }
        this.setOutput(state, { kind: 'none' });
        void this.reconnect(state);
    }

    /** Arms or cancels the "nobody is listening" timer. */
    private checkAlone(state: GuildMusic) {
        if (this.states.get(state.key) !== state) return;
        const humans = this.humansIn(state);
        if (humans === null) return;
        if (humans > 0) {
            this.clearAloneTimer(state);
            return;
        }
        if (state.aloneTimer) return;
        state.aloneTimer = setTimeout(() => {
            state.aloneTimer = null;
            try {
                if (this.humansIn(state) === 0) {
                    void this.end(
                        state,
                        '👋 Everyone left the voice channel, so I stopped the music.'
                    );
                }
            } catch (err) {
                logger.error(`${TAG} ❌ Alone check failed`, err);
            }
        }, this.aloneLeaveMs);
    }

    /** Humans in the music's channel, or null when it cannot be told. */
    private humansIn(state: GuildMusic): number | null {
        const transport = this.transport(state.platform);
        if (!transport) return null;
        const botIds = new Set(
            [
                this.transports.discord()?.botUserId(),
                this.transports.fluxer()?.botUserId(),
            ].filter((id): id is string => !!id)
        );
        try {
            return transport
                .listParticipants(state.guildId, state.channelId)
                .filter((p) => !p.isBot && !botIds.has(p.userId)).length;
        } catch (err) {
            logger.error(`${TAG} ❌ Failed to list participants`, err);
            return null;
        }
    }
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
