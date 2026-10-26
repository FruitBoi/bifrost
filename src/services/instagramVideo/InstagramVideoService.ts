/**
 * Instagram post re-hosting (issues #45 and #48).
 *
 * Fetches a public post's media (video, image or carousel), caption and
 * author from Instagram's public embed page,
 * `https://www.instagram.com/p/<code>/embed/captioned/` (the page Instagram
 * serves for third-party embeds; see `instagramEmbedPage.ts`), then downloads
 * the media files from Instagram's CDN. The caller uploads them as regular
 * attachments, so videos play inline on both platforms.
 *
 * Only public data is used: a plain GET with an honest user agent, no
 * cookies, logins, tokens or private API calls. Media URLs come from a remote
 * page, so only https URLs on Instagram/Facebook CDN hosts are downloaded
 * (redirects are checked too), each with a byte cap and a time limit.
 *
 * All files of a post together must fit in `maxBytes`. They are taken in
 * post order: an image that does not fit what is left is skipped, and a video
 * that does not fit is re-encoded with `ffmpeg` to fit it (or skipped).
 *
 * When the embed page yields no usable media (fetch failed, no post data, a
 * video without a video URL, ...), the post's video is downloaded with
 * `yt-dlp` instead, as before. No cookies or credentials are ever passed to
 * it either (`--ignore-config` also keeps a stray config file from adding
 * some). Every job runs in its own temp directory, which is removed
 * afterwards.
 */

import { spawn } from 'child_process';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import logger from '../../utils/logging/logger';
import {
    InstagramEmbedMedia,
    InstagramEmbedPost,
    isInstagramCdnUrl,
    parseInstagramEmbedPage,
} from './instagramEmbedPage';
import { InstagramLink, instagramShortcode } from './instagramLinks';

export interface InstagramMediaFile {
    /** e.g. "instagram-ABC123.mp4", "instagram-ABC123-2.jpg"; prefixed "SPOILER_" when the link is a spoiler. */
    name: string;
    data: Buffer;
    kind: 'video' | 'image';
}

export interface InstagramPost {
    /** The canonical link (InstagramLink.url). */
    sourceUrl: string;
    spoiler: boolean;
    /** Author username without "@", or null when unknown (yt-dlp fallback). */
    username: string | null;
    /** Author profile picture URL from the embed data, or null. */
    profilePicUrl: string | null;
    /** Post caption as plain text (may contain newlines), or null/empty when none. */
    caption: string | null;
    /** 1..10 files, in post order; their total size is <= options.maxBytes. */
    files: InstagramMediaFile[];
}

export interface InstagramVideoOptions {
    /** All files of a post together must be at most this many bytes. */
    maxBytes: number;
    /** Longer videos are skipped. */
    maxDurationSeconds: number;
    /** Time limit for each external process and each HTTP request. */
    timeoutMs: number;
    /** Simultaneous posts being fetched; extra jobs queue. */
    maxConcurrent: number;
    /** Defaults to `yt-dlp`. */
    ytDlpPath?: string;
    /** Defaults to `ffmpeg`. */
    ffmpegPath?: string;
    /** Defaults to `ffprobe`. */
    ffprobePath?: string;
    /** Largest video downloaded from the CDN before compressing; defaults to {@link DEFAULT_MAX_DOWNLOAD_BYTES}. */
    maxDownloadBytes?: number;
    /** HTTP client; defaults to the global `fetch` (injected by tests). */
    fetchImpl?: typeof fetch;
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

/** User agent for every request: says who we are, pretends nothing. */
export const INSTAGRAM_USER_AGENT =
    'Mozilla/5.0 (compatible; Bifrost/1.0; +https://github.com/FruitBoi/bifrost)';

/** Most of the embed page that is read. */
export const MAX_EMBED_PAGE_BYTES = 3 * 1024 * 1024;

/** Default for {@link InstagramVideoOptions.maxDownloadBytes}. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

/** Most files in one post (Instagram carousels hold up to 10, as do messages). */
export const MAX_POST_FILES = 10;

/** Most redirects followed for one media download. */
const MAX_REDIRECTS = 3;

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

/** Image extensions kept as they are; anything else is saved as jpg. */
const IMAGE_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/** The embed page URL for a shortcode (works for posts, reels and tv). */
export function instagramEmbedUrl(shortcode: string): string {
    return `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
}

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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The host of a URL for log lines, or a placeholder. */
function hostOf(url: string): string {
    try {
        return new URL(url).host || '(no host)';
    } catch {
        return '(invalid URL)';
    }
}

/** Discards a response body we are not going to read. */
async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/** The body if it is at most `cap` bytes, else null (stops reading at the cap). */
async function readCapped(
    response: Response,
    cap: number
): Promise<Buffer | null> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > cap) {
        await discardBody(response);
        return null;
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/** Streams the body into `file`; its size, or null when over `cap` bytes. */
async function streamToFile(
    response: Response,
    file: string,
    cap: number
): Promise<number | null> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > cap) {
        await discardBody(response);
        return null;
    }
    const handle = await open(file, 'w');
    try {
        if (!response.body) return 0;
        const reader = response.body.getReader();
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > cap) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            await handle.write(value);
        }
        return total;
    } finally {
        await handle.close();
    }
}

/** File extension for a downloaded image, from its content type or URL. */
function imageExtension(contentType: string, url: string): string {
    const type = contentType.split(';')[0].trim().toLowerCase();
    if (IMAGE_TYPES[type]) return IMAGE_TYPES[type];
    let pathname = '';
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        // Keep the default below.
    }
    const ext = /\.(jpe?g|png|webp|gif)$/.exec(pathname)?.[1];
    if (!ext) return 'jpg';
    return ext === 'jpeg' ? 'jpg' : ext;
}

/** A media file of a post before it is named. */
interface CollectedFile {
    data: Buffer;
    kind: 'video' | 'image';
    /** Extension without the dot. */
    ext: string;
}

type MediaDownload =
    | { status: 'ok'; size: number; contentType: string }
    | { status: 'too-big' }
    | { status: 'failed'; reason: string };

/** Result of one embed item: a file, skipped for the size budget, or skipped otherwise. */
type ItemResult = CollectedFile | 'budget' | null;

export default class InstagramVideoService {
    private readonly options: InstagramVideoOptions;
    private readonly runner: CommandRunner;
    private readonly fetchImpl: typeof fetch;
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    private warnedMissingTool = false;

    constructor(
        options: InstagramVideoOptions,
        runner: CommandRunner = spawnRunner
    ) {
        this.options = options;
        this.runner = runner;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    }

    /**
     * Fetches the post's media (all of it fitting in maxBytes), caption and
     * author from the embed page, falling back to the post's video via
     * yt-dlp. Null when nothing could be fetched or nothing fits (private,
     * login/age-gated, too long, tools missing, ...). Never throws.
     */
    async fetchPost(link: InstagramLink): Promise<InstagramPost | null> {
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

    private async download(link: InstagramLink): Promise<InstagramPost | null> {
        const code = instagramShortcode(link.url);
        const dir = await mkdtemp(path.join(tmpdir(), 'bifrost-instagram-'));
        try {
            const page = code ? await this.fetchEmbedPage(link, code) : null;
            if (page && page.items.length > 0) {
                const { files, budgetSkipped } = await this.downloadItems(
                    link,
                    page.items,
                    dir
                );
                if (files.length > 0) {
                    return this.makePost(link, code, files, page);
                }
                if (budgetSkipped) {
                    logger.info(
                        `Instagram: nothing from ${link.url} fits in ${this.options.maxBytes} bytes`
                    );
                    return null;
                }
            }

            const video = await this.downloadWithYtDlp(link, dir);
            return video ? this.makePost(link, code, [video], page) : null;
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(
                () => undefined
            );
        }
    }

    /** Names the files and adds the author and caption the page gave, if any. */
    private makePost(
        link: InstagramLink,
        code: string | null,
        files: CollectedFile[],
        page: InstagramEmbedPost | null
    ): InstagramPost {
        const prefix = `${link.spoiler ? 'SPOILER_' : ''}instagram-${code ?? 'post'}`;
        const profilePicUrl = page?.profilePicUrl ?? null;
        return {
            sourceUrl: link.url,
            spoiler: link.spoiler,
            username: page?.username ?? null,
            profilePicUrl:
                profilePicUrl && isInstagramCdnUrl(profilePicUrl)
                    ? profilePicUrl
                    : null,
            caption: page?.caption ?? null,
            files: files.map((file, index) => ({
                name: `${prefix}${files.length > 1 ? `-${index + 1}` : ''}.${file.ext}`,
                data: file.data,
                kind: file.kind,
            })),
        };
    }

    /** The parsed embed page of the post, or null when it can't be loaded. */
    private async fetchEmbedPage(
        link: InstagramLink,
        code: string
    ): Promise<InstagramEmbedPost | null> {
        try {
            const response = await this.fetchImpl(instagramEmbedUrl(code), {
                headers: {
                    'User-Agent': INSTAGRAM_USER_AGENT,
                    Accept: 'text/html',
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            if (response.status !== 200) {
                await discardBody(response);
                logger.info(
                    `Instagram: embed page for ${link.url} returned HTTP ${response.status}`
                );
                return null;
            }
            const body = await readCapped(response, MAX_EMBED_PAGE_BYTES);
            if (!body) {
                logger.info(
                    `Instagram: embed page for ${link.url} is over ${MAX_EMBED_PAGE_BYTES} bytes`
                );
                return null;
            }
            const page = parseInstagramEmbedPage(body.toString('utf8'));
            if (!page) {
                logger.info(
                    `Instagram: embed page for ${link.url} has no post data`
                );
            } else if (page.items.length === 0) {
                logger.info(
                    `Instagram: embed page for ${link.url} has no usable media (${page.mediaType ?? 'unknown type'})`
                );
            }
            return page;
        } catch (error) {
            logger.info(
                `Instagram: could not load the embed page for ${link.url}: ${errorMessage(error)}`
            );
            return null;
        }
    }

    /** Downloads the page's media in post order within the size budget. */
    private async downloadItems(
        link: InstagramLink,
        items: InstagramEmbedMedia[],
        dir: string
    ): Promise<{ files: CollectedFile[]; budgetSkipped: boolean }> {
        const files: CollectedFile[] = [];
        let remaining = this.options.maxBytes;
        let budgetSkipped = false;

        for (
            let i = 0;
            i < items.length && files.length < MAX_POST_FILES;
            i++
        ) {
            const item = items[i];
            const label = `${link.url} (item ${i + 1})`;
            if (
                item.kind === 'video' &&
                item.durationSeconds !== null &&
                item.durationSeconds > this.options.maxDurationSeconds
            ) {
                logger.info(
                    `Instagram: ${label} is ${Math.round(item.durationSeconds)}s long, over the ${this.options.maxDurationSeconds}s limit`
                );
                continue;
            }

            let result: ItemResult;
            try {
                result = await this.downloadItem(
                    link,
                    label,
                    item,
                    i,
                    dir,
                    remaining
                );
            } catch (error) {
                this.logItemFailure(label, error);
                continue;
            }
            if (result === 'budget') {
                budgetSkipped = true;
            } else if (result) {
                files.push(result);
                remaining -= result.data.length;
            }
        }
        return { files, budgetSkipped };
    }

    /** Downloads one item (compressing a video to fit `remaining` bytes). */
    private async downloadItem(
        link: InstagramLink,
        label: string,
        item: InstagramEmbedMedia,
        index: number,
        dir: string,
        remaining: number
    ): Promise<ItemResult> {
        if (remaining <= 0) return 'budget';
        const cap =
            item.kind === 'image'
                ? remaining
                : (this.options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES);
        const file = path.join(dir, `media-${index}`);

        const result = await this.downloadMedia(item.url, file, cap);
        if (result.status === 'failed') {
            logger.info(`Instagram: skipped ${label}: ${result.reason}`);
            return null;
        }
        if (result.status === 'too-big') {
            if (item.kind === 'image') {
                logger.info(
                    `Instagram: skipped ${label}: image does not fit in the ${remaining} bytes left`
                );
                return 'budget';
            }
            logger.info(
                `Instagram: skipped ${label}: video is over ${cap} bytes`
            );
            return null;
        }
        if (result.size === 0) {
            logger.info(`Instagram: skipped ${label}: empty download`);
            return null;
        }

        if (item.kind === 'image') {
            return {
                data: await readFile(file),
                kind: 'image',
                ext: imageExtension(result.contentType, item.url),
            };
        }

        let output = file;
        if (result.size > remaining) {
            const compressed = await this.compress(
                link,
                file,
                dir,
                remaining,
                `${index}`
            );
            if (!compressed) return 'budget';
            output = compressed;
        }
        return { data: await readFile(output), kind: 'video', ext: 'mp4' };
    }

    /**
     * Downloads a CDN media URL into `file`, at most `cap` bytes. Every URL,
     * including redirect targets, must pass {@link isInstagramCdnUrl}.
     */
    private async downloadMedia(
        url: string,
        file: string,
        cap: number
    ): Promise<MediaDownload> {
        const signal = AbortSignal.timeout(this.options.timeoutMs);
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!isInstagramCdnUrl(current)) {
                return {
                    status: 'failed',
                    reason: `refused media URL on ${hostOf(current)} (not an Instagram CDN)`,
                };
            }
            const response = await this.fetchImpl(current, {
                headers: { 'User-Agent': INSTAGRAM_USER_AGENT },
                redirect: 'manual',
                signal,
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                await discardBody(response);
                if (!location) {
                    return {
                        status: 'failed',
                        reason: `HTTP ${response.status} without a location`,
                    };
                }
                current = new URL(location, current).toString();
                continue;
            }
            if (response.status !== 200) {
                await discardBody(response);
                return { status: 'failed', reason: `HTTP ${response.status}` };
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (/^\s*(text\/|application\/json)/i.test(contentType)) {
                await discardBody(response);
                return {
                    status: 'failed',
                    reason: `unexpected content type ${contentType}`,
                };
            }
            const size = await streamToFile(response, file, cap);
            return size === null
                ? { status: 'too-big' }
                : { status: 'ok', size, contentType };
        }
        return { status: 'failed', reason: 'too many redirects' };
    }

    /** The post's video via yt-dlp, compressed to fit maxBytes; or null. */
    private async downloadWithYtDlp(
        link: InstagramLink,
        dir: string
    ): Promise<CollectedFile | null> {
        const file = await this.runYtDlp(link, dir);
        if (!file) return null;

        const size = (await stat(file)).size;
        let output = file;
        if (size > this.options.maxBytes) {
            const compressed = await this.compress(
                link,
                file,
                dir,
                this.options.maxBytes,
                'ytdlp'
            );
            if (!compressed) return null;
            output = compressed;
        }

        const data = await readFile(output);
        const ext = path.extname(output).slice(1) || 'mp4';
        return { data, kind: 'video', ext };
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

    /**
     * Re-encodes `input` to fit `maxBytes`; the new file's path, or null.
     * `tag` keeps the output names of different inputs in `dir` apart.
     */
    private async compress(
        link: InstagramLink,
        input: string,
        dir: string,
        maxBytes: number,
        tag: string
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
                compressionBitrate(maxBytes, duration, attempt.audioKbps) *
                    attempt.bitrateFactor
            );
            if (videoKbps < MIN_VIDEO_KBPS) {
                logger.info(
                    `Instagram: ${link.url} cannot fit in ${maxBytes} bytes (${videoKbps} kbps video)`
                );
                return null;
            }

            const output = path.join(dir, `compressed-${tag}-${i}.mp4`);
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
            if (size !== null && size <= maxBytes) return output;
        }

        logger.info(
            `Instagram: ${link.url} is still over ${maxBytes} bytes after compressing`
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

    /** Warns that a tool is missing, once per service. */
    private warnMissingTool(): void {
        if (this.warnedMissingTool) return;
        this.warnedMissingTool = true;
        logger.warn(
            'Instagram: yt-dlp, ffmpeg or ffprobe is not installed; Instagram videos may not be re-hosted'
        );
    }

    /** Logs why one media item of a post failed; the others still go ahead. */
    private logItemFailure(label: string, error: unknown): void {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            this.warnMissingTool();
            return;
        }
        logger.warn(
            `Instagram: failed to fetch ${label}: ${errorMessage(error)}`
        );
    }

    /** Logs an unexpected failure; a missing tool is reported only once. */
    private logFailure(link: InstagramLink, error: unknown): void {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            this.warnMissingTool();
            return;
        }
        logger.warn(
            `Instagram: failed to fetch ${link.url}: ${errorMessage(error)}`
        );
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
