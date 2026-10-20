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
    ConnectionState,
    LocalAudioTrack,
    type RemoteParticipant,
    type RemoteTrack,
    type RemoteTrackPublication,
    type Room,
    RoomEvent,
    TrackKind,
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
import { identityRefersTo, mapIdentityToUserId } from './identity';

/** Interleaved samples per 20 ms stereo frame. */
const FRAME_SAMPLES = SAMPLES_PER_FRAME * CHANNELS;
/** Drop outbound audio once LiveKit has this much queued (we fell behind). */
const MAX_QUEUED_PLAYOUT_MS = 400;
/** Cap on per-participant PCM waiting to fill a 20 ms frame (~200 ms). */
const MAX_PENDING_SAMPLES = FRAME_SAMPLES * 10;
/** Warn if remote participants exist but nothing was received by then. */
const NO_AUDIO_WARNING_MS = 5_000;

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

/** Receive-side counters for one session; see {@link FluxerVoiceSession.stats}. */
export interface FluxerVoiceSessionStats {
    /** Decoded PCM frames received from LiveKit (all participants). */
    framesIn: number;
    /** 20 ms Opus packets emitted as `audio` events. */
    packetsOut: number;
    /** Remote participants currently in the LiveKit room (bot excluded). */
    participants: number;
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
 *   10 ms PCM (`audioFrame` events), but only for participant identities we
 *   explicitly request. We request every remote participant the LiveKit
 *   room reports (not just the ones in our gateway voice-state cache), map
 *   identities back to Fluxer user IDs best-effort, upmix to stereo,
 *   re-chunk to 20 ms and encode with @discordjs/opus so the session emits
 *   Opus packets.
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

/** One remote LiveKit participant we receive (or expect to receive) audio from. */
interface InboundParticipant {
    /** LiveKit participant identity (the key of {@link FluxerVoiceSession.inbound}). */
    identity: string;
    /** Fluxer user ID when the identity could be mapped, else the raw identity. */
    sourceId: string;
    /** Whether `sourceId` is a Fluxer user ID we know of. */
    mapped: boolean;
    subscription: LiveKitReceiveSubscription | null;
    encoder: OpusEncoder | null;
    pending: Int16Array;
    warnedFormat: boolean;
    framesIn: number;
}

export class FluxerVoiceSession extends EventEmitter implements VoiceSession {
    readonly platform = 'fluxer' as const;

    /** Keyed by LiveKit identity, not Fluxer user ID. */
    private readonly inbound = new Map<string, InboundParticipant>();
    private readonly outboundDecoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    private room: Room | null = null;
    private audioSource: AudioSource | null = null;
    private audioTrack: LocalAudioTrack | null = null;
    private udpOutbound: PassThrough | null = null;
    private noAudioTimer: NodeJS.Timeout | null = null;
    private closed = false;
    private framesIn = 0;
    private packetsOut = 0;
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
        if (this.room) {
            // The LiveKit room drives subscriptions; the voice state only
            // helps us tie identities to user IDs, so refresh the mapping.
            if (inChannel) this.remapUnmappedIdentities();
        } else if (inChannel && !update.isBot) {
            this.requestAudio(update.userId, 'voice state');
        } else if (!inChannel) {
            this.dropIdentity(update.userId);
        }
        this.emit('participantUpdate', update);
    };

    private readonly onAudioFrame = (frame: LiveKitAudioFrame): void => {
        this.handleAudioFrame(frame);
    };

    private readonly onConnectionError = (err: Error): void => {
        logger.warn(
            `[FluxerVoice] ⚠️ Connection error in ${this.channelId}: ${err.message}`
        );
        this.emit('error', err);
    };

    private readonly onServerLeave = (): void => this.close('serverLeave');
    private readonly onDisconnect = (): void => this.close('disconnected');

    private readonly onRoomParticipantConnected = (
        participant: RemoteParticipant
    ): void => {
        const identity = participant.identity;
        const mapped = this.resolveSource(identity);
        logger.info(
            `[FluxerVoice] 📡 Participant "${identity}" joined LiveKit room for ${this.channelId} (${describeMapping(mapped)})`
        );
        this.requestAudio(identity, 'participantConnected');
    };

    private readonly onRoomParticipantDisconnected = (
        participant: RemoteParticipant
    ): void => {
        const identity = participant.identity;
        logger.info(
            `[FluxerVoice] 👋 Participant "${identity}" left LiveKit room for ${this.channelId}`
        );
        this.dropIdentity(identity);
    };

    private readonly onRoomTrackPublished = (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
    ): void => {
        if (publication.kind !== TrackKind.KIND_AUDIO) return;
        logger.debug(
            `[FluxerVoice] 📡 Audio track ${publication.sid} published by "${participant.identity}" in ${this.channelId}`
        );
        this.requestAudio(participant.identity, 'trackPublished');
    };

    private readonly onRoomTrackSubscribed = (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
    ): void => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        logger.debug(
            `[FluxerVoice] 📡 Subscribed to audio track ${publication.sid} of "${participant.identity}" in ${this.channelId}`
        );
        // The upstream connection only pumps requested identities; make sure
        // this one is requested (no-op when it already is).
        this.requestAudio(participant.identity, 'trackSubscribed');
    };

    private readonly onRoomReconnected = (): void => {
        logger.info(
            `[FluxerVoice] 🔗 LiveKit room reconnected for ${this.channelId}; re-scanning participants`
        );
        this.scanRoom('reconnect');
    };

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

            const room = getRoom(conn);
            this.room = room;
            if (room) {
                this.attachRoom(room);
                if (room.isConnected) {
                    this.scanRoom('join');
                } else {
                    logger.warn(
                        `[FluxerVoice] ⚠️ LiveKit room for ${this.channelId} not connected yet at init (state ${describeState(room)}); subscribing once it connects`
                    );
                    room.once(RoomEvent.Connected, () =>
                        this.scanRoom('connected')
                    );
                }
            } else {
                logger.warn(
                    `[FluxerVoice] ⚠️ Cannot reach the LiveKit room on this @fluxerjs/voice connection; falling back to voice-state driven subscriptions for ${this.channelId}`
                );
                for (const p of this.participants()) {
                    if (!p.isBot) this.requestAudio(p.userId, 'voice state');
                }
            }

            await this.publishTrack(conn);
            this.armNoAudioWarning();
        } else {
            logger.warn(
                `[FluxerVoice] ⚠️ Channel ${this.channelId} uses the legacy UDP voice connection; receiving audio is not supported there (send-only)`
            );
            this.udpOutbound = new PassThrough({ objectMode: true });
            conn.playOpus(this.udpOutbound);
        }

        this.transport.on('participantUpdate', this.onParticipantUpdate);
    }

    participants(): VoiceParticipant[] {
        return this.transport.listParticipants(this.guildId, this.channelId);
    }

    /** Receive-side counters, for diagnostics. */
    stats(): FluxerVoiceSessionStats {
        return {
            framesIn: this.framesIn,
            packetsOut: this.packetsOut,
            participants: this.room
                ? this.remoteIdentities().length
                : this.inbound.size,
        };
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

    // ------------------------------------------------------------------
    // Room-driven receive subscriptions
    // ------------------------------------------------------------------

    private attachRoom(room: Room): void {
        room.on(
            RoomEvent.ParticipantConnected,
            this.onRoomParticipantConnected
        );
        room.on(
            RoomEvent.ParticipantDisconnected,
            this.onRoomParticipantDisconnected
        );
        room.on(RoomEvent.TrackPublished, this.onRoomTrackPublished);
        room.on(RoomEvent.TrackSubscribed, this.onRoomTrackSubscribed);
        room.on(RoomEvent.Reconnected, this.onRoomReconnected);
    }

    private detachRoom(room: Room): void {
        room.off(
            RoomEvent.ParticipantConnected,
            this.onRoomParticipantConnected
        );
        room.off(
            RoomEvent.ParticipantDisconnected,
            this.onRoomParticipantDisconnected
        );
        room.off(RoomEvent.TrackPublished, this.onRoomTrackPublished);
        room.off(RoomEvent.TrackSubscribed, this.onRoomTrackSubscribed);
        room.off(RoomEvent.Reconnected, this.onRoomReconnected);
    }

    /** Log the room and request audio for every remote participant in it. */
    private scanRoom(why: string): void {
        const room = this.room;
        if (!room || this.closed) return;
        const localIdentity = room.localParticipant?.identity ?? '(none)';
        const botId = this.transport.botUserId() ?? '(unknown)';
        const remotes = [...room.remoteParticipants.values()];
        const known = this.knownUserIds();

        logger.info(
            `[FluxerVoice] 🔗 LiveKit room "${room.name ?? '?'}" for ${this.channelId} (${why}; state ${describeState(room)}); local identity "${localIdentity}", bot user ${botId}${
                localIdentity === botId
                    ? ' (identity == user id)'
                    : identityRefersTo(localIdentity, botId)
                      ? ' (identity embeds user id)'
                      : ' (identity format differs from user id!)'
            }; ${remotes.length} remote participant(s); ${known.size} user(s) in voice-state cache`
        );

        for (const participant of remotes) {
            const identity = participant.identity;
            const audioTracks = [
                ...participant.trackPublications.values(),
            ].filter((pub) => pub.kind === TrackKind.KIND_AUDIO);
            const subscribedTracks = audioTracks.filter(
                (pub) => pub.subscribed
            );
            const mapped = this.resolveSource(identity);
            logger.info(
                `[FluxerVoice] 📡 Remote participant "${identity}": ${describeMapping(mapped)}; ${audioTracks.length} audio track(s), ${subscribedTracks.length} subscribed`
            );
            this.requestAudio(identity, why);
        }
    }

    /**
     * Ask the upstream connection to pump audio for `identity`. Idempotent
     * per identity; skips the bot's own identity.
     */
    private requestAudio(identity: string, why: string): void {
        if (this.closed) return;
        const conn = this.connection;
        if (!(conn instanceof LiveKitRtcConnection)) return;
        if (this.isSelfIdentity(identity)) return;

        const existing = this.inbound.get(identity);
        if (existing?.subscription) return;

        const subscription = conn.subscribeParticipantAudio(identity, {
            autoResubscribe: true,
        });
        const { sourceId, mapped } = this.resolveSource(identity);
        this.inbound.set(identity, {
            identity,
            sourceId,
            mapped,
            subscription,
            encoder: existing?.encoder ?? null,
            pending: existing?.pending ?? new Int16Array(0),
            warnedFormat: existing?.warnedFormat ?? false,
            framesIn: existing?.framesIn ?? 0,
        });
        logger.debug(
            `[FluxerVoice] 🎧 Requested audio from "${identity}" (${why}) in ${this.channelId}`
        );
    }

    private dropIdentity(identity: string): void {
        const entry = this.inbound.get(identity);
        if (!entry) return;
        this.inbound.delete(identity);
        entry.subscription?.stop();
    }

    /** Re-run identity mapping for entries that could not be mapped yet. */
    private remapUnmappedIdentities(): void {
        for (const entry of this.inbound.values()) {
            if (entry.mapped) continue;
            const { sourceId, mapped } = this.resolveSource(entry.identity);
            if (!mapped) continue;
            logger.info(
                `[FluxerVoice] 🎧 Identity "${entry.identity}" now maps to user ${sourceId} in ${this.channelId}`
            );
            entry.sourceId = sourceId;
            entry.mapped = true;
        }
    }

    /** Fluxer user IDs we believe are in this channel (bot excluded). */
    private knownUserIds(): Set<string> {
        const ids = new Set<string>();
        for (const p of this.participants()) ids.add(p.userId);
        return ids;
    }

    private resolveSource(identity: string): {
        sourceId: string;
        mapped: boolean;
    } {
        const userId = mapIdentityToUserId(identity, this.knownUserIds());
        return userId
            ? { sourceId: userId, mapped: true }
            : { sourceId: identity, mapped: false };
    }

    private isSelfIdentity(identity: string): boolean {
        const local = this.room?.localParticipant?.identity;
        if (local && identity === local) return true;
        return identityRefersTo(identity, this.transport.botUserId());
    }

    private remoteIdentities(): string[] {
        const room = this.room;
        if (!room) return [];
        return [...room.remoteParticipants.keys()].filter(
            (identity) => !this.isSelfIdentity(identity)
        );
    }

    private armNoAudioWarning(): void {
        if (this.noAudioTimer) clearTimeout(this.noAudioTimer);
        this.noAudioTimer = setTimeout(() => {
            this.noAudioTimer = null;
            if (this.closed || this.framesIn > 0) return;
            const remotes = this.remoteIdentities();
            if (remotes.length === 0) return;
            const details = remotes
                .map((identity) => {
                    const entry = this.inbound.get(identity);
                    const participant =
                        this.room?.remoteParticipants.get(identity);
                    const audioTracks = participant
                        ? [...participant.trackPublications.values()].filter(
                              (pub) => pub.kind === TrackKind.KIND_AUDIO
                          )
                        : [];
                    const subscribed = audioTracks.filter(
                        (pub) => pub.subscribed
                    ).length;
                    return `"${identity}" (${
                        entry?.subscription ? 'requested' : 'NOT requested'
                    }, ${audioTracks.length} audio track(s), ${subscribed} subscribed)`;
                })
                .join(', ');
            logger.warn(
                `[FluxerVoice] ⚠️ No audio received from LiveKit ${NO_AUDIO_WARNING_MS / 1000}s after joining ${this.channelId} although ${remotes.length} remote participant(s) are present: ${details}. If nobody spoke this is fine; otherwise the track subscription is not delivering frames.`
            );
        }, NO_AUDIO_WARNING_MS);
        this.noAudioTimer.unref();
    }

    // ------------------------------------------------------------------
    // Outbound track
    // ------------------------------------------------------------------

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
        const publication = await room.localParticipant.publishTrack(
            track,
            options
        );
        this.audioSource = source;
        this.audioTrack = track;
        logger.info(
            `[FluxerVoice] 📡 Published bridge audio track ${publication.sid ?? track.sid ?? '?'} to LiveKit room for ${this.channelId}`
        );
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

    // ------------------------------------------------------------------
    // Inbound audio
    // ------------------------------------------------------------------

    /**
     * Convert a decoded LiveKit frame (48 kHz, mono or stereo, any length)
     * into 20 ms stereo Opus packets emitted under the mapped source id.
     */
    private handleAudioFrame(frame: LiveKitAudioFrame): void {
        if (this.closed) return;
        const identity = frame.participantId;
        if (this.isSelfIdentity(identity)) return;

        let entry = this.inbound.get(identity);
        if (!entry) {
            // Audio for an identity we never requested (upstream behaviour
            // changed, or a race with ParticipantDisconnected). Bridge it
            // anyway; the mixer only needs a stable key.
            const { sourceId, mapped } = this.resolveSource(identity);
            logger.info(
                `[FluxerVoice] 🎧 Audio from unrequested participant "${identity}" in ${this.channelId} (${describeMapping({ sourceId, mapped })}); bridging it anyway`
            );
            entry = {
                identity,
                sourceId,
                mapped,
                subscription: null,
                encoder: null,
                pending: new Int16Array(0),
                warnedFormat: false,
                framesIn: 0,
            };
            this.inbound.set(identity, entry);
        }

        this.framesIn++;
        entry.framesIn++;
        if (entry.framesIn === 1) {
            logger.info(
                `[FluxerVoice] 🎧 First audio frame from "${identity}" in ${this.channelId}: ${frame.sampleRate} Hz, ${frame.channels} ch, ${frame.samples.length} samples/frame, track ${frame.trackSid ?? '?'}; emitting as source ${entry.sourceId}${entry.mapped ? '' : ' (raw identity, no user id match)'}`
            );
        }

        if (frame.sampleRate !== SAMPLE_RATE) {
            if (!entry.warnedFormat) {
                entry.warnedFormat = true;
                logger.warn(
                    `[FluxerVoice] ⚠️ Unsupported sample rate ${frame.sampleRate} from "${identity}"; dropping audio`
                );
            }
            return;
        }

        const stereo = toStereo(frame.samples, frame.channels);
        if (!stereo) {
            if (!entry.warnedFormat) {
                entry.warnedFormat = true;
                logger.warn(
                    `[FluxerVoice] ⚠️ Unsupported channel count ${frame.channels} from "${identity}"; dropping audio`
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
                this.packetsOut++;
                this.emit('audio', entry.sourceId, packet);
            } catch (err) {
                logger.debug(
                    `[FluxerVoice] Encode failed for "${identity}": ${
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

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    private close(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.teardown();
        void this.unpublishTrack();
        this.finish(reason);
    }

    private teardown(): void {
        if (this.noAudioTimer) {
            clearTimeout(this.noAudioTimer);
            this.noAudioTimer = null;
        }
        this.transport.off('participantUpdate', this.onParticipantUpdate);
        const conn = this.connection;
        conn.off('error', this.onConnectionError);
        conn.off('disconnect', this.onDisconnect);
        if (conn instanceof LiveKitRtcConnection) {
            conn.off('serverLeave', this.onServerLeave);
            conn.off('audioFrame', this.onAudioFrame);
        }
        if (this.room) {
            this.detachRoom(this.room);
            this.room = null;
        }
        for (const identity of [...this.inbound.keys()]) {
            this.dropIdentity(identity);
        }
        if (this.udpOutbound) {
            this.udpOutbound.end();
            this.udpOutbound = null;
        }
    }

    private finish(reason: string): void {
        logger.info(
            `[FluxerVoice] 👋 Session ${this.channelId} closed (${reason}); received ${this.framesIn} frames → ${this.packetsOut} packets, sent ${this.sentFrames} frames, dropped ${this.droppedFrames}`
        );
        this.emit('closed', reason);
    }
}

/**
 * `LiveKitRtcConnection.room` is private upstream but is the only handle to
 * the LiveKit room we can publish on and enumerate participants from. Read
 * it reflectively.
 */
function getRoom(conn: LiveKitRtcConnection): Room | null {
    return (conn as unknown as { room: Room | null }).room ?? null;
}

function describeState(room: Room): string {
    const state = room.connectionState;
    return `${ConnectionState[state] ?? state}${room.isConnected ? '' : ', not connected'}`;
}

function describeMapping(mapping: {
    sourceId: string;
    mapped: boolean;
}): string {
    return mapping.mapped
        ? `maps to user ${mapping.sourceId}`
        : 'no known user id, bridging under raw identity';
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
