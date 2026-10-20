import { EventEmitter } from 'events';
import { OpusEncoder } from '@discordjs/opus';
import logger from '../../utils/logging/logger';
import {
    type AudioMixer,
    type AudioMixerFactory,
    CHANNELS,
    FRAME_MS,
    SAMPLE_RATE,
    SAMPLES_PER_FRAME,
} from './AudioMixer';
import type { OpusPacket } from './VoiceTransport';

/** Interleaved int16 samples in one 20 ms stereo frame (960 * 2). */
export const FRAME_SAMPLES = SAMPLES_PER_FRAME * CHANNELS;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** A source is held back until this many frames are queued (jitter target). */
export const JITTER_TARGET_FRAMES = 2;
/** Oldest frames are dropped once a source queues more than this. */
export const JITTER_MAX_FRAMES = 10;

const INT16_MAX = 32767;
/** Soft-clip knee: samples below this pass through untouched. */
const CLIP_KNEE = Math.round(INT16_MAX * 0.8);
/** If the scheduler falls further behind than this, resync instead of bursting. */
const MAX_LAG_MS = FRAME_MS * 5;

interface Source {
    decoder: OpusEncoder;
    /** Decoded frames of exactly FRAME_SAMPLES samples, oldest first. */
    queue: Int16Array[];
    /** Decoded samples that did not fill a whole frame yet. */
    remainder: Int16Array | null;
    muted: boolean;
    /** False while the jitter buffer refills after starting or running dry. */
    primed: boolean;
}

/**
 * Mixes N Opus sources into one Opus stream with @discordjs/opus.
 *
 * Packets are decoded as they arrive (so decode errors surface at push time)
 * and re-chunked into 20 ms frames in a per-source jitter buffer. Every
 * FRAME_MS a drift-corrected timer calls {@link tick}, which pops at most one
 * frame per source, sums them, soft-clips, encodes once and emits `frame`.
 * When no source contributes, a cached encoded silence frame is emitted so
 * the consumer keeps its cadence; the `frame` event's second argument says
 * whether that happened, so consumers can count voiced vs. silent output.
 */
export default class OpusMixer extends EventEmitter implements AudioMixer {
    private readonly encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    private readonly sources = new Map<string, Source>();
    private readonly accumulator = new Int32Array(FRAME_SAMPLES);
    private readonly mixBuffer = Buffer.alloc(FRAME_BYTES);
    private silenceFrame: OpusPacket | null = null;
    private timer: NodeJS.Timeout | null = null;
    private nextTickAt = 0;

    push(sourceId: string, packet: OpusPacket): void {
        const source = this.getOrCreateSource(sourceId);

        let pcm: Buffer;
        try {
            pcm = source.decoder.decode(packet);
        } catch (err) {
            logger.debug(
                `[OpusMixer] Dropping undecodable packet from ${sourceId}: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
            return;
        }

        const samples = new Int16Array(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength / 2
        );
        this.enqueueSamples(source, sourceId, samples);
    }

    removeSource(sourceId: string): void {
        this.sources.delete(sourceId);
    }

    setSourceMuted(sourceId: string, muted: boolean): void {
        this.getOrCreateSource(sourceId).muted = muted;
    }

    start(): void {
        if (this.timer) return;
        this.nextTickAt = performance.now() + FRAME_MS;
        this.schedule();
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.sources.clear();
    }

    /** Whether the periodic tick is running. */
    get running(): boolean {
        return this.timer !== null;
    }

    /** Number of frames currently queued for a source (0 if unknown). */
    queuedFrames(sourceId: string): number {
        return this.sources.get(sourceId)?.queue.length ?? 0;
    }

    /**
     * Mix and emit one frame. Called by the internal timer every FRAME_MS;
     * public so tests (or an external clock) can drive the mixer directly.
     */
    tick(): void {
        const acc = this.accumulator;
        acc.fill(0);
        let active = 0;

        for (const source of this.sources.values()) {
            if (!source.primed) {
                if (source.queue.length < JITTER_TARGET_FRAMES) continue;
                source.primed = true;
            }

            const frame = source.queue.shift();
            if (!frame) {
                // Ran dry: refill to the jitter target before resuming.
                source.primed = false;
                continue;
            }
            if (source.muted) continue;

            active++;
            for (let i = 0; i < FRAME_SAMPLES; i++) acc[i] += frame[i];
        }

        if (active === 0) {
            this.emit('frame', this.getSilenceFrame(), true);
            return;
        }

        const out = this.mixBuffer;
        for (let i = 0; i < FRAME_SAMPLES; i++) {
            out.writeInt16LE(softClip(acc[i]), i * 2);
        }

        let encoded: OpusPacket;
        try {
            encoded = this.encoder.encode(out);
        } catch (err) {
            this.emit(
                'error',
                err instanceof Error ? err : new Error(String(err))
            );
            return;
        }
        this.emit('frame', encoded, false);
    }

    /** True if `packet` is the cached silence frame this mixer emits when idle. */
    isSilenceFrame(packet: OpusPacket): boolean {
        return this.silenceFrame !== null && packet === this.silenceFrame;
    }

    // Global `performance` (not the perf_hooks import) so fake timers can drive it.
    private schedule(): void {
        const delay = Math.max(0, this.nextTickAt - performance.now());
        this.timer = setTimeout(() => this.onTimer(), delay);
    }

    private onTimer(): void {
        if (!this.timer) return;
        this.tick();
        this.nextTickAt += FRAME_MS;
        const now = performance.now();
        if (now - this.nextTickAt > MAX_LAG_MS) {
            // The event loop stalled; skip the missed ticks rather than burst.
            this.nextTickAt = now + FRAME_MS;
        }
        this.schedule();
    }

    private getOrCreateSource(sourceId: string): Source {
        let source = this.sources.get(sourceId);
        if (!source) {
            source = {
                decoder: new OpusEncoder(SAMPLE_RATE, CHANNELS),
                queue: [],
                remainder: null,
                muted: false,
                primed: false,
            };
            this.sources.set(sourceId, source);
        }
        return source;
    }

    /** Re-chunk decoded samples into FRAME_SAMPLES frames, dropping the oldest on overflow. */
    private enqueueSamples(
        source: Source,
        sourceId: string,
        samples: Int16Array
    ): void {
        let pending = samples;
        if (source.remainder) {
            const joined = new Int16Array(
                source.remainder.length + samples.length
            );
            joined.set(source.remainder);
            joined.set(samples, source.remainder.length);
            pending = joined;
            source.remainder = null;
        }

        let offset = 0;
        while (pending.length - offset >= FRAME_SAMPLES) {
            source.queue.push(pending.slice(offset, offset + FRAME_SAMPLES));
            offset += FRAME_SAMPLES;
        }
        if (offset < pending.length) {
            source.remainder = pending.slice(offset);
        }

        if (source.queue.length > JITTER_MAX_FRAMES) {
            const dropped = source.queue.length - JITTER_MAX_FRAMES;
            source.queue.splice(0, dropped);
            logger.debug(
                `[OpusMixer] Jitter buffer overflow for ${sourceId}, dropped ${dropped} frame(s)`
            );
        }
    }

    private getSilenceFrame(): OpusPacket {
        if (!this.silenceFrame) {
            this.silenceFrame = new OpusEncoder(SAMPLE_RATE, CHANNELS).encode(
                Buffer.alloc(FRAME_BYTES)
            );
        }
        return this.silenceFrame;
    }
}

/**
 * Soft clipper: linear up to CLIP_KNEE, then a tanh curve that approaches
 * INT16_MAX asymptotically. Continuous at the knee, never exceeds int16.
 */
export function softClip(sample: number): number {
    const magnitude = Math.abs(sample);
    if (magnitude <= CLIP_KNEE) return sample;
    const headroom = INT16_MAX - CLIP_KNEE;
    const compressed =
        CLIP_KNEE + headroom * Math.tanh((magnitude - CLIP_KNEE) / headroom);
    return Math.round(sample < 0 ? -compressed : compressed);
}

export const createOpusMixer: AudioMixerFactory = () => new OpusMixer();
