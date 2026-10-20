import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpusEncoder } from '@discordjs/opus';
import OpusMixer, {
    createOpusMixer,
    FRAME_SAMPLES,
    JITTER_MAX_FRAMES,
    JITTER_TARGET_FRAMES,
    softClip,
} from '../../../src/services/voice/OpusMixer';
import {
    CHANNELS,
    SAMPLE_RATE,
    SAMPLES_PER_FRAME,
} from '../../../src/services/voice/AudioMixer';

const FRAME_BYTES = FRAME_SAMPLES * 2;

/** One 20 ms stereo frame of a sine wave, starting at `frameIndex` frames in. */
function sinePcm(
    frequency: number,
    amplitude: number,
    frameIndex: number
): Buffer {
    const buf = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const t = (frameIndex * SAMPLES_PER_FRAME + i) / SAMPLE_RATE;
        const sample = Math.round(
            amplitude * Math.sin(2 * Math.PI * frequency * t)
        );
        for (let c = 0; c < CHANNELS; c++) {
            buf.writeInt16LE(sample, (i * CHANNELS + c) * 2);
        }
    }
    return buf;
}

/** Encode `count` consecutive frames of a sine with one encoder (continuous phase). */
function encodedSine(
    frequency: number,
    amplitude: number,
    count: number
): Buffer[] {
    const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
        frames.push(encoder.encode(sinePcm(frequency, amplitude, i)));
    }
    return frames;
}

function rms(pcm: Buffer): number {
    let sum = 0;
    const n = pcm.length / 2;
    for (let i = 0; i < n; i++) {
        const s = pcm.readInt16LE(i * 2);
        sum += s * s;
    }
    return Math.sqrt(sum / n);
}

function peak(pcm: Buffer): number {
    let max = 0;
    for (let i = 0; i < pcm.length / 2; i++) {
        max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)));
    }
    return max;
}

/** Collect every frame the mixer emits. */
function capture(mixer: OpusMixer): Buffer[] {
    const frames: Buffer[] = [];
    mixer.on('frame', (f) => frames.push(f));
    return frames;
}

/** Push `n` frames of each source, tick `n` times, return decoded output frames. */
function mixAndDecode(
    mixer: OpusMixer,
    sources: Record<string, Buffer[]>,
    ticks: number
): Buffer[] {
    const frames = capture(mixer);
    const perTick = Math.max(...Object.values(sources).map((s) => s.length));
    for (let i = 0; i < perTick; i++) {
        for (const [id, packets] of Object.entries(sources)) {
            if (packets[i]) mixer.push(id, packets[i]);
        }
    }
    for (let i = 0; i < ticks; i++) mixer.tick();
    const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    return frames.map((f) => decoder.decode(f));
}

describe('OpusMixer', () => {
    let mixer: OpusMixer;

    afterEach(() => {
        mixer?.stop();
        vi.useRealTimers();
    });

    it('sums two sources so the output amplitude roughly doubles', () => {
        mixer = new OpusMixer();
        const amplitude = 6000;
        const frames = 8;
        // Both sources carry the same 440 Hz tone in phase, so the mix is
        // exactly 2x (an Opus roundtrip costs a little, hence the tolerance).
        const a = encodedSine(440, amplitude, frames);
        const b = encodedSine(440, amplitude, frames);

        const single = mixAndDecode(new OpusMixer(), { a }, frames);
        const mixed = mixAndDecode(mixer, { a, b }, frames);

        // Skip the frames the jitter buffer withholds and the codec warm-up.
        const steady = (out: Buffer[]) => out.slice(3, frames - 1);
        const singleRms = steady(single).map(rms);
        const mixedRms = steady(mixed).map(rms);
        expect(singleRms.length).toBeGreaterThan(0);

        const expectedSingle = amplitude / Math.SQRT2;
        for (const r of singleRms) {
            expect(r).toBeGreaterThan(expectedSingle * 0.8);
            expect(r).toBeLessThan(expectedSingle * 1.2);
        }
        for (let i = 0; i < mixedRms.length; i++) {
            const ratio = mixedRms[i] / singleRms[i];
            expect(ratio).toBeGreaterThan(1.7);
            expect(ratio).toBeLessThan(2.3);
        }
    });

    it('excludes a muted source from the mix but keeps consuming its frames', () => {
        mixer = new OpusMixer();
        const frames = 8;
        const a = encodedSine(440, 6000, frames);
        const b = encodedSine(440, 6000, frames);
        mixer.setSourceMuted('b', true);

        const out = mixAndDecode(mixer, { a, b }, frames);
        const single = mixAndDecode(new OpusMixer(), { a }, frames);

        for (let i = 3; i < frames - 1; i++) {
            const ratio = rms(out[i]) / rms(single[i]);
            expect(ratio).toBeGreaterThan(0.85);
            expect(ratio).toBeLessThan(1.15);
        }
        // The muted source's queue was drained alongside the active one.
        expect(mixer.queuedFrames('b')).toBe(0);
    });

    it('emits an encoded silence frame when no source is queued', () => {
        mixer = new OpusMixer();
        const frames = capture(mixer);
        mixer.tick();
        mixer.tick();

        expect(frames).toHaveLength(2);
        // Cached: the very same buffer each time.
        expect(frames[0]).toBe(frames[1]);
        const pcm = new OpusEncoder(SAMPLE_RATE, CHANNELS).decode(frames[0]);
        expect(pcm.length).toBe(FRAME_BYTES);
        expect(peak(pcm)).toBeLessThan(50);
    });

    it('also emits silence when a source exists but is still buffering', () => {
        mixer = new OpusMixer();
        const frames = capture(mixer);
        const [packet] = encodedSine(440, 6000, 1);
        mixer.push('a', packet);
        expect(mixer.queuedFrames('a')).toBe(1);

        mixer.tick(); // below JITTER_TARGET_FRAMES: not primed yet
        expect(mixer.queuedFrames('a')).toBe(1);
        expect(frames).toHaveLength(1);
        expect(JITTER_TARGET_FRAMES).toBeGreaterThan(1);
    });

    it('drops the oldest frames when a source overflows the jitter buffer', () => {
        mixer = new OpusMixer();
        const total = JITTER_MAX_FRAMES + 5;
        // Distinct amplitude per frame so we can tell which ones survived.
        const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
        for (let i = 0; i < total; i++) {
            const amplitude = i < 5 ? 100 : 8000; // first five are quiet
            mixer.push('a', encoder.encode(sinePcm(440, amplitude, i)));
        }
        expect(mixer.queuedFrames('a')).toBe(JITTER_MAX_FRAMES);

        const frames = capture(mixer);
        for (let i = 0; i < JITTER_MAX_FRAMES; i++) mixer.tick();
        const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
        const outputs = frames.map((f) => decoder.decode(f));
        // The quiet frames were the oldest and must all be gone; once the
        // codec settles every surviving frame is loud.
        for (const pcm of outputs.slice(2)) {
            expect(rms(pcm)).toBeGreaterThan(2000);
        }
        expect(mixer.queuedFrames('a')).toBe(0);
    });

    it('drops undecodable packets without throwing', () => {
        mixer = new OpusMixer();
        expect(() =>
            mixer.push('a', Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]))
        ).not.toThrow();
        expect(mixer.queuedFrames('a')).toBe(0);
    });

    it('re-chunks packets that are not 20 ms', () => {
        mixer = new OpusMixer();
        // 10 ms frames: two packets should produce one queued mixer frame.
        const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
        const tenMs = Buffer.alloc(FRAME_BYTES / 2, 1);
        mixer.push('a', encoder.encode(tenMs));
        expect(mixer.queuedFrames('a')).toBe(0);
        mixer.push('a', encoder.encode(tenMs));
        expect(mixer.queuedFrames('a')).toBe(1);
    });

    it('removeSource drops queued audio for that source', () => {
        mixer = new OpusMixer();
        const a = encodedSine(440, 6000, 4);
        for (const p of a) mixer.push('a', p);
        mixer.removeSource('a');
        expect(mixer.queuedFrames('a')).toBe(0);
    });

    it('ticks on a timer while started and stop() is idempotent', () => {
        // The scheduler is drift-corrected against performance.now(), so
        // that clock has to be faked along with the timers.
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        mixer = new OpusMixer();
        const frames = capture(mixer);

        mixer.start();
        mixer.start();
        expect(mixer.running).toBe(true);
        vi.advanceTimersByTime(20 * 5 + 1);
        expect(frames.length).toBeGreaterThanOrEqual(4);
        expect(frames.length).toBeLessThanOrEqual(6);

        const [packet] = encodedSine(440, 6000, 1);
        mixer.push('a', packet);
        mixer.stop();
        mixer.stop();
        expect(mixer.running).toBe(false);
        expect(mixer.queuedFrames('a')).toBe(0);

        const before = frames.length;
        vi.advanceTimersByTime(200);
        expect(frames.length).toBe(before);

        // Can be restarted after stop.
        mixer.start();
        vi.advanceTimersByTime(45);
        expect(frames.length).toBeGreaterThan(before);
    });

    it('soft clips loud mixes so the output never exceeds int16', () => {
        mixer = new OpusMixer();
        const frames = 6;
        const loud = encodedSine(440, 30000, frames);
        const sources: Record<string, Buffer[]> = {};
        for (let i = 0; i < 3; i++) sources[`s${i}`] = loud;
        const out = mixAndDecode(mixer, sources, frames);
        // Three in-phase 30000 sines sum to 90000; a wrapped int16 would be
        // garbage with a low RMS, a soft-clipped one is a loud, bounded wave.
        // (The decoder itself may emit -32768, hence the int16 range check.)
        for (const pcm of out.slice(2)) {
            expect(peak(pcm)).toBeLessThanOrEqual(32768);
            expect(rms(pcm)).toBeGreaterThan(20000);
        }
    });

    it('softClip is identity below the knee and bounded above it', () => {
        expect(softClip(0)).toBe(0);
        expect(softClip(1000)).toBe(1000);
        expect(softClip(-1000)).toBe(-1000);
        expect(softClip(40000)).toBeLessThanOrEqual(32767);
        expect(softClip(-40000)).toBeGreaterThanOrEqual(-32767);
        expect(softClip(40000)).toBeGreaterThan(softClip(30000));
        expect(softClip(1_000_000)).toBeLessThanOrEqual(32767);
    });

    it('createOpusMixer returns a fresh OpusMixer', () => {
        const a = createOpusMixer();
        const b = createOpusMixer();
        expect(a).toBeInstanceOf(OpusMixer);
        expect(a).not.toBe(b);
        a.stop();
        b.stop();
    });
});
