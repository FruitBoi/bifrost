import type { EventEmitter } from 'events';
import type { OpusPacket, VoicePlatform } from '../voice/VoiceTransport';

/**
 * Error whose message is safe to show to the user as-is (e.g. "You need to
 * be in a voice channel"). Anything else thrown by the music stack is logged
 * and reported with a generic message.
 */
export class MusicError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MusicError';
    }
}

/** A track resolved by yt-dlp, before or while it plays. */
export interface TrackInfo {
    title: string;
    /** Canonical page URL (e.g. https://www.youtube.com/watch?v=...). */
    url: string;
    /** Null when unknown (e.g. live streams). */
    durationSec: number | null;
    isLive: boolean;
}

/** Turns a URL or search words into one playable track. */
export interface TrackResolver {
    /** Rejects with a {@link MusicError} when nothing playable is found. */
    resolve(query: string): Promise<TrackInfo>;
}

export type PlaybackEndReason = 'finished' | 'stopped' | 'error';

export interface PlaybackEvents {
    /** Emitted exactly once, when the track finished, was stopped or failed. */
    end: (reason: PlaybackEndReason, err?: Error) => void;
}

/** One track being played into an {@link OpusSink}. */
export interface PlaybackHandle extends EventEmitter {
    readonly paused: boolean;
    /** Milliseconds of audio sent so far (excludes time spent paused). */
    elapsedMs(): number;
    pause(): void;
    resume(): void;
    /** Stops playback and kills the child processes. Idempotent. */
    stop(): void;

    on<E extends keyof PlaybackEvents>(
        event: E,
        listener: PlaybackEvents[E]
    ): this;
    once<E extends keyof PlaybackEvents>(
        event: E,
        listener: PlaybackEvents[E]
    ): this;
    off<E extends keyof PlaybackEvents>(
        event: E,
        listener: PlaybackEvents[E]
    ): this;
    emit<E extends keyof PlaybackEvents>(
        event: E,
        ...args: Parameters<PlaybackEvents[E]>
    ): boolean;
}

/** Receives one 20 ms, 48 kHz stereo Opus frame per call, paced in real time. */
export type OpusSink = (packet: OpusPacket) => void;

export interface TrackPlayer {
    play(track: TrackInfo, sink: OpusSink): PlaybackHandle;
}

/** A queued or playing track and who asked for it. */
export interface QueuedTrack extends TrackInfo {
    requestedBy: string;
}

export interface EnqueueRequest {
    platform: VoicePlatform;
    guildId: string;
    userId: string;
    /** Display name of the requester, shown in the queue. */
    requesterName: string;
    /** URL or search words. */
    query: string;
    /**
     * Posts a message in the text channel the command was run in. Used for
     * "Now playing" and playback errors after the command has returned.
     */
    announce: (text: string) => void;
}

export interface EnqueueResult {
    track: QueuedTrack;
    /** 0 when it started playing right away, else its place in the queue (1 = next). */
    position: number;
}

export interface MusicQueueView {
    /** Voice channel the music plays in. */
    channelId: string;
    nowPlaying: (QueuedTrack & { elapsedSec: number }) | null;
    upcoming: QueuedTrack[];
    paused: boolean;
}

/**
 * What the `music` command handlers use. Every method that changes playback
 * rejects/throws a {@link MusicError} with a user-facing message when the
 * caller is not allowed (e.g. not in the music's voice channel) or nothing
 * is playing.
 */
export interface MusicController {
    enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
    /** Skips the current track; returns it. */
    skip(platform: VoicePlatform, guildId: string, userId: string): QueuedTrack;
    /** Stops playback, clears the queue and leaves the voice channel. */
    stop(platform: VoicePlatform, guildId: string, userId: string): void;
    pause(platform: VoicePlatform, guildId: string, userId: string): void;
    resume(platform: VoicePlatform, guildId: string, userId: string): void;
    /** Null when nothing is playing or queued in that guild. */
    queue(platform: VoicePlatform, guildId: string): MusicQueueView | null;
}
