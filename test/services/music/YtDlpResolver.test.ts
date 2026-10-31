import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../../src/services/instagramVideo/InstagramVideoService';
import YtDlpResolver, {
    isUrlQuery,
} from '../../../src/services/music/YtDlpResolver';
import { MusicError } from '../../../src/services/music/types';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface Call {
    command: string;
    args: string[];
    timeoutMs: number;
}

function fakeRunner(
    result:
        | { stdout?: string; stderr?: string; code?: number | null }
        | NodeJS.ErrnoException
) {
    const calls: Call[] = [];
    const runner: CommandRunner = async (command, args, { timeoutMs }) => {
        calls.push({ command, args, timeoutMs });
        if (result instanceof Error) throw result;
        return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            code: result.code === undefined ? 0 : result.code,
        };
    };
    return { runner, calls };
}

const VIDEO = {
    title: 'Never Gonna Give You Up',
    webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    original_url: 'https://youtu.be/dQw4w9WgXcQ',
    duration: 213,
    is_live: false,
};

function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('isUrlQuery', () => {
    it('accepts only http(s) URLs', () => {
        expect(isUrlQuery('https://youtu.be/x')).toBe(true);
        expect(isUrlQuery('http://example.com')).toBe(true);
        expect(isUrlQuery('file:///etc/passwd')).toBe(false);
        expect(isUrlQuery('never gonna give you up')).toBe(false);
    });
});

describe('YtDlpResolver', () => {
    it('resolves a URL directly, with the query after --', async () => {
        const { runner, calls } = fakeRunner({
            stdout: JSON.stringify(VIDEO) + '\n',
        });
        const resolver = new YtDlpResolver({
            runner,
            ytDlpPath: '/opt/yt-dlp',
            timeoutMs: 1234,
        });

        const track = await resolver.resolve('  https://youtu.be/dQw4w9WgXcQ ');

        expect(track).toEqual({
            title: 'Never Gonna Give You Up',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            durationSec: 213,
            isLive: false,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].command).toBe('/opt/yt-dlp');
        expect(calls[0].timeoutMs).toBe(1234);
        const { args } = calls[0];
        expect(args).toContain('--no-playlist');
        expect(args).toContain('--ignore-config');
        expect(args.slice(-2)).toEqual(['--', 'https://youtu.be/dQw4w9WgXcQ']);
        expect(args.join(' ')).not.toMatch(/cookie|password|username/i);
    });

    it('searches anything that is not a URL, so a leading dash stays a query', async () => {
        const { runner, calls } = fakeRunner({ stdout: JSON.stringify(VIDEO) });
        const resolver = new YtDlpResolver({ runner });

        await resolver.resolve('--exec rm');

        expect(calls[0].args.slice(-2)).toEqual(['--', 'ytsearch1:--exec rm']);
    });

    it('falls back to original_url and url', async () => {
        const { runner } = fakeRunner({
            stdout: JSON.stringify({
                title: 'A',
                original_url: 'https://a.example/1',
                duration: 10,
            }),
        });
        expect((await new YtDlpResolver({ runner }).resolve('a')).url).toBe(
            'https://a.example/1'
        );

        const second = fakeRunner({
            stdout: JSON.stringify({ title: 'B', url: 'https://b.example/2' }),
        });
        const track = await new YtDlpResolver({
            runner: second.runner,
        }).resolve('b');
        expect(track.url).toBe('https://b.example/2');
        expect(track.durationSec).toBeNull();
    });

    it('takes the first usable line', async () => {
        const { runner } = fakeRunner({
            stdout: `garbage\n${JSON.stringify(VIDEO)}\n${JSON.stringify({ ...VIDEO, title: 'Other' })}\n`,
        });
        expect((await new YtDlpResolver({ runner }).resolve('x')).title).toBe(
            'Never Gonna Give You Up'
        );
    });

    it('rejects when nothing is found', async () => {
        const { runner } = fakeRunner({ stdout: '' });
        await expect(
            new YtDlpResolver({ runner }).resolve('zzzz')
        ).rejects.toThrow(MusicError);
    });

    it('rejects an empty query without running yt-dlp', async () => {
        const { runner, calls } = fakeRunner({ stdout: JSON.stringify(VIDEO) });
        await expect(
            new YtDlpResolver({ runner }).resolve('   ')
        ).rejects.toThrow(MusicError);
        expect(calls).toHaveLength(0);
    });

    it('rejects with a short message and logs stderr when yt-dlp fails', async () => {
        const { runner } = fakeRunner({
            code: 1,
            stderr: 'WARNING: x\nERROR: [youtube] abc: Video unavailable\n',
        });
        const error = await new YtDlpResolver({ runner })
            .resolve('https://youtu.be/abc')
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MusicError);
        expect((error as Error).message).not.toContain('Video unavailable');
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
            expect.stringContaining('ERROR: [youtube] abc: Video unavailable')
        );
    });

    it('rejects when yt-dlp is not installed', async () => {
        const { runner } = fakeRunner(errno('ENOENT'));
        await expect(
            new YtDlpResolver({ runner }).resolve('x')
        ).rejects.toThrow(/not installed/);
    });

    it('rejects when yt-dlp times out', async () => {
        const { runner } = fakeRunner(errno('ETIMEDOUT'));
        await expect(
            new YtDlpResolver({ runner }).resolve('x')
        ).rejects.toThrow(MusicError);
    });

    it('rejects tracks over the duration limit', async () => {
        const { runner } = fakeRunner({
            stdout: JSON.stringify({ ...VIDEO, duration: 4 * 3600 }),
        });
        await expect(
            new YtDlpResolver({ runner }).resolve('x')
        ).rejects.toThrow(/too long \(4:00:00, the limit is 3:00:00\)/);

        const short = new YtDlpResolver({
            runner: fakeRunner({ stdout: JSON.stringify(VIDEO) }).runner,
            maxDurationSec: 60,
        });
        await expect(short.resolve('x')).rejects.toThrow(/too long/);
    });

    it('allows live streams regardless of duration', async () => {
        const { runner } = fakeRunner({
            stdout: JSON.stringify({
                ...VIDEO,
                duration: null,
                is_live: false,
                live_status: 'is_live',
            }),
        });
        const track = await new YtDlpResolver({
            runner,
            maxDurationSec: 60,
        }).resolve('lofi');
        expect(track.isLive).toBe(true);
        expect(track.durationSec).toBeNull();
    });
});
