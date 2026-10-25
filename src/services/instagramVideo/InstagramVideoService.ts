/**
 * Instagram video re-hosting (issue #45).
 *
 * Downloads the video of a public Instagram post with `yt-dlp` and, when it
 * is larger than the upload limit, re-encodes it with `ffmpeg` so it fits.
 * The caller uploads the result as a regular attachment, so the video plays
 * inline on both platforms.
 *
 * Only public posts are fetched: no cookies, credentials or login are ever
 * passed to yt-dlp (`--ignore-config` also keeps a stray config file from
 * adding some). Private, login-only and age-restricted posts, image posts and
 * anything else yt-dlp cannot download anonymously are skipped. Every job runs
 * in its own temp directory, which is removed afterwards.
 */

import { spawn } from 'child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import logger from '../../utils/logging/logger';
import { InstagramLink, instagramShortcode } from './instagramLinks';

export interface InstagramVideo {
    /** File name to upload, e.g. "instagram-ABC123.mp4"; prefixed "SPOILER_" when link.spoiler. */
    name: string;
    data: Buffer;
    spoiler: boolean;
    sourceUrl: string;
}

export interface InstagramVideoOptions {
    /** The final file must be at most this many bytes. */
    maxBytes: number;
    /** Longer videos are skipped. */
    maxDurationSeconds: number;
    /** Time limit for each external process. */
    timeoutMs: number;
    /** Simultaneous downloads; extra jobs queue. */
    maxConcurrent: number;
    /** Defaults to `yt-dlp`. */
    ytDlpPath?: string;
    /** Defaults to `ffmpeg`. */
    ffmpegPath?: string;
    /** Defaults to `ffprobe`. */
    ffprobePath?: string;
}

/** Runs an external command; resolves with stdout/stderr/exit code, rejects on spawn error (e.g. ENOENT) or timeout. */
export type CommandRunner = (
    command: string,
    args: string[],
    options: { timeoutMs: number }
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/**
 * yt-dlp format choice: mp4/h264 with m4a audio where offered (plays
 * everywhere and usually needs no re-encode), anything else as a fallback.
 */
export const YT_DLP_FORMAT = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';

/** Below this video bitrate (kbps) a re-encode is unwatchable; give up. */
export const MIN_VIDEO_KBPS = 100;

/** Share of the size budget the encoder may use; leaves room for overhead. */
const SIZE_MARGIN = 0.92;

/** Encoder settings for the first try and the single retry. */
const ENCODE_ATTEMPTS: ReadonlyArray<{
    bitrateFactor: number;
    maxHeight: number;
    audioKbps: number;
}> = [
    { bitrateFactor: 1, maxHeight: 720, audioKbps: 96 },
    { bitrateFactor: 0.75, maxHeight: 480, audioKbps: 64 },
];

/** Most of a process's output that is kept (it only ends up in logs). */
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Video bitrate in kbps that makes a `durationSeconds` long video with
 * `audioKbps` audio fit in `maxBytes`, keeping {@link SIZE_MARGIN} of the
 * budget. Can be zero or negative when the audio alone would not fit.
 */
export function compressionBitrate(
    maxBytes: number,
    durationSeconds: number,
    audioKbps: number,
    margin = SIZE_MARGIN
): number {
    const totalKbps = ((maxBytes * 8) / 1000 / durationSeconds) * margin;
    return Math.floor(totalKbps - audioKbps);
}

/** Default {@link CommandRunner}: `child_process.spawn`, killed on timeout. */
export const spawnRunner: CommandRunner = (command, args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            const error = new Error(
                `${command} timed out after ${timeoutMs} ms`
            ) as NodeJS.ErrnoException;
            error.code = 'ETIMEDOUT';
            reject(error);
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            resolve({ stdout, stderr, code });
        });
    });

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

export default class InstagramVideoService {
    private readonly options: InstagramVideoOptions;
    private readonly runner: CommandRunner;
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    private warnedMissingTool = false;

    constructor(
        options: InstagramVideoOptions,
        runner: CommandRunner = spawnRunner
    ) {
        this.options = options;
        this.runner = runner;
    }

    /** Downloads the post's video, compressing it to fit maxBytes if needed. Null when the post has no video, is private/login/age-gated, too long, can't be made to fit, or the tools are missing. Never throws. */
    async fetchVideo(link: InstagramLink): Promise<InstagramVideo | null> {
        await this.acquire();
        try {
            return await this.download(link);
        } catch (error) {
            this.logFailure(link, error);
            return null;
        } finally {
            this.release();
        }
    }

    /** Waits for a free download slot (FIFO). */
    private acquire(): Promise<void> {
        const limit = Math.max(1, this.options.maxConcurrent);
        if (this.active < limit) {
            this.active++;
            return Promise.resolve();
        }
        // The releasing job hands its slot over, so `active` stays the same.
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
    }

    private async download(
        link: InstagramLink
    ): Promise<InstagramVideo | null> {
        const dir = await mkdtemp(path.join(tmpdir(), 'bifrost-instagram-'));
        try {
            const file = await this.runYtDlp(link, dir);
            if (!file) return null;

            const size = (await stat(file)).size;
            let output = file;
            if (size > this.options.maxBytes) {
                const compressed = await this.compress(link, file, dir);
                if (!compressed) return null;
                output = compressed;
            }

            const data = await readFile(output);
            const code = instagramShortcode(link.url) ?? 'video';
            const ext = path.extname(output) || '.mp4';
            const name = `${link.spoiler ? 'SPOILER_' : ''}instagram-${code}${ext}`;
            return { name, data, spoiler: link.spoiler, sourceUrl: link.url };
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(
                () => undefined
            );
        }
    }

    /** Downloads the post's first video into `dir`; its path, or null. */
    private async runYtDlp(
        link: InstagramLink,
        dir: string
    ): Promise<string | null> {
        const args = [
            '--ignore-config',
            '--no-cache-dir',
            '--playlist-items',
            '1',
            '--no-warnings',
            '--no-progress',
            '--no-mtime',
            '--match-filter',
            `duration <=? ${this.options.maxDurationSeconds}`,
            '-f',
            YT_DLP_FORMAT,
            '--merge-output-format',
            'mp4',
            '-o',
            path.join(dir, 'video.%(ext)s'),
            '--',
            link.url,
        ];
        const result = await this.runner(
            this.options.ytDlpPath ?? 'yt-dlp',
            args,
            { timeoutMs: this.options.timeoutMs }
        );
        if (result.code !== 0) {
            logger.info(
                `Instagram: no video for ${link.url} (yt-dlp exit ${result.code}): ${stderrExcerpt(result.stderr)}`
            );
            return null;
        }

        const files = (await readdir(dir)).filter(
            (name) =>
                name.startsWith('video.') &&
                !name.endsWith('.part') &&
                !name.endsWith('.ytdl')
        );
        if (files.length === 0) {
            // The match filter skipped it (too long) or there was no video.
            logger.info(
                `Instagram: nothing downloaded for ${link.url} (no video or longer than ${this.options.maxDurationSeconds}s)`
            );
            return null;
        }
        return path.join(dir, files[0]);
    }

    /** Re-encodes `input` to fit maxBytes; the new file's path, or null. */
    private async compress(
        link: InstagramLink,
        input: string,
        dir: string
    ): Promise<string | null> {
        const duration = await this.probeDuration(input);
        if (duration === null) {
            logger.warn(
                `Instagram: could not read the duration of ${link.url}`
            );
            return null;
        }
        if (duration > this.options.maxDurationSeconds) {
            logger.info(
                `Instagram: ${link.url} is ${Math.round(duration)}s long, over the ${this.options.maxDurationSeconds}s limit`
            );
            return null;
        }

        for (let i = 0; i < ENCODE_ATTEMPTS.length; i++) {
            const attempt = ENCODE_ATTEMPTS[i];
            const videoKbps = Math.floor(
                compressionBitrate(
                    this.options.maxBytes,
                    duration,
                    attempt.audioKbps
                ) * attempt.bitrateFactor
            );
            if (videoKbps < MIN_VIDEO_KBPS) {
                logger.info(
                    `Instagram: ${link.url} cannot fit in ${this.options.maxBytes} bytes (${videoKbps} kbps video)`
                );
                return null;
            }

            const output = path.join(dir, `compressed-${i}.mp4`);
            const result = await this.runner(
                this.options.ffmpegPath ?? 'ffmpeg',
                encodeArgs(
                    input,
                    output,
                    videoKbps,
                    attempt.audioKbps,
                    attempt.maxHeight
                ),
                { timeoutMs: this.options.timeoutMs }
            );
            if (result.code !== 0) {
                logger.warn(
                    `Instagram: ffmpeg failed for ${link.url} (exit ${result.code}): ${stderrExcerpt(result.stderr)}`
                );
                return null;
            }

            const size = await stat(output)
                .then((s) => s.size)
                .catch(() => null);
            if (size !== null && size <= this.options.maxBytes) return output;
        }

        logger.info(
            `Instagram: ${link.url} is still over ${this.options.maxBytes} bytes after compressing`
        );
        return null;
    }

    /** Length of the video in seconds, or null when ffprobe can't tell. */
    private async probeDuration(file: string): Promise<number | null> {
        const result = await this.runner(
            this.options.ffprobePath ?? 'ffprobe',
            [
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                file,
            ],
            { timeoutMs: this.options.timeoutMs }
        );
        if (result.code !== 0) return null;
        const duration = parseFloat(result.stdout.trim());
        return Number.isFinite(duration) && duration > 0 ? duration : null;
    }

    /** Logs an unexpected failure; a missing tool is reported only once. */
    private logFailure(link: InstagramLink, error: unknown): void {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') {
            if (!this.warnedMissingTool) {
                this.warnedMissingTool = true;
                logger.warn(
                    'Instagram: yt-dlp, ffmpeg or ffprobe is not installed; Instagram videos are not re-hosted'
                );
            }
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Instagram: failed to fetch ${link.url}: ${message}`);
    }
}

/**
 * ffmpeg arguments for an H.264/AAC mp4 at `videoKbps`, scaled down to at
 * most `maxHeight` (keeping the aspect ratio, even dimensions), with the
 * index up front so playback can start before the download ends.
 */
export function encodeArgs(
    input: string,
    output: string,
    videoKbps: number,
    audioKbps: number,
    maxHeight: number
): string[] {
    return [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        `scale=-2:'min(${maxHeight},trunc(ih/2)*2)'`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        `${videoKbps}k`,
        '-maxrate',
        `${videoKbps}k`,
        '-bufsize',
        `${videoKbps * 2}k`,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        `${audioKbps}k`,
        '-movflags',
        '+faststart',
        output,
    ];
}
