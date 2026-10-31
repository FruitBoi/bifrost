import type { spawn as nodeSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YtDlpTrackPlayer, {
    PCM_FRAME_BYTES,
    PREBUFFER_FRAMES,
    SILENCE_TAIL_FRAMES,
} from '../../../src/services/music/YtDlpTrackPlayer';
import {
    MusicError,
    type PlaybackHandle,
    type TrackInfo,
} from '../../../src/services/music/types';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    /** When false, kill() records the signal but the process "ignores" it. */
    diesOnKill = true;
    kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
        if (this.diesOnKill) this.exit(null, signal);
        return true;
    });

    constructor(
        readonly command: string,
        readonly args: string[]
    ) {
        super();
    }

    exit(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('close', code, signal);
    }
}

const TRACK: TrackInfo = {
    title: 'Song',
    url: 'https://www.youtube.com/watch?v=abc',
    durationSec: 60,
    isLive: false,
};

/** Lets stream events (real nextTick/setImmediate) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `frames` frames of a non-silent tone. */
function tone(frames: number): Buffer {
    const buffer = Buffer.alloc(frames * PCM_FRAME_BYTES);
    for (let i = 0; i < buffer.length / 2; i++) {
        buffer.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
    }
    return buffer;
}

function setup(options: { volume?: number; spawnThrows?: boolean } = {}) {
    const children: FakeChild[] = [];
    const spawn = vi.fn((command: string, args: string[]) => {
        if (options.spawnThrows) throw new Error('boom');
        const child = new FakeChild(command, args);
        children.push(child);
        return child;
    }) as unknown as typeof nodeSpawn;
    const player = new YtDlpTrackPlayer({ spawn, volume: options.volume });
    const packets: Buffer[] = [];
    const sink = vi.fn((packet: Buffer) => {
        packets.push(packet);
    });
    const handle = player.play(TRACK, sink);
    const end = vi.fn();
    handle.on('end', end);
    const ytDlp = () => children.find((c) => c.command === 'yt-dlp')!;
    const ffmpeg = () => children.find((c) => c.command === 'ffmpeg')!;
    return { handle, sink, packets, end, ytDlp, ffmpeg, spawn, children };
}

async function writePcm(child: FakeChild, data: Buffer): Promise<void> {
    child.stdout.write(data);
    await flush();
}

async function finishFfmpeg(child: FakeChild, code: number): Promise<void> {
    child.stdout.end();
    await flush();
    child.exit(code);
}

describe('YtDlpTrackPlayer', () => {
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('spawns yt-dlp piped into ffmpeg with the URL after --', () => {
        const { ytDlp, ffmpeg, handle } = setup({ volume: 0.5 });
        expect(ytDlp().args).toEqual(
            expect.arrayContaining([
                '-f',
                'bestaudio/best',
                '--no-playlist',
                '-o',
                '-',
            ])
        );
        expect(ytDlp().args.slice(-2)).toEqual(['--', TRACK.url]);
        const args = ffmpeg().args.join(' ');
        expect(args).toContain('-i pipe:0');
        expect(args).toContain('-f s16le -ar 48000 -ac 2');
        expect(args).toContain('-af volume=0.5');
        expect(ffmpeg().args.at(-1)).toBe('pipe:1');
        handle.stop();
    });

    it('omits the volume filter at the default volume', () => {
        const { ffmpeg, handle } = setup();
        expect(ffmpeg().args).not.toContain('-af');
        handle.stop();
    });

    it('waits for the prebuffer before sending', async () => {
        const { ffmpeg, sink, handle } = setup();
        await writePcm(ffmpeg(), tone(PREBUFFER_FRAMES - 1));
        vi.advanceTimersByTime(200);
        expect(sink).not.toHaveBeenCalled();

        await writePcm(ffmpeg(), tone(1));
        vi.advanceTimersByTime(20);
        expect(sink).toHaveBeenCalledTimes(1);
        handle.stop();
    });

    it('sends one frame every 20 ms', async () => {
        const { ffmpeg, sink, handle } = setup();
        await writePcm(ffmpeg(), tone(50));

        vi.advanceTimersByTime(19);
        expect(sink).toHaveBeenCalledTimes(0);
        vi.advanceTimersByTime(1);
        expect(sink).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(200);
        expect(sink).toHaveBeenCalledTimes(11);
        expect(handle.elapsedMs()).toBe(220);
        handle.stop();
    });

    it('resyncs instead of bursting after a stall', async () => {
        const { ffmpeg, sink, handle } = setup();
        await writePcm(ffmpeg(), tone(100));
        vi.advanceTimersByTime(20);
        expect(sink).toHaveBeenCalledTimes(1);

        // The event loop stalls: the clock jumps 1 s ahead of the schedule.
        const fakeNow = performance.now.bind(performance);
        const spy = vi
            .spyOn(performance, 'now')
            .mockImplementation(() => fakeNow() + 1000);
        vi.advanceTimersByTime(20);
        expect(sink).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(100);
        expect(sink).toHaveBeenCalledTimes(7);
        spy.mockRestore();
        handle.stop();
    });

    it('finishes after the buffer drains, with a silence tail', async () => {
        const { ffmpeg, sink, packets, end, handle } = setup();
        await writePcm(
            ffmpeg(),
            Buffer.concat([tone(12), tone(1).subarray(0, 100)])
        );
        await finishFfmpeg(ffmpeg(), 0);

        vi.advanceTimersByTime(20 * 13);
        expect(sink).toHaveBeenCalledTimes(13);
        expect(end).not.toHaveBeenCalled();

        vi.advanceTimersByTime(20 * SILENCE_TAIL_FRAMES);
        expect(sink).toHaveBeenCalledTimes(13 + SILENCE_TAIL_FRAMES);
        expect(end).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledWith('finished', undefined);
        const tail = packets.slice(-SILENCE_TAIL_FRAMES);
        expect(new Set(tail).size).toBe(1);
        expect(packets[0].equals(tail[0])).toBe(false);
        expect(handle.elapsedMs()).toBe(13 * 20);

        vi.advanceTimersByTime(1000);
        handle.stop();
        expect(sink).toHaveBeenCalledTimes(13 + SILENCE_TAIL_FRAMES);
        expect(end).toHaveBeenCalledTimes(1);
    });

    it('plays a short track that never fills the prebuffer', async () => {
        const { ffmpeg, sink, end } = setup();
        await writePcm(ffmpeg(), tone(3));
        await finishFfmpeg(ffmpeg(), 0);
        vi.advanceTimersByTime(20 * (3 + SILENCE_TAIL_FRAMES));
        expect(sink).toHaveBeenCalledTimes(3 + SILENCE_TAIL_FRAMES);
        expect(end).toHaveBeenCalledWith('finished', undefined);
    });

    it('pauses after a silence tail and resumes', async () => {
        const { ffmpeg, sink, packets, handle } = setup();
        await writePcm(ffmpeg(), tone(50));
        vi.advanceTimersByTime(60);
        expect(sink).toHaveBeenCalledTimes(3);

        handle.pause();
        expect(handle.paused).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(sink).toHaveBeenCalledTimes(3 + SILENCE_TAIL_FRAMES);
        const tail = packets.slice(3);
        expect(new Set(tail).size).toBe(1);
        expect(handle.elapsedMs()).toBe(60);

        handle.resume();
        expect(handle.paused).toBe(false);
        vi.advanceTimersByTime(40);
        expect(sink).toHaveBeenCalledTimes(3 + SILENCE_TAIL_FRAMES + 2);
        expect(handle.elapsedMs()).toBe(100);
        handle.stop();
    });

    it('stop kills both children, emits stopped once and falls back to SIGKILL', async () => {
        const { ffmpeg, ytDlp, sink, end, handle } = setup();
        await writePcm(ffmpeg(), tone(50));
        vi.advanceTimersByTime(40);
        ytDlp().diesOnKill = false;

        handle.stop();
        handle.stop();
        expect(end).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledWith('stopped', undefined);
        expect(ffmpeg().kill).toHaveBeenCalledWith('SIGTERM');
        expect(ytDlp().kill).toHaveBeenCalledWith('SIGTERM');

        vi.advanceTimersByTime(5000);
        expect(sink).toHaveBeenCalledTimes(2);
        expect(ytDlp().kill).toHaveBeenCalledWith('SIGKILL');
        expect(ffmpeg().kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('ends with an error when a binary is missing', async () => {
        const { ffmpeg, ytDlp, end } = setup();
        const error = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        ffmpeg().emit('error', error);
        ffmpeg().emit('error', error);

        expect(end).toHaveBeenCalledTimes(1);
        const [reason, err] = end.mock.calls[0];
        expect(reason).toBe('error');
        expect(err).toBeInstanceOf(MusicError);
        expect((err as Error).message).toMatch(/ffmpeg is not installed/);
        expect(ytDlp().kill).toHaveBeenCalled();
    });

    it('ends with an error when spawn throws, after listeners are attached', async () => {
        const { end, sink } = setup({ spawnThrows: true });
        expect(end).not.toHaveBeenCalled();
        await flush();
        expect(end).toHaveBeenCalledTimes(1);
        expect(end.mock.calls[0][0]).toBe('error');
        expect(sink).not.toHaveBeenCalled();
    });

    it('ends with an error when no audio is produced', async () => {
        const { ffmpeg, ytDlp, end } = setup();
        ytDlp().stderr.write('ERROR: [youtube] abc: Video unavailable\n');
        ytDlp().stdout.end();
        await flush();
        ytDlp().exit(1);
        await finishFfmpeg(ffmpeg(), 1);

        expect(end).toHaveBeenCalledTimes(1);
        expect(end.mock.calls[0][0]).toBe('error');
        expect(end.mock.calls[0][1]).toBeInstanceOf(MusicError);
        vi.advanceTimersByTime(1000);
        expect(end).toHaveBeenCalledTimes(1);
    });

    it('keeps playing when the sink throws', async () => {
        const { ffmpeg, handle, end } = setup();
        const throwing = vi.fn(() => {
            throw new Error('sink broke');
        });
        handle.stop();
        // A fresh playback whose sink always throws.
        const children: FakeChild[] = [];
        const spawn = vi.fn((command: string, args: string[]) => {
            const child = new FakeChild(command, args);
            children.push(child);
            return child;
        }) as unknown as typeof nodeSpawn;
        const playback: PlaybackHandle = new YtDlpTrackPlayer({ spawn }).play(
            TRACK,
            throwing
        );
        const onEnd = vi.fn();
        playback.on('end', onEnd);
        const fake = children.find((c) => c.command === 'ffmpeg')!;
        await writePcm(fake, tone(20));
        vi.advanceTimersByTime(100);
        expect(throwing).toHaveBeenCalledTimes(5);
        expect(onEnd).not.toHaveBeenCalled();
        playback.stop();
        expect(ffmpeg().kill).toHaveBeenCalled();
        expect(end).toHaveBeenCalledTimes(1);
    });

    it('pauses ffmpeg output when the buffer is full and resumes as it drains', async () => {
        const { ffmpeg, handle } = setup();
        await writePcm(ffmpeg(), tone(160));
        expect(ffmpeg().stdout.isPaused()).toBe(true);

        vi.advanceTimersByTime(20 * 100);
        expect(ffmpeg().stdout.isPaused()).toBe(true);
        vi.advanceTimersByTime(20 * 20);
        expect(ffmpeg().stdout.isPaused()).toBe(false);
        handle.stop();
    });
});
