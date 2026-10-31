/**
 * Twitter/X post re-hosting (issue #56), a sibling of the Instagram service.
 *
 * Fetches a public tweet's text, author and media (photos, videos, GIFs) from
 * Twitter's public syndication endpoint (see `tweetSyndication.ts`), then
 * downloads the media files from Twitter's CDN. The caller posts a card and
 * uploads the files as regular attachments, so videos play inline.
 *
 * Only public data is used: a plain GET with an honest user agent, no
 * cookies, logins or API keys. Media URLs come from a remote response, so only
 * https URLs on `*.twimg.com` are downloaded (redirects are checked too), each
 * with a byte cap and a time limit.
 *
 * All files of a tweet together must fit in `maxBytes`. They are taken in
 * tweet order: an image whose large and medium renditions do not fit what is
 * left is skipped; for a video the mp4 variants are tried by falling bitrate,
 * and when none fits, the smallest one is re-encoded with `ffmpeg` to fit (or
 * skipped). A tweet whose media does not fit at all is still returned, with
 * the files that did fit (possibly none): the card alone is still useful. A
 * text-only tweet is returned with no files.
 *
 * Alias sites: links on hosts `twitterLinks.ts` does not know
 * (`knownHost: false`) are only accepted when Twitter's own data says the
 * tweet is by the user named in the link. The unknown host itself is never
 * contacted. Accepted hosts are remembered (see {@link discoveredHosts}) so
 * the caller can treat them as known. A host is rejected (and not checked
 * again) only when the tweet exists but is by someone else; a missing tweet
 * or a failed request is not held against it.
 *
 * Fallback: when the syndication data can't be loaded (network error, HTTP
 * 5xx/429, bad JSON; not when Twitter says the tweet is missing or not
 * public), or a tweet's videos all fail to download for reasons other than
 * size, the video is fetched with `yt-dlp` from the canonical x.com URL, as
 * for Instagram: no cookies or credentials, `--ignore-config`, and a duration
 * filter. Unknown-host links get no fallback: without the data they can't be
 * verified. Every job runs in its own temp directory, removed afterwards.
 */

import { mkdtemp, open, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import logger from '../../utils/logging/logger';
import {
    CommandRunner,
    MIN_VIDEO_KBPS,
    YT_DLP_FORMAT,
    compressionBitrate,
    encodeArgs,
    spawnRunner,
} from '../instagramVideo/InstagramVideoService';
import {
    SyndicatedTweet,
    TWITTER_USER_AGENT,
    TweetMedia,
    discardBody,
    fetchTweet,
    isTwitterCdnUrl,
} from './tweetSyndication';
import type { TweetLink } from './twitterLinks';

export type { CommandRunner } from '../instagramVideo/InstagramVideoService';
export { TWITTER_USER_AGENT } from './tweetSyndication';

export interface TwitterMediaFile {
    /** e.g. "twitter-123.mp4", "twitter-123-2.jpg"; prefixed "SPOILER_" when the link is a spoiler. */
    name: string;
    data: Buffer;
    kind: 'video' | 'image';
}

export interface TwitterPost {
    /** Canonical x.com link, with the author's real handle when the data has it. */
    sourceUrl: string;
    spoiler: boolean;
    /** Author handle without "@", or null when unknown. */
    username: string | null;
    /** Author display name, or null when unknown. */
    displayName: string | null;
    /** Author avatar URL on `*.twimg.com`, or null. */
    profilePicUrl: string | null;
    /** Tweet text as plain text (may contain newlines), or null when none/unknown. */
    text: string | null;
    /** 0..4 files in tweet order (empty for a text-only tweet); their total size is <= options.maxBytes. */
    files: TwitterMediaFile[];
}

export interface TwitterMediaOptions {
    /** All files of a tweet together must be at most this many bytes. */
    maxBytes: number;
    /** Longer videos are skipped. */
    maxDurationSeconds: number;
    /** Time limit for each external process and each HTTP request. */
    timeoutMs: number;
    /** Simultaneous tweets being fetched; extra jobs queue. */
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

/** Default for {@link TwitterMediaOptions.maxDownloadBytes}. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

/** Most hosts remembered in each of the discovered and rejected sets. */
export const MAX_REMEMBERED_HOSTS = 500;

/** Most redirects followed for one media download. */
const MAX_REDIRECTS = 3;

/** Encoder settings for the first try and the single retry. */
const ENCODE_ATTEMPTS: ReadonlyArray<{
    bitrateFactor: number;
    maxHeight: number;
    audioKbps: number;
}> = [
    { bitrateFactor: 1, maxHeight: 720, audioKbps: 96 },
    { bitrateFactor: 0.75, maxHeight: 480, audioKbps: 64 },
];

/** Image extensions kept as they are; anything else is saved as jpg. */
const IMAGE_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

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

/** Adds `value` to `set`, dropping the oldest entry beyond `max`. */
function remember(set: Set<string>, value: string, max: number): void {
    set.add(value);
    while (set.size > max) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
    }
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
    let parsed: URL | null = null;
    try {
        parsed = new URL(url);
    } catch {
        // Keep the default below.
    }
    const format = parsed?.searchParams.get('format')?.toLowerCase();
    const ext =
        format && /^(jpe?g|png|webp|gif)$/.test(format)
            ? format
            : /\.(jpe?g|png|webp|gif)$/.exec(
                  parsed?.pathname.toLowerCase() ?? ''
              )?.[1];
    if (!ext) return 'jpg';
    return ext === 'jpeg' ? 'jpg' : ext;
}

/** A media file of a tweet before it is named. */
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

/** Result of one media item: a file, skipped for the size budget, or failed. */
type ItemResult = CollectedFile | 'budget' | null;

export default class TwitterMediaService {
    private readonly options: TwitterMediaOptions;
    private readonly runner: CommandRunner;
    private readonly fetchImpl: typeof fetch;
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    private warnedMissingTool = false;
    private readonly discovered = new Set<string>();
    private readonly rejected = new Set<string>();

    constructor(
        options: TwitterMediaOptions,
        runner: CommandRunner = spawnRunner
    ) {
        this.options = options;
        this.runner = runner;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    }

    /** Hosts verified as Twitter aliases at runtime (lower-case). */
    discoveredHosts(): ReadonlySet<string> {
        return this.discovered;
    }

    /**
     * Fetches the tweet's text, author and media (all of it fitting in
     * maxBytes), falling back to its video via yt-dlp when Twitter's data
     * can't be loaded. Null when the tweet is missing or not public, nothing
     * could be fetched, or an unknown-host link fails verification. Never
     * throws.
     */
    async fetchPost(link: TweetLink): Promise<TwitterPost | null> {
        const host = link.host.toLowerCase();
        const unverified = !link.knownHost && !this.discovered.has(host);
        if (unverified && this.rejected.has(host)) return null;

        await this.acquire();
        try {
            return await this.download(link, unverified);
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
        link: TweetLink,
        unverified: boolean
    ): Promise<TwitterPost | null> {
        const host = link.host.toLowerCase();
        if (unverified && !link.username) {
            // Nothing to check the data against; not evidence either way.
            logger.info(
                `Twitter: cannot verify ${host} from a link without a username`
            );
            return null;
        }

        const result = await fetchTweet(link.id, {
            fetchImpl: this.fetchImpl,
            timeoutMs: this.options.timeoutMs,
        });

        if (unverified) {
            if (result.status !== 'ok') {
                // A transient failure, or a deleted or protected tweet on what
                // may well be an alias: not evidence either way, so the host
                // is not rejected; this link is just skipped.
                logger.info(
                    `Twitter: could not verify ${host} (tweet ${link.id}): ${
                        result.status === 'failed'
                            ? result.reason
                            : 'tweet does not exist or is not public'
                    }`
                );
                return null;
            }
            const { screenName } = result.tweet;
            if (
                !screenName ||
                screenName.toLowerCase() !== link.username!.toLowerCase()
            ) {
                remember(this.rejected, host, MAX_REMEMBERED_HOSTS);
                logger.info(
                    `Twitter: ${host} is not a Twitter alias (tweet ${link.id} is by @${screenName ?? 'nobody'}, not @${link.username})`
                );
                return null;
            }
            if (!this.discovered.has(host)) {
                remember(this.discovered, host, MAX_REMEMBERED_HOSTS);
                this.rejected.delete(host);
                logger.info(`Twitter: discovered alias host ${host}`);
            }
        }

        if (result.status === 'missing') {
            logger.info(`Twitter: ${link.url} does not exist or is not public`);
            return null;
        }

        const dir = await mkdtemp(path.join(tmpdir(), 'bifrost-twitter-'));
        try {
            if (result.status === 'failed') {
                logger.info(
                    `Twitter: could not load the data for ${link.url}: ${result.reason}`
                );
                const video = await this.downloadWithYtDlp(link, dir);
                return video ? this.makePost(link, [video], null) : null;
            }

            const tweet = result.tweet;
            const { files, budgetSkipped, videoFailed } =
                await this.downloadItems(link, tweet.media, dir);
            if (files.length === 0 && videoFailed && !budgetSkipped) {
                // We have the tweet, so a failing fallback still leaves the card.
                try {
                    const video = await this.downloadWithYtDlp(link, dir);
                    if (video) files.push(video);
                } catch (error) {
                    this.logItemFailure(`${link.url} (yt-dlp)`, error);
                }
            }
            if (budgetSkipped) {
                logger.info(
                    `Twitter: some media of ${link.url} did not fit in ${this.options.maxBytes} bytes; posted ${files.length} file(s)`
                );
            }
            return this.makePost(link, files, tweet);
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(
                () => undefined
            );
        }
    }

    /** Names the files and adds the author and text the data gave, if any. */
    private makePost(
        link: TweetLink,
        files: CollectedFile[],
        tweet: SyndicatedTweet | null
    ): TwitterPost {
        const prefix = `${link.spoiler ? 'SPOILER_' : ''}twitter-${link.id}`;
        const username = tweet?.screenName ?? link.username;
        const profilePicUrl = tweet?.profileImageUrl ?? null;
        return {
            sourceUrl: `https://x.com/${username ?? 'i'}/status/${link.id}`,
            spoiler: link.spoiler,
            username,
            displayName: tweet?.name ?? null,
            profilePicUrl:
                profilePicUrl && isTwitterCdnUrl(profilePicUrl)
                    ? profilePicUrl
                    : null,
            text: tweet?.text ?? null,
            files: files.map((file, index) => ({
                name: `${prefix}${files.length > 1 ? `-${index + 1}` : ''}.${file.ext}`,
                data: file.data,
                kind: file.kind,
            })),
        };
    }

    /** Downloads the tweet's media in order within the size budget. */
    private async downloadItems(
        link: TweetLink,
        items: TweetMedia[],
        dir: string
    ): Promise<{
        files: CollectedFile[];
        budgetSkipped: boolean;
        videoFailed: boolean;
    }> {
        const files: CollectedFile[] = [];
        let remaining = this.options.maxBytes;
        let budgetSkipped = false;
        let videoFailed = false;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const label = `${link.url} (item ${i + 1})`;
            if (
                item.kind === 'video' &&
                item.durationSeconds !== null &&
                item.durationSeconds > this.options.maxDurationSeconds
            ) {
                logger.info(
                    `Twitter: ${label} is ${Math.round(item.durationSeconds)}s long, over the ${this.options.maxDurationSeconds}s limit`
                );
                continue;
            }

            let result: ItemResult;
            try {
                result =
                    item.kind === 'image'
                        ? await this.downloadImage(
                              label,
                              item,
                              i,
                              dir,
                              remaining
                          )
                        : await this.downloadVideo(
                              link,
                              label,
                              item,
                              i,
                              dir,
                              remaining
                          );
            } catch (error) {
                this.logItemFailure(label, error);
                result = null;
            }
            if (result === 'budget') {
                budgetSkipped = true;
            } else if (result) {
                files.push(result);
                remaining -= result.data.length;
            } else if (item.kind === 'video') {
                videoFailed = true;
            }
        }
        return { files, budgetSkipped, videoFailed };
    }

    /** Downloads the largest rendition of an image that fits `remaining` bytes. */
    private async downloadImage(
        label: string,
        item: TweetMedia,
        index: number,
        dir: string,
        remaining: number
    ): Promise<ItemResult> {
        if (remaining <= 0) return 'budget';
        const file = path.join(dir, `media-${index}`);
        let tooBig = false;
        for (const url of item.urls) {
            const result = await this.downloadMedia(url, file, remaining);
            if (result.status === 'too-big') {
                tooBig = true;
                continue;
            }
            if (result.status === 'failed' || result.size === 0) {
                logger.info(
                    `Twitter: skipped ${label}: ${
                        result.status === 'failed'
                            ? result.reason
                            : 'empty download'
                    }`
                );
                return null;
            }
            return {
                data: await readFile(file),
                kind: 'image',
                ext: imageExtension(result.contentType, url),
            };
        }
        if (tooBig) {
            logger.info(
                `Twitter: skipped ${label}: image does not fit in the ${remaining} bytes left`
            );
            return 'budget';
        }
        return null;
    }

    /**
     * Downloads the best mp4 variant that fits `remaining` bytes; when none
     * does, re-encodes the smallest to fit (or gives up on the budget).
     */
    private async downloadVideo(
        link: TweetLink,
        label: string,
        item: TweetMedia,
        index: number,
        dir: string,
        remaining: number
    ): Promise<ItemResult> {
        if (remaining <= 0) return 'budget';
        const file = path.join(dir, `media-${index}`);
        let tooBig = false;
        for (const url of item.urls) {
            const result = await this.downloadMedia(url, file, remaining);
            if (result.status === 'too-big') {
                tooBig = true;
                continue;
            }
            if (result.status === 'failed' || result.size === 0) {
                logger.info(
                    `Twitter: ${label} variant failed: ${
                        result.status === 'failed'
                            ? result.reason
                            : 'empty download'
                    }`
                );
                continue;
            }
            return { data: await readFile(file), kind: 'video', ext: 'mp4' };
        }
        if (!tooBig) {
            logger.info(`Twitter: skipped ${label}: no variant downloaded`);
            return null;
        }

        // Every variant is over the budget: shrink the smallest one.
        const smallest = item.urls[item.urls.length - 1];
        const cap = this.options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
        const result = await this.downloadMedia(smallest, file, cap);
        if (result.status !== 'ok' || result.size === 0) {
            logger.info(
                `Twitter: skipped ${label}: ${
                    result.status === 'failed'
                        ? result.reason
                        : result.status === 'too-big'
                          ? `video is over ${cap} bytes`
                          : 'empty download'
                }`
            );
            return 'budget';
        }
        const compressed = await this.compress(
            link,
            file,
            dir,
            remaining,
            `${index}`
        );
        if (!compressed) return 'budget';
        return { data: await readFile(compressed), kind: 'video', ext: 'mp4' };
    }

    /**
     * Downloads a CDN media URL into `file`, at most `cap` bytes. Every URL,
     * including redirect targets, must pass {@link isTwitterCdnUrl}.
     */
    private async downloadMedia(
        url: string,
        file: string,
        cap: number
    ): Promise<MediaDownload> {
        const signal = AbortSignal.timeout(this.options.timeoutMs);
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!isTwitterCdnUrl(current)) {
                return {
                    status: 'failed',
                    reason: `refused media URL on ${hostOf(current)} (not a Twitter CDN)`,
                };
            }
            const response = await this.fetchImpl(current, {
                headers: { 'User-Agent': TWITTER_USER_AGENT },
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

    /** The tweet's video via yt-dlp, compressed to fit maxBytes; or null. */
    private async downloadWithYtDlp(
        link: TweetLink,
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

    /** Downloads the tweet's first video into `dir`; its path, or null. */
    private async runYtDlp(
        link: TweetLink,
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
                `Twitter: no video for ${link.url} (yt-dlp exit ${result.code}): ${stderrExcerpt(result.stderr)}`
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
                `Twitter: nothing downloaded for ${link.url} (no video or longer than ${this.options.maxDurationSeconds}s)`
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
        link: TweetLink,
        input: string,
        dir: string,
        maxBytes: number,
        tag: string
    ): Promise<string | null> {
        const duration = await this.probeDuration(input);
        if (duration === null) {
            logger.warn(`Twitter: could not read the duration of ${link.url}`);
            return null;
        }
        if (duration > this.options.maxDurationSeconds) {
            logger.info(
                `Twitter: ${link.url} is ${Math.round(duration)}s long, over the ${this.options.maxDurationSeconds}s limit`
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
                    `Twitter: ${link.url} cannot fit in ${maxBytes} bytes (${videoKbps} kbps video)`
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
                    `Twitter: ffmpeg failed for ${link.url} (exit ${result.code}): ${stderrExcerpt(result.stderr)}`
                );
                return null;
            }

            const size = await stat(output)
                .then((s) => s.size)
                .catch(() => null);
            if (size !== null && size <= maxBytes) return output;
        }

        logger.info(
            `Twitter: ${link.url} is still over ${maxBytes} bytes after compressing`
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
            'Twitter: yt-dlp, ffmpeg or ffprobe is not installed; Twitter videos may not be re-hosted'
        );
    }

    /** Logs why one media item of a tweet failed; the others still go ahead. */
    private logItemFailure(label: string, error: unknown): void {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            this.warnMissingTool();
            return;
        }
        logger.warn(
            `Twitter: failed to fetch ${label}: ${errorMessage(error)}`
        );
    }

    /** Logs an unexpected failure; a missing tool is reported only once. */
    private logFailure(link: TweetLink, error: unknown): void {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            this.warnMissingTool();
            return;
        }
        logger.warn(
            `Twitter: failed to fetch ${link.url}: ${errorMessage(error)}`
        );
    }
}
