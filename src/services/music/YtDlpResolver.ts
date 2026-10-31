import logger from '../../utils/logging/logger';
import {
    type CommandRunner,
    spawnRunner,
} from '../instagramVideo/InstagramVideoService';
import { MusicError, type TrackInfo, type TrackResolver } from './types';

/** Default for the `maxDurationSec` option: 3 hours. */
export const DEFAULT_MAX_DURATION_SEC = 3 * 60 * 60;
/** Default for the `timeoutMs` option. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Fields yt-dlp prints for the resolved video, as one small JSON object per
 * line. `-J` would print the whole info dict (often hundreds of KB with the
 * format list), more than {@link spawnRunner} keeps.
 */
const PRINT_TEMPLATE =
    '%(.{title,webpage_url,original_url,url,duration,is_live,live_status})j';

export interface YtDlpResolverOptions {
    /** Defaults to `yt-dlp`. */
    ytDlpPath?: string;
    /** Time limit for the yt-dlp process; defaults to {@link DEFAULT_RESOLVE_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Longer tracks are refused (live streams are allowed); defaults to {@link DEFAULT_MAX_DURATION_SEC}. */
    maxDurationSec?: number;
    /** Process runner; injected by tests. */
    runner?: CommandRunner;
}

/** True for http(s) URLs, which yt-dlp resolves directly instead of searching. */
export function isUrlQuery(query: string): boolean {
    try {
        const url = new URL(query);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/** "1:02:03" / "4:05" for error messages. */
function formatDuration(totalSec: number): string {
    const sec = Math.floor(totalSec % 60);
    const min = Math.floor(totalSec / 60) % 60;
    const hours = Math.floor(totalSec / 3600);
    const pad = (n: number) => String(n).padStart(2, '0');
    return hours > 0
        ? `${hours}:${pad(min)}:${pad(sec)}`
        : `${min}:${pad(sec)}`;
}

/** A short, single-line excerpt of yt-dlp's stderr for the logs. */
function stderrExcerpt(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    const errors = lines.filter((line) => line.startsWith('ERROR'));
    const text = (errors.length > 0 ? errors : lines).slice(-2).join(' | ');
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/**
 * Resolves a URL or search words into one track with yt-dlp, without
 * downloading anything.
 *
 * http(s) URLs are passed to yt-dlp as they are (`--no-playlist`, and only
 * the first item of a playlist page); anything else is searched on YouTube
 * as `ytsearch1:<words>`. The query always follows `--`, so it can never be
 * read as an option. No cookies or credentials are passed, and
 * `--ignore-config` keeps a stray config file from adding some.
 */
export default class YtDlpResolver implements TrackResolver {
    private readonly ytDlpPath: string;
    private readonly timeoutMs: number;
    private readonly maxDurationSec: number;
    private readonly runner: CommandRunner;

    constructor(options: YtDlpResolverOptions = {}) {
        this.ytDlpPath = options.ytDlpPath ?? 'yt-dlp';
        this.timeoutMs = options.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
        this.maxDurationSec =
            options.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
        this.runner = options.runner ?? spawnRunner;
    }

    async resolve(query: string): Promise<TrackInfo> {
        const trimmed = query.trim();
        if (trimmed === '') {
            throw new MusicError(
                'Give me a YouTube link or something to search for.'
            );
        }
        const target = isUrlQuery(trimmed) ? trimmed : `ytsearch1:${trimmed}`;
        const args = [
            '--ignore-config',
            '--no-playlist',
            '--playlist-items',
            '1',
            '--no-warnings',
            '--skip-download',
            '--print',
            PRINT_TEMPLATE,
            '--',
            target,
        ];

        let result: Awaited<ReturnType<CommandRunner>>;
        try {
            result = await this.runner(this.ytDlpPath, args, {
                timeoutMs: this.timeoutMs,
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                logger.error(
                    `[Music] yt-dlp not found at "${this.ytDlpPath}"; install it to play music`
                );
                throw new MusicError(
                    'Music playback is unavailable: yt-dlp is not installed on the server.'
                );
            }
            if (code === 'ETIMEDOUT') {
                logger.warn(`[Music] yt-dlp timed out resolving "${trimmed}"`);
                throw new MusicError(
                    'Looking that up took too long, try again.'
                );
            }
            logger.error(
                `[Music] yt-dlp failed to start: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            throw new MusicError('Could not look that up.');
        }

        const track = parseTrack(result.stdout);
        if (result.code !== 0 && !track) {
            logger.warn(
                `[Music] yt-dlp exited with ${result.code} for "${trimmed}": ${stderrExcerpt(result.stderr)}`
            );
            throw new MusicError('Could not find or play that.');
        }
        if (!track) {
            throw new MusicError('Nothing found for that.');
        }

        if (
            !track.isLive &&
            track.durationSec !== null &&
            track.durationSec > this.maxDurationSec
        ) {
            throw new MusicError(
                `That track is too long (${formatDuration(track.durationSec)}, the limit is ${formatDuration(this.maxDurationSec)}).`
            );
        }
        return track;
    }
}

/** First usable track in yt-dlp's `--print` output (one JSON object per line), or null. */
function parseTrack(stdout: string): TrackInfo | null {
    for (const line of stdout.split('\n')) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        let info: Record<string, unknown>;
        try {
            info = JSON.parse(text) as Record<string, unknown>;
        } catch {
            continue;
        }
        const url = [info.webpage_url, info.original_url, info.url].find(
            (value): value is string =>
                typeof value === 'string' && isUrlQuery(value)
        );
        if (!url) continue;
        const title =
            typeof info.title === 'string' && info.title.trim() !== ''
                ? info.title.trim()
                : url;
        const isLive = info.is_live === true || info.live_status === 'is_live';
        const durationSec =
            typeof info.duration === 'number' &&
            Number.isFinite(info.duration) &&
            info.duration > 0
                ? info.duration
                : null;
        return { title, url, durationSec, isLive };
    }
    return null;
}
