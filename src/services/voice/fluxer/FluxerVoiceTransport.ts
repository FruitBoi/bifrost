import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
    type Client,
    type ClientEvents,
    Events,
    VoiceChannel,
} from '@fluxerjs/core';
import {
    getVoiceManager,
    type LiveKitAudioFrame,
    type LiveKitReceiveSubscription,
    LiveKitRtcConnection,
    type VoiceConnectionLike,
    type VoiceManager,
} from '@fluxerjs/voice';
import {
    AudioFrame,
    AudioSource,
    LocalAudioTrack,
    type Room,
    TrackPublishOptions,
    TrackSource,
} from '@livekit/rtc-node';
import { OpusEncoder } from '@discordjs/opus';
import logger from '../../../utils/logging/logger';
import { CHANNELS, SAMPLE_RATE, SAMPLES_PER_FRAME } from '../AudioMixer';
import type {
    OpusPacket,
    VoiceParticipant,
    VoiceParticipantUpdate,
    VoiceSession,
    VoiceTransport,
} from '../VoiceTransport';

/** Interleaved samples per 20 ms stereo frame. */
const FRAME_SAMPLES = SAMPLES_PER_FRAME * CHANNELS;
/** Drop outbound audio once LiveKit has this much queued (we fell behind). */
const MAX_QUEUED_PLAYOUT_MS = 400;
/** Cap on per-participant PCM waiting to fill a 20 ms frame (~200 ms). */
const MAX_PENDING_SAMPLES = FRAME_SAMPLES * 10;

// @fluxerjs/types is not a direct dependency; derive the payload types from core.
type VoiceStatesSyncData = ClientEvents[typeof Events.VoiceStatesSync][0];
type VoiceStateUpdateData = ClientEvents[typeof Events.VoiceStateUpdate][0];
type VoiceStateData = VoiceStatesSyncData['voiceStates'][number];

interface CachedVoiceState {
    channelId: string | null;
    selfMute: boolean;
    selfDeaf: boolean;
    isBot: boolean;
}

/**
 * {@link VoiceTransport} for @fluxerjs/core using @fluxerjs/voice.
 *
 * Construct this **before** `client.login()`: the constructor calls
 * `getVoiceManager(client)`, which registers the gateway listeners
 * (VoiceStateUpdate / VoiceServerUpdate / VoiceStateAck / VoiceStatesSync)
 * that the voice manager needs to track state from READY onwards.
 *
 * Audio path (LiveKit, which is what Fluxer currently routes voice through):
 * - Receive: `LiveKitRtcConnection` decodes remote tracks to 48 kHz mono
 *   10 ms PCM (`audioFrame` events). We upmix to stereo, re-chunk to 20 ms
 *   and encode with @discordjs/opus so the session emits Opus packets.
 * - Send: `LiveKitRtcConnection.playOpus` is not implemented upstream and
 *   `play()` only accepts WebM/Opus, so we publish our own LiveKit audio
 *   track (`AudioSource` 48 kHz stereo) on the connection's room and decode
 *   incoming Opus frames into it.
 * - The legacy UDP `VoiceConnection` supports `playOpus` natively but has no
 *   receive API; it is handled send-only.
 */
export default class FluxerVoiceTransport
    extends EventEmitter
    implements VoiceTransport
{
    readonly platform = 'fluxer' as const;
    readonly voiceManager: VoiceManager;

    /** guildId -> userId -> state; the voice manager only caches channel ids. */
    private readonly states = new Map<string, Map<string, CachedVoiceState>>();

    constructor(private readonly client: Client) {
        super();
        this.voiceManager = getVoiceManager(client);

        client.on(Events.VoiceStatesSync, (data: VoiceStatesSyncData) => {
            for (const vs of data.voiceStates) {
                this.applyVoiceState(data.guildId, vs);
            }
        });
        client.on(Events.VoiceStateUpdate, (data: VoiceStateUpdateData) => {
            const guildId = data.guild_id ?? data.member?.guild_id;
            if (!guildId) return;
            this.applyVoiceState(guildId, data);
        });
    }

    botUserId(): string | null {
        return this.client.user?.id ?? null;
    }

    listParticipants(guildId: string, channelId: string): VoiceParticipant[] {
        const botId = this.botUserId();
        const guildStates = this.states.get(guildId);
        const result: VoiceParticipant[] = [];
        const seen = new Set<string>();

        if (guildStates) {
            for (const [userId, state] of guildStates) {
                if (state.channelId !== channelId || userId === botId) continue;
                seen.add(userId);
                result.push({ userId, ...this.toParticipant(userId, state) });
            }
        }
        // Anything the voice manager knows that we somehow missed.
        for (const userId of this.voiceManager.listParticipantsInChannel(
            guildId,
            channelId
        )) {
            if (seen.has(userId) || userId === botId) continue;
            result.push({
                userId,
                isBot: this.isBotUser(userId, guildId),
                selfMute: false,
                selfDeaf: false,
            });
        }
        return result;
    }

    async join(guildId: string, channelId: string): Promise<VoiceSession> {
        const existing = this.voiceManager.getConnection(guildId);
        if (existing && existing.channel.id !== channelId) {
            throw new Error(
                `Already connected to voice channel ${existing.channel.id} in guild ${guildId}`
            );
        }

        const channel =
            this.client.channels.get(channelId) ??
            (await this.client.channels.fetch(channelId));
        if (!(channel instanceof VoiceChannel)) {
            throw new Error(`Channel ${channelId} is not a voice channel`);
        }
        if (channel.guildId !== guildId) {
            throw new Error(
                `Channel ${channelId} belongs to guild ${channel.guildId}, not ${guildId}`
            );
        }

        const connection = await this.voiceManager.join(channel);
        const session = new FluxerVoiceSession(
            this,
            this.voiceManager,
            connection,
            guildId,
            channelId
        );
        await session.init();
        return session;
    }

    /** Best effort from caches; voice state payloads carry no bot flag. */
    isBotUser(userId: string, guildId?: string): boolean {
        if (userId === this.botUserId()) return true;
        const user =
            this.client.users.get(userId) ??
            (guildId
                ? this.client.guilds.get(guildId)?.members.get(userId)?.user
                : undefined);
        return user?.bot ?? false;
    }

    private applyVoiceState(guildId: string, vs: VoiceStateData): void {
        let guildStates = this.states.get(guildId);
        if (!guildStates) {
            guildStates = new Map();
            this.states.set(guildId, guildStates);
        }
        const previous = guildStates.get(vs.user_id);
        const state: CachedVoiceState = {
            channelId: vs.channel_id,
            selfMute: vs.self_mute ?? false,
            selfDeaf: vs.self_deaf ?? false,
            isBot: previous?.isBot || this.isBotUser(vs.user_id, guildId),
        };
        if (state.channelId === null) guildStates.delete(vs.user_id);
        else guildStates.set(vs.user_id, state);

        const update: VoiceParticipantUpdate = {
            userId: vs.user_id,
            ...this.toParticipant(vs.user_id, state),
            guildId,
            channelId: state.channelId,
            previousChannelId: previous?.channelId ?? null,
        };
        this.emit('participantUpdate', update);
    }

    private toParticipant(
        userId: string,
        state: CachedVoiceState
    ): Omit<VoiceParticipant, 'userId'> {
        return {
            isBot: state.isBot || userId === this.botUserId(),
            selfMute: state.selfMute,
            selfDeaf: state.selfDeaf,
        };
    }
}

interface InboundParticipant {
    subscription: LiveKitReceiveSubscription | null;
    encoder: OpusEncoder | null;
    pending: Int16Array;
    warnedFormat: boolean;
}

export class FluxerVoiceSession extends EventEmitter implements VoiceSession {
    readonly platform = 'fluxer' as const;

    private readonly inbound = new Map<string, InboundParticipant>();
    private readonly outboundDecoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    private readonly outboundSamples = new Int16Array(FRAME_SAMPLES);
    private audioSource: AudioSource | null = null;
    private audioTrack: LocalAudioTrack | null = null;
    private udpOutbound: PassThrough | null = null;
    private closed = false;
    private sentFrames = 0;
    private droppedFrames = 0;

    private readonly onParticipantUpdate = (
        update: VoiceParticipantUpdate
    ): void => {
        if (update.guildId !== this.guildId) return;
        const inChannel = update.channelId === this.channelId;
        const wasInChannel = update.previousChannelId === this.channelId;
        if (!inChannel && !wasInChannel) return;

        if (update.userId === this.transport.botUserId()) {
            if (!inChannel) this.close('moved');
            return;
        }
        if (inChannel && !update.isBot) this.subscribe(update.userId);
        else if (!inChannel) this.unsubscribe(update.userId);
        this.emit('participantUpdate', update);
    };

    private readonly onAudioFrame = (frame: LiveKitAudioFrame): void => {
        this.handleAudioFrame(frame);
    };

    private readonly onConnectionError = (err: Error): void => {
        logger.warn(
            `[FluxerVoice] Connection error in ${this.channelId}: ${err.message}`
        );
        this.emit('error', err);
    };

    private readonly onServerLeave = (): void => this.close('serverLeave');
    private readonly onDisconnect = (): void => this.close('disconnected');

    constructor(
        private readonly transport: FluxerVoiceTransport,
        private readonly voiceManager: VoiceManager,
        private readonly connection: VoiceConnectionLike,
        readonly guildId: string,
        readonly channelId: string
    ) {
        super();
    }

    /** Wire up receive subscriptions and publish the outbound track. */
    async init(): Promise<void> {
        const conn = this.connection;
        conn.on('error', this.onConnectionError);
        conn.on('disconnect', this.onDisconnect);

        if (conn instanceof LiveKitRtcConnection) {
            conn.on('serverLeave', this.onServerLeave);
            conn.on('audioFrame', this.onAudioFrame);
            for (const p of this.participants()) {
                if (!p.isBot) this.subscribe(p.userId);
            }
            await this.publishTrack(conn);
        } else {
            logger.warn(
                `[FluxerVoice] Channel ${this.channelId} uses the legacy UDP voice connection; receiving audio is not supported there (send-only)`
            );
            this.udpOutbound = new PassThrough({ objectMode: true });
            conn.playOpus(this.udpOutbound);
        }

        this.transport.on('participantUpdate', this.onParticipantUpdate);
    }

    participants(): VoiceParticipant[] {
        return this.transport.listParticipants(this.guildId, this.channelId);
    }

    sendOpus(packet: OpusPacket): void {
        if (this.closed) return;

        if (this.udpOutbound) {
            this.udpOutbound.write(packet);
            this.sentFrames++;
            return;
        }

        const source = this.audioSource;
        if (!source) return;
        if (source.queuedDuration > MAX_QUEUED_PLAYOUT_MS) {
            this.countDrop('LiveKit playout queue full');
            return;
        }

        let pcm: Buffer;
        try {
            pcm = this.outboundDecoder.decode(packet);
        } catch (err) {
            logger.debug(
                `[FluxerVoice] Dropping undecodable outbound packet: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
            return;
        }
        const decoded = new Int16Array(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength / 2
        );
        if (decoded.length !== FRAME_SAMPLES) {
            this.countDrop(
                `unexpected outbound frame size ${decoded.length} samples`
            );
            return;
        }

        // AudioFrame keeps a reference; copy so the next decode cannot alias it.
        const samples = new Int16Array(FRAME_SAMPLES);
        samples.set(decoded);
        const frame = new AudioFrame(
            samples,
            SAMPLE_RATE,
            CHANNELS,
            SAMPLES_PER_FRAME
        );
        this.sentFrames++;
        source.captureFrame(frame).catch((err: unknown) => {
            if (this.closed) return;
            logger.debug(
                `[FluxerVoice] captureFrame failed: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
        });
    }

    async leave(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.teardown();
        await this.unpublishTrack();
        this.connection.stop();
        this.voiceManager.leaveChannel(this.channelId);
        this.finish('left');
    }

    private async publishTrack(conn: LiveKitRtcConnection): Promise<void> {
        const room = getRoom(conn);
        if (!room?.isConnected || !room.localParticipant) {
            throw new Error(
                'LiveKit room is not connected; cannot publish bridge audio'
            );
        }
        const source = new AudioSource(SAMPLE_RATE, CHANNELS);
        const track = LocalAudioTrack.createAudioTrack(
            'bifrost-bridge',
            source
        );
        const options = new TrackPublishOptions();
        options.source = TrackSource.SOURCE_MICROPHONE;
        await room.localParticipant.publishTrack(track, options);
        this.audioSource = source;
        this.audioTrack = track;
    }

    private async unpublishTrack(): Promise<void> {
        const source = this.audioSource;
        const track = this.audioTrack;
        this.audioSource = null;
        this.audioTrack = null;
        if (!source && !track) return;

        const conn = this.connection;
        const room =
            conn instanceof LiveKitRtcConnection ? getRoom(conn) : null;
        try {
            if (track?.sid && room?.isConnected && room.localParticipant) {
                await room.localParticipant.unpublishTrack(track.sid);
            }
        } catch (err) {
            logger.debug(
                `[FluxerVoice] unpublishTrack failed: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
        }
        await Promise.allSettled([source?.close(), track?.close()]);
    }

    private subscribe(userId: string): void {
        if (this.closed) return;
        const conn = this.connection;
        if (!(conn instanceof LiveKitRtcConnection)) return;
        if (userId === this.transport.botUserId()) return;
        const existing = this.inbound.get(userId);
        if (existing?.subscription) return;

        // LiveKit participant identity is the Fluxer user ID (this is what
        // VoiceManager.subscribeChannelParticipants passes through as well).
        const subscription = conn.subscribeParticipantAudio(userId, {
            autoResubscribe: true,
        });
        this.inbound.set(userId, {
            subscription,
            encoder: existing?.encoder ?? null,
            pending: existing?.pending ?? new Int16Array(0),
            warnedFormat: existing?.warnedFormat ?? false,
        });
    }

    private unsubscribe(userId: string): void {
        const entry = this.inbound.get(userId);
        if (!entry) return;
        this.inbound.delete(userId);
        entry.subscription?.stop();
    }

    /**
     * Convert a decoded LiveKit frame (48 kHz, mono or stereo, any length)
     * into 20 ms stereo Opus packets.
     */
    private handleAudioFrame(frame: LiveKitAudioFrame): void {
        if (this.closed) return;
        const userId = frame.participantId;
        if (userId === this.transport.botUserId()) return;

        let entry = this.inbound.get(userId);
        if (!entry) {
            // A participant we did not ask for (identity mismatch or a late
            // voice state). Still bridge it, but note it once.
            logger.debug(
                `[FluxerVoice] Audio from unexpected participant ${userId} in ${this.channelId}`
            );
            entry = {
                subscription: null,
                encoder: null,
                pending: new Int16Array(0),
                warnedFormat: false,
            };
            this.inbound.set(userId, entry);
        }

        if (frame.sampleRate !== SAMPLE_RATE) {
            if (!entry.warnedFormat) {
                entry.warnedFormat = true;
                logger.warn(
                    `[FluxerVoice] Unsupported sample rate ${frame.sampleRate} from ${userId}; dropping audio`
                );
            }
            return;
        }

        const stereo = toStereo(frame.samples, frame.channels);
        if (!stereo) {
            if (!entry.warnedFormat) {
                entry.warnedFormat = true;
                logger.warn(
                    `[FluxerVoice] Unsupported channel count ${frame.channels} from ${userId}; dropping audio`
                );
            }
            return;
        }

        let pending: Int16Array;
        if (entry.pending.length === 0) {
            pending = stereo;
        } else {
            pending = new Int16Array(entry.pending.length + stereo.length);
            pending.set(entry.pending);
            pending.set(stereo, entry.pending.length);
        }
        if (pending.length > MAX_PENDING_SAMPLES) {
            pending = pending.slice(pending.length - MAX_PENDING_SAMPLES);
        }

        entry.encoder ??= new OpusEncoder(SAMPLE_RATE, CHANNELS);
        let offset = 0;
        while (pending.length - offset >= FRAME_SAMPLES) {
            const chunk = pending.subarray(offset, offset + FRAME_SAMPLES);
            offset += FRAME_SAMPLES;
            try {
                const packet = entry.encoder.encode(
                    Buffer.from(
                        chunk.buffer,
                        chunk.byteOffset,
                        chunk.byteLength
                    )
                );
                this.emit('audio', userId, packet);
            } catch (err) {
                logger.debug(
                    `[FluxerVoice] Encode failed for ${userId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                );
            }
        }
        entry.pending =
            offset < pending.length ? pending.slice(offset) : new Int16Array(0);
    }

    private countDrop(why: string): void {
        this.droppedFrames++;
        if (this.droppedFrames % 100 === 1) {
            logger.debug(
                `[FluxerVoice] Dropped outbound frame (${why}) in ${this.channelId}; ${this.droppedFrames} so far`
            );
        }
    }

    private close(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.teardown();
        void this.unpublishTrack();
        this.finish(reason);
    }

    private teardown(): void {
        this.transport.off('participantUpdate', this.onParticipantUpdate);
        const conn = this.connection;
        conn.off('error', this.onConnectionError);
        conn.off('disconnect', this.onDisconnect);
        if (conn instanceof LiveKitRtcConnection) {
            conn.off('serverLeave', this.onServerLeave);
            conn.off('audioFrame', this.onAudioFrame);
        }
        for (const userId of [...this.inbound.keys()]) this.unsubscribe(userId);
        if (this.udpOutbound) {
            this.udpOutbound.end();
            this.udpOutbound = null;
        }
    }

    private finish(reason: string): void {
        logger.debug(
            `[FluxerVoice] Session ${this.channelId} closed (${reason}); sent ${this.sentFrames} frames, dropped ${this.droppedFrames}`
        );
        this.emit('closed', reason);
    }
}

/**
 * `LiveKitRtcConnection.room` is private upstream but is the only handle to
 * the LiveKit room we can publish on. Read it reflectively.
 */
function getRoom(conn: LiveKitRtcConnection): Room | null {
    return (conn as unknown as { room: Room | null }).room ?? null;
}

/** Upmix mono to interleaved stereo; pass stereo through; null otherwise. */
function toStereo(samples: Int16Array, channels: number): Int16Array | null {
    if (channels === CHANNELS) return samples;
    if (channels !== 1) return null;
    const out = new Int16Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        out[i * 2] = samples[i];
        out[i * 2 + 1] = samples[i];
    }
    return out;
}
