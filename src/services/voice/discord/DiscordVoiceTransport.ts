import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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
/** Outbound frames buffered before we start dropping (player not draining). */
const MAX_SEND_BACKLOG_FRAMES = 50;
/** Frames the player tolerates without input before going Idle. */
const PLAYER_MAX_MISSED_FRAMES = 250; // 5 s at 20 ms

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

        const connection = joinVoiceChannel({
            channelId,
            guildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
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
                `[DiscordVoice] Failed to become Ready in voice channel ${channelId} within ${JOIN_TIMEOUT_MS} ms`
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

export class DiscordVoiceSession extends EventEmitter implements VoiceSession {
    readonly platform = 'discord' as const;
    readonly guildId: string;

    private readonly player: AudioPlayer;
    private readonly outbound: PassThrough;
    private readonly subscriptions = new Map<string, AudioReceiveStream>();
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
            // We were moved or kicked; @discordjs/voice will emit Disconnected
            // if the connection is affected, nothing to do for participants.
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

        // Outbound: an object-mode stream of Opus packets fed by sendOpus.
        this.outbound = new PassThrough({ objectMode: true });
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                maxMissedFrames: PLAYER_MAX_MISSED_FRAMES,
            },
        });
        this.player.on('error', (err) => {
            logger.warn(
                `[DiscordVoice] Audio player error in ${this.channelId}: ${err.message}`
            );
            this.emit('error', err);
        });
        this.player.on(AudioPlayerStatus.Idle, () => this.restartPlayback());
        connection.subscribe(this.player);
        this.startPlayback();

        // Inbound: subscribe to each non-bot user as soon as they speak.
        connection.receiver.speaking.on('start', (userId) =>
            this.subscribe(userId)
        );
        for (const userId of connection.receiver.speaking.users.keys()) {
            this.subscribe(userId);
        }

        connection.on('error', (err) => {
            logger.warn(
                `[DiscordVoice] Connection error in ${this.channelId}: ${err.message}`
            );
            this.emit('error', err);
        });
        connection.on(
            VoiceConnectionStatus.Disconnected,
            () => void this.handleDisconnected()
        );
        connection.on(VoiceConnectionStatus.Destroyed, () =>
            this.close('destroyed')
        );

        transport.on('participantUpdate', this.onParticipantUpdate);
    }

    participants(): VoiceParticipant[] {
        return this.transport.listParticipants(this.guildId, this.channelId);
    }

    sendOpus(packet: OpusPacket): void {
        if (this.closed) return;
        if (this.outbound.readableLength >= MAX_SEND_BACKLOG_FRAMES) {
            this.droppedFrames++;
            if (this.droppedFrames % 100 === 1) {
                logger.debug(
                    `[DiscordVoice] Outbound backlog full in ${this.channelId}, dropped ${this.droppedFrames} frame(s) so far`
                );
            }
            return;
        }
        this.outbound.write(packet);
        this.sentFrames++;
    }

    async leave(): Promise<void> {
        this.close('left');
    }

    private startPlayback(): void {
        const resource = createAudioResource(this.outbound, {
            inputType: StreamType.Opus,
        });
        this.player.play(resource);
    }

    /**
     * The player drops to Idle after PLAYER_MAX_MISSED_FRAMES without input
     * (the mixer normally never lets that happen). Resume on the same stream
     * if it is still open.
     */
    private restartPlayback(): void {
        if (
            this.closed ||
            this.outbound.destroyed ||
            this.outbound.readableEnded
        ) {
            return;
        }
        logger.debug(
            `[DiscordVoice] Player went idle in ${this.channelId}, restarting playback`
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

    private subscribe(userId: string): void {
        if (this.closed || this.subscriptions.has(userId)) return;
        if (userId === this.transport.botUserId()) return;
        const member = this.guild.members.cache.get(userId);
        if (member?.user.bot) return;
        const state = this.guild.voiceStates.cache.get(userId);
        if (state && state.channelId !== this.channelId) return;

        const stream = this.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.Manual },
        });
        stream.on('data', (packet: Buffer) =>
            this.emit('audio', userId, packet)
        );
        stream.on('error', (err) => {
            logger.debug(
                `[DiscordVoice] Receive stream error for ${userId}: ${err.message}`
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
            logger.debug(
                `[DiscordVoice] Connection in ${this.channelId} is reconnecting`
            );
        } catch {
            this.close('disconnected');
        }
    }

    private close(reason: string): void {
        if (this.closed) return;
        // Set first: destroy() emits Destroyed synchronously, which re-enters here.
        this.closed = true;
        this.teardown();
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
        }
        this.finish(reason);
    }

    private teardown(): void {
        this.transport.off('participantUpdate', this.onParticipantUpdate);
        for (const userId of [...this.subscriptions.keys()]) {
            this.unsubscribe(userId);
        }
        this.player.removeAllListeners(AudioPlayerStatus.Idle);
        this.player.stop(true);
        this.outbound.end();
    }

    private finish(reason: string): void {
        logger.debug(
            `[DiscordVoice] Session ${this.channelId} closed (${reason}); sent ${this.sentFrames} frames, dropped ${this.droppedFrames}`
        );
        this.emit('closed', reason);
    }
}
