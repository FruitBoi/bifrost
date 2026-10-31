import type { EventEmitter } from 'events';

/**
 * Platform-neutral contract between the voice bridge and the two voice
 * stacks (Discord via @discordjs/voice, Fluxer via @fluxerjs/voice).
 *
 * All audio crossing these interfaces is **one 20 ms Opus frame at 48 kHz,
 * 2 channels** per packet. Transports decode/encode nothing; the mixer does.
 */
export type OpusPacket = Buffer;

export type VoicePlatform = 'discord' | 'fluxer';

export interface VoiceParticipant {
    userId: string;
    /** True for the bridge bot itself or any other bot user. */
    isBot: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
}

/**
 * Emitted whenever a voice state changes in any guild the client can see.
 * `channelId` is null when the user left voice entirely.
 */
export interface VoiceParticipantUpdate extends VoiceParticipant {
    guildId: string;
    channelId: string | null;
    /** Channel the user was in before this update, when known. */
    previousChannelId: string | null;
}

export interface VoiceSessionEvents {
    /** Incoming audio from one remote (non-bot) participant. */
    audio: (userId: string, packet: OpusPacket) => void;
    /** A participant in *this* channel joined, left or changed mute state. */
    participantUpdate: (update: VoiceParticipantUpdate) => void;
    /** The session ended for any reason (we left, kicked, network). */
    closed: (reason: string) => void;
    error: (err: Error) => void;
}

/** A live connection of the bot to one voice channel. */
export interface VoiceSession extends EventEmitter {
    readonly platform: VoicePlatform;
    readonly guildId: string;
    readonly channelId: string;
    /** Participants currently in the channel, excluding the bot itself. */
    participants(): VoiceParticipant[];
    /** Publish one 20 ms Opus frame. Call with silence frames to keep cadence. */
    sendOpus(packet: OpusPacket): void;
    /** Leave the channel and release resources. Idempotent. */
    leave(): Promise<void>;

    on<E extends keyof VoiceSessionEvents>(
        event: E,
        listener: VoiceSessionEvents[E]
    ): this;
    off<E extends keyof VoiceSessionEvents>(
        event: E,
        listener: VoiceSessionEvents[E]
    ): this;
    emit<E extends keyof VoiceSessionEvents>(
        event: E,
        ...args: Parameters<VoiceSessionEvents[E]>
    ): boolean;
}

export interface VoiceTransportEvents {
    /** Any voice state change the client sees, in any guild/channel. */
    participantUpdate: (update: VoiceParticipantUpdate) => void;
    error: (err: Error) => void;
}

/** One platform's voice stack. One instance per bot client. */
export interface VoiceTransport extends EventEmitter {
    readonly platform: VoicePlatform;
    /** Bot user ID once the client is ready, else null. */
    botUserId(): string | null;
    /** Human participants in a channel, from cached voice states. */
    listParticipants(guildId: string, channelId: string): VoiceParticipant[];
    /**
     * Voice channel a user is currently in within a guild, from cached voice
     * states, or null when they are not in voice there (or unknown).
     */
    userVoiceChannel(guildId: string, userId: string): string | null;
    /** Join a voice channel. Rejects if the bot lacks permission or is already elsewhere in that guild. */
    join(guildId: string, channelId: string): Promise<VoiceSession>;

    on<E extends keyof VoiceTransportEvents>(
        event: E,
        listener: VoiceTransportEvents[E]
    ): this;
    off<E extends keyof VoiceTransportEvents>(
        event: E,
        listener: VoiceTransportEvents[E]
    ): this;
    emit<E extends keyof VoiceTransportEvents>(
        event: E,
        ...args: Parameters<VoiceTransportEvents[E]>
    ): boolean;
}
