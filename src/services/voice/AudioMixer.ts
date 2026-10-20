import type { EventEmitter } from 'events';
import type { OpusPacket } from './VoiceTransport';

/** 48 kHz, stereo, 20 ms: the only frame shape the bridge deals in. */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960 per channel

export interface AudioMixerEvents {
    /**
     * One mixed 20 ms Opus frame, emitted every FRAME_MS while started.
     * Implementations emit an encoded silence frame when no source is active
     * so the consumer keeps a steady cadence; `silent` is true for exactly
     * those frames (consumers may treat a missing flag as "voiced").
     */
    frame: (packet: OpusPacket, silent?: boolean) => void;
    error: (err: Error) => void;
}

/**
 * Mixes N Opus sources into one Opus stream. Decode → jitter buffer → sum →
 * soft clip → encode. Pure in-process code, no ffmpeg.
 */
export interface AudioMixer extends EventEmitter {
    /** Feed one 20 ms Opus packet from a source (a remote user). */
    push(sourceId: string, packet: OpusPacket): void;
    /** Drop a source and its decoder state. */
    removeSource(sourceId: string): void;
    /** Muted sources are decoded but excluded from the mix. */
    setSourceMuted(sourceId: string, muted: boolean): void;
    start(): void;
    /** Stops the tick and clears all sources. Idempotent. */
    stop(): void;

    on<E extends keyof AudioMixerEvents>(
        event: E,
        listener: AudioMixerEvents[E]
    ): this;
    off<E extends keyof AudioMixerEvents>(
        event: E,
        listener: AudioMixerEvents[E]
    ): this;
    emit<E extends keyof AudioMixerEvents>(
        event: E,
        ...args: Parameters<AudioMixerEvents[E]>
    ): boolean;
}

export type AudioMixerFactory = () => AudioMixer;
