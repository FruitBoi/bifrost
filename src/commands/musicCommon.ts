import {
    MusicController,
    MusicError,
    MusicQueueView,
    QueuedTrack,
} from '../services/music/types';
import type { VoicePlatform } from '../services/voice/VoiceTransport';
import { breakMentions } from '../utils/sanitizeMentions';
import logger from '../utils/logging/logger';

export const MUSIC_DISABLED_MESSAGE =
    'Music is disabled on this bot. Set `BF_ENABLE_MUSIC=true` to enable it.';
const MAX_UPCOMING_SHOWN = 10;
const MAX_TITLE_LENGTH = 100;

/** Title or name made safe to show: no pings, no markdown, bounded length. */
export function safeText(text: string, max = MAX_TITLE_LENGTH): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    return breakMentions(cut.replace(/([\\*_~`|>[\]()#-])/g, '\\$1'));
}

export function formatDuration(sec: number | null, isLive = false): string {
    if (isLive) return 'live';
    if (sec === null) return '?:??';
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function trackLine(track: QueuedTrack): string {
    return `**${safeText(track.title)}** (${formatDuration(track.durationSec, track.isLive)})`;
}

export function formatQueue(view: MusicQueueView | null): string {
    if (!view || (!view.nowPlaying && view.upcoming.length === 0)) {
        return 'Nothing is playing or queued.';
    }
    const lines: string[] = [];
    const np = view.nowPlaying;
    if (np) {
        const total = np.isLive
            ? 'live'
            : formatDuration(np.durationSec, np.isLive);
        lines.push(
            `${view.paused ? '⏸️ Paused' : '▶️ Now playing'}: **${safeText(np.title)}** (${formatDuration(np.elapsedSec)} / ${total}) — requested by ${safeText(np.requestedBy, 32)}`
        );
    }
    if (view.upcoming.length > 0) {
        lines.push('', '**Up next**');
        view.upcoming.slice(0, MAX_UPCOMING_SHOWN).forEach((t, i) => {
            lines.push(
                `${i + 1}. ${trackLine(t)} — ${safeText(t.requestedBy, 32)}`
            );
        });
        const more = view.upcoming.length - MAX_UPCOMING_SHOWN;
        if (more > 0) lines.push(`…and ${more} more`);
    }
    return lines.join('\n');
}

export interface MusicCommandContext {
    music: MusicController;
    platform: VoicePlatform;
    guildId: string;
    userId: string;
    requesterName: string;
    args: string[];
    announce: (text: string) => void;
    /** Called before a slow lookup, e.g. to show a typing indicator. */
    onSearching?: () => void;
}

/** Runs a `music` invocation and returns the text to reply with. */
export async function runMusicCommand(
    ctx: MusicCommandContext
): Promise<{ text: string; error: boolean }> {
    const { music, platform, guildId, userId } = ctx;
    const sub = ctx.args[0]?.toLowerCase();
    try {
        if (!sub || ['queue', 'np', 'list'].includes(sub)) {
            return {
                text: formatQueue(music.queue(platform, guildId)),
                error: false,
            };
        }
        if (ctx.args.length === 1) {
            switch (sub) {
                case 'skip': {
                    const track = music.skip(platform, guildId, userId);
                    return {
                        text: `⏭️ Skipped **${safeText(track.title)}**.`,
                        error: false,
                    };
                }
                case 'stop':
                    music.stop(platform, guildId, userId);
                    return {
                        text: '⏹️ Stopped the music and left the voice channel.',
                        error: false,
                    };
                case 'pause':
                    music.pause(platform, guildId, userId);
                    return { text: '⏸️ Paused.', error: false };
                case 'resume':
                    music.resume(platform, guildId, userId);
                    return { text: '▶️ Resumed.', error: false };
            }
        }
        ctx.onSearching?.();
        const result = await music.enqueue({
            platform,
            guildId,
            userId,
            requesterName: ctx.requesterName,
            query: ctx.args.join(' '),
            announce: (text) => {
                try {
                    // Announcements are plain messages carrying video titles.
                    ctx.announce(breakMentions(text));
                } catch (err: unknown) {
                    logger.error('[Music] ❌ announce failed:', err);
                }
            },
        });
        const line = trackLine(result.track);
        return {
            text:
                result.position === 0
                    ? `▶️ Now playing ${line}`
                    : `Queued ${line} at position ${result.position}`,
            error: false,
        };
    } catch (err: unknown) {
        if (err instanceof MusicError) {
            return { text: err.message, error: true };
        }
        logger.error('[Music] ❌ Music command failed:', err);
        return {
            text: 'Something went wrong while running the music command.',
            error: true,
        };
    }
}
