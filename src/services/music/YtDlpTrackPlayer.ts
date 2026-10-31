import { type ChildProcess, spawn as nodeSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { OpusEncoder } from '@discordjs/opus';
import logger from '../../utils/logging/logger';
import {
    CHANNELS,
    FRAME_MS,
    SAMPLE_RATE,
    SAMPLES_PER_FRAME,
} from '../voice/AudioMixer';
import type { OpusPacket } from '../voice/VoiceTransport';
import {
    MusicError,
    type OpusSink,
    type PlaybackEndReason,
    type PlaybackHandle,
    type TrackInfo,
    type TrackPlayer,
} from './types';

/** Bytes of s16le PCM in one 20 ms stereo frame (960 * 2 ch * 2 bytes = 3840). */
export const PCM_FRAME_BYTES = SAMPLES_PER_FRAME * CHANNELS * 2;
/** Frames buffered before playback starts (and after an underrun). */
export const PREBUFFER_FRAMES = 10;
/** Silence frames sent before pausing and after the last audio frame. */
export const SILENCE_TAIL_FRAMES = 5;
/** ffmpeg's stdout is paused once this much PCM is buffered (3 s)... */
const HIGH_WATER_BYTES = PCM_FRAME_BYTES * 150;
/** ...and resumed once the buffer drains below this (1 s). */
const LOW_WATER_BYTES = PCM_FRAME_BYTES * 50;
/** If the scheduler falls further behind than this, resync instead of bursting. */
const MAX_LAG_MS = FRAME_MS * 5;
/** Grace period after SIGTERM before a child is SIGKILLed. */
const KILL_GRACE_MS = 2000;
/** Most of a child's stderr that is kept (it only ends up in logs). */
const MAX_STDERR_CHARS = 16 * 1024;

export interface YtDlpTrackPlayerOptions {
    /** Defaults to `yt-dlp`. */
    ytDlpPath?: string;
    /** Defaults to `ffmpeg`. */
    ffmpegPath?: string;
    /** Linear gain applied by ffmpeg (1 = unchanged, the default). */
    volume?: number;
    /** Process spawner; injected by tests. */
    spawn?: typeof nodeSpawn;
}

let cachedSilenceFrame: OpusPacket | null = null;

/** One encoded 20 ms frame of digital silence (shared, never mutated). */
function silenceFrame(): OpusPacket {
    if (!cachedSilenceFrame) {
        cachedSilenceFrame = new OpusEncoder(SAMPLE_RATE, CHANNELS).encode(
            Buffer.alloc(PCM_FRAME_BYTES)
        );
    }
    return cachedSilenceFrame;
}

/** A short, single-line excerpt of a process's stderr for the logs. */
function stderrExcerpt(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    const errors = lines.filter((line) => line.startsWith('ERROR'));
    const text = (errors.length > 0 ? errors : lines).slice(-2).join(' | ');
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function isRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

/**
 * Plays tracks by streaming them through yt-dlp and ffmpeg.
 *
 * `yt-dlp -o -` writes the best audio stream to stdout, which is piped into
 * ffmpeg's stdin; ffmpeg decodes it to 48 kHz stereo s16le PCM on its stdout.
 * See {@link YtDlpPlayback} for buffering, encoding and pacing.
 */
export default class YtDlpTrackPlayer implements TrackPlayer {
    private readonly ytDlpPath: string;
    private readonly ffmpegPath: string;
    private readonly volume: number;
    private readonly spawnFn: typeof nodeSpawn;

    constructor(options: YtDlpTrackPlayerOptions = {}) {
        this.ytDlpPath = options.ytDlpPath ?? 'yt-dlp';
        this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
        this.volume = options.volume ?? 1;
        this.spawnFn = options.spawn ?? nodeSpawn;
    }

    play(track: TrackInfo, sink: OpusSink): PlaybackHandle {
        const ytDlpArgs = [
            '--ignore-config',
            '-f',
            'bestaudio/best',
            '--no-playlist',
            '--no-warnings',
            '--quiet',
            '-o',
            '-',
            '--',
            track.url,
        ];
        const ffmpegArgs = [
            '-loglevel',
            'error',
            '-i',
            'pipe:0',
            '-vn',
            '-f',
            's16le',
            '-ar',
            String(SAMPLE_RATE),
            '-ac',
            String(CHANNELS),
        ];
        if (Number.isFinite(this.volume) && this.volume !== 1) {
            ffmpegArgs.push('-af', `volume=${Math.max(0, this.volume)}`);
        }
        ffmpegArgs.push('pipe:1');

        const playback = new YtDlpPlayback(track, sink);
        playback.start(
            () =>
                this.spawnFn(this.ytDlpPath, ytDlpArgs, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                }),
            () =>
                this.spawnFn(this.ffmpegPath, ffmpegArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                })
        );
        return playback;
    }
}

/**
 * One track being played.
 *
 * ffmpeg's PCM output is buffered and re-chunked into {@link PCM_FRAME_BYTES}
 * frames. Once {@link PREBUFFER_FRAMES} are buffered, a drift-corrected timer
 * pops one frame every FRAME_MS, encodes it with @discordjs/opus and hands it
 * to the sink. ffmpeg's stdout is paused while more than 3 s of PCM is
 * buffered (which in turn stalls yt-dlp through the pipe) and resumed below
 * 1 s. When the buffer runs dry before the track ends, frames stop until it
 * refills to the prebuffer.
 *
 * `end` is emitted exactly once: `finished` after ffmpeg exited and the
 * buffer drained (followed by a short silence tail so receivers don't
 * interpolate), `stopped` from {@link stop}, `error` when a process could not
 * start or no audio came out at all.
 */
class YtDlpPlayback extends EventEmitter implements PlaybackHandle {
    private readonly encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    private ytDlp: ChildProcess | null = null;
    private ffmpeg: ChildProcess | null = null;
    private ytDlpStderr = '';
    private ffmpegStderr = '';
    private ytDlpExitCode: number | null = null;

    /** Buffered PCM chunks, oldest first; `pcmBytes` is their total length. */
    private pcm: Buffer[] = [];
    private pcmBytes = 0;
    /** Total PCM bytes received from ffmpeg. */
    private receivedBytes = 0;
    /** True once ffmpeg exited (all of its output has been read). */
    private sourceDone = false;
    private stdoutPaused = false;
    /** True until the buffer holds the prebuffer (at start and after an underrun). */
    private buffering = true;

    private timer: NodeJS.Timeout | null = null;
    private nextTickAt = 0;
    private framesSent = 0;
    private silenceToSend = 0;
    private finishing = false;
    private ended = false;
    private isPaused = false;
    private readonly killTimers = new Set<NodeJS.Timeout>();

    constructor(
        private readonly track: TrackInfo,
        private readonly sink: OpusSink
    ) {
        super();
    }

    get paused(): boolean {
        return this.isPaused;
    }

    elapsedMs(): number {
        return this.framesSent * FRAME_MS;
    }

    pause(): void {
        if (this.ended || this.isPaused) return;
        this.isPaused = true;
        if (this.framesSent > 0 && !this.finishing) {
            // Tell receivers the audio stopped instead of letting them interpolate.
            this.silenceToSend = SILENCE_TAIL_FRAMES;
        }
        if (this.silenceToSend === 0 && !this.finishing) this.stopTimer();
    }

    resume(): void {
        if (this.ended || !this.isPaused) return;
        this.isPaused = false;
        if (!this.finishing) this.silenceToSend = 0;
        this.maybeStartTimer();
    }

    stop(): void {
        if (this.ended) return;
        this.finish('stopped');
    }

    /** Spawns both processes and wires them together. */
    start(
        spawnYtDlp: () => ChildProcess,
        spawnFfmpeg: () => ChildProcess
    ): void {
        try {
            this.ffmpeg = spawnFfmpeg();
            this.ytDlp = spawnYtDlp();
        } catch (err) {
            // Defer so the caller can attach its `end` listener first.
            queueMicrotask(() => this.onSpawnError('ffmpeg/yt-dlp', err));
            return;
        }
        const ytDlp = this.ytDlp;
        const ffmpeg = this.ffmpeg;

        ytDlp.on('error', (err) => this.onSpawnError('yt-dlp', err));
        ffmpeg.on('error', (err) => this.onSpawnError('ffmpeg', err));

        ytDlp.stderr?.on('data', (chunk: Buffer) => {
            if (this.ytDlpStderr.length < MAX_STDERR_CHARS) {
                this.ytDlpStderr += chunk.toString();
            }
        });
        ffmpeg.stderr?.on('data', (chunk: Buffer) => {
            if (this.ffmpegStderr.length < MAX_STDERR_CHARS) {
                this.ffmpegStderr += chunk.toString();
            }
        });

        // yt-dlp -> ffmpeg. EPIPE (ffmpeg gone first) is expected on stop/failure.
        ffmpeg.stdin?.on('error', (err) =>
            logger.debug(`[Music] ffmpeg stdin closed: ${err.message}`)
        );
        ytDlp.stdout?.on('error', (err) =>
            logger.debug(`[Music] yt-dlp stdout error: ${err.message}`)
        );
        if (ytDlp.stdout && ffmpeg.stdin) ytDlp.stdout.pipe(ffmpeg.stdin);

        ffmpeg.stdout?.on('data', (chunk: Buffer) => this.onPcm(chunk));
        ffmpeg.stdout?.on('error', (err) =>
            logger.debug(`[Music] ffmpeg stdout error: ${err.message}`)
        );

        ytDlp.on('close', (code) => {
            this.ytDlpExitCode = code;
            if (code !== 0 && code !== null && !this.ended) {
                logger.warn(
                    `[Music] yt-dlp exited with ${code} for ${this.track.url}: ${stderrExcerpt(this.ytDlpStderr)}`
                );
            }
        });
        ffmpeg.on('close', (code) => this.onFfmpegClose(code));
    }

    private onSpawnError(name: string, err: unknown): void {
        if (this.ended) return;
        const error = err instanceof Error ? err : new Error(String(err));
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.error(`[Music] ${name} is not installed or not on PATH`);
            this.finish(
                'error',
                new MusicError(
                    `Music playback is unavailable: ${name} is not installed on the server.`
                )
            );
            return;
        }
        logger.error(`[Music] ${name} failed: ${error.message}`);
        this.finish('error', error);
    }

    private onPcm(chunk: Buffer): void {
        if (this.ended || chunk.length === 0) return;
        this.pcm.push(chunk);
        this.pcmBytes += chunk.length;
        this.receivedBytes += chunk.length;
        if (!this.stdoutPaused && this.pcmBytes > HIGH_WATER_BYTES) {
            this.stdoutPaused = true;
            this.ffmpeg?.stdout?.pause();
        }
        if (
            this.buffering &&
            this.pcmBytes >= PREBUFFER_FRAMES * PCM_FRAME_BYTES
        ) {
            this.buffering = false;
        }
        this.maybeStartTimer();
    }

    private onFfmpegClose(code: number | null): void {
        if (this.ended) return;
        this.sourceDone = true;
        this.buffering = false;
        if (this.receivedBytes === 0) {
            const reason =
                this.ytDlpExitCode !== null && this.ytDlpExitCode !== 0
                    ? `yt-dlp exited with ${this.ytDlpExitCode}: ${stderrExcerpt(this.ytDlpStderr)}`
                    : `ffmpeg exited with ${code}: ${stderrExcerpt(this.ffmpegStderr) || stderrExcerpt(this.ytDlpStderr)}`;
            logger.warn(`[Music] No audio for ${this.track.url} (${reason})`);
            this.finish(
                'error',
                new MusicError(`Could not play **${this.track.title}**.`)
            );
            return;
        }
        if (code !== 0) {
            logger.warn(
                `[Music] ffmpeg exited with ${code} for ${this.track.url}: ${stderrExcerpt(this.ffmpegStderr)}`
            );
        }
        this.maybeStartTimer();
    }

    private maybeStartTimer(): void {
        if (this.timer || this.ended || this.isPaused || this.buffering) return;
        this.nextTickAt = performance.now() + FRAME_MS;
        this.schedule();
    }

    private stopTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    // Global `performance` (not the perf_hooks import) so fake timers can drive it.
    private schedule(): void {
        const delay = Math.max(0, this.nextTickAt - performance.now());
        this.timer = setTimeout(() => this.onTimer(), delay);
    }

    private onTimer(): void {
        if (!this.timer) return;
        try {
            this.tick();
        } catch (err) {
            logger.error(
                `[Music] Playback tick failed: ${err instanceof Error ? err.message : String(err)}`
            );
            this.finish(
                'error',
                err instanceof Error ? err : new Error(String(err))
            );
        }
        if (!this.timer) return; // stopped by tick
        this.nextTickAt += FRAME_MS;
        const now = performance.now();
        if (now - this.nextTickAt > MAX_LAG_MS) {
            // The event loop stalled; skip the missed ticks rather than burst.
            this.nextTickAt = now + FRAME_MS;
        }
        this.schedule();
    }

    /** Sends at most one frame. */
    private tick(): void {
        if (this.silenceToSend > 0) {
            this.send(silenceFrame());
            this.silenceToSend--;
            if (this.silenceToSend > 0) return;
            if (this.finishing) this.finish('finished');
            else if (this.isPaused) this.stopTimer();
            return;
        }
        if (this.isPaused) {
            this.stopTimer();
            return;
        }

        if (
            this.pcmBytes >= PCM_FRAME_BYTES ||
            (this.sourceDone && this.pcmBytes > 0)
        ) {
            this.send(this.encoder.encode(this.takeFrame()));
            this.framesSent++;
            if (this.stdoutPaused && this.pcmBytes < LOW_WATER_BYTES) {
                this.stdoutPaused = false;
                this.ffmpeg?.stdout?.resume();
            }
            return;
        }

        if (this.sourceDone) {
            // Drained: a short silence tail, then `finished`.
            this.finishing = true;
            this.silenceToSend = SILENCE_TAIL_FRAMES;
            this.tick();
            return;
        }

        // Underrun: wait for the prebuffer to refill.
        logger.debug(`[Music] Buffer underrun for ${this.track.url}`);
        this.buffering = true;
        this.stopTimer();
    }

    /** Pops one frame of PCM, zero-padding the last partial frame. */
    private takeFrame(): Buffer {
        const frame = Buffer.alloc(PCM_FRAME_BYTES);
        let filled = 0;
        while (filled < PCM_FRAME_BYTES && this.pcm.length > 0) {
            const head = this.pcm[0];
            const n = Math.min(head.length, PCM_FRAME_BYTES - filled);
            head.copy(frame, filled, 0, n);
            filled += n;
            if (n === head.length) this.pcm.shift();
            else this.pcm[0] = head.subarray(n);
        }
        this.pcmBytes -= filled;
        return frame;
    }

    private send(packet: OpusPacket): void {
        try {
            this.sink(packet);
        } catch (err) {
            logger.debug(
                `[Music] Sink threw: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    private finish(reason: PlaybackEndReason, err?: Error): void {
        if (this.ended) return;
        this.ended = true;
        this.stopTimer();
        this.pcm = [];
        this.pcmBytes = 0;
        this.killChildren();
        this.emit('end', reason, err);
    }

    /** SIGTERM both children, SIGKILL whichever is still alive after a grace period. */
    private killChildren(): void {
        for (const child of [this.ytDlp, this.ffmpeg]) {
            if (!child || !isRunning(child)) continue;
            try {
                child.kill('SIGTERM');
            } catch {
                // already gone
            }
            const killTimer = setTimeout(() => {
                this.killTimers.delete(killTimer);
                if (isRunning(child)) {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        // already gone
                    }
                }
            }, KILL_GRACE_MS);
            killTimer.unref?.();
            this.killTimers.add(killTimer);
            child.once('close', () => {
                clearTimeout(killTimer);
                this.killTimers.delete(killTimer);
            });
        }
    }
}
