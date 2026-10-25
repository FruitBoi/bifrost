import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InstagramVideoService, {
    CommandRunner,
    InstagramVideoOptions,
    MIN_VIDEO_KBPS,
    compressionBitrate,
} from '../../../src/services/instagramVideo/InstagramVideoService';
import type { InstagramLink } from '../../../src/services/instagramVideo/instagramLinks';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MB = 1024 * 1024;

const OPTIONS: InstagramVideoOptions = {
    maxBytes: 10 * MB,
    maxDurationSeconds: 180,
    timeoutMs: 60_000,
    maxConcurrent: 2,
};

const LINK: InstagramLink = {
    url: 'https://www.instagram.com/reel/ABC123/',
    spoiler: false,
};

interface Call {
    command: string;
    args: string[];
}

interface FakeSetup {
    /** yt-dlp exit code; 0 writes `downloadBytes` bytes. */
    ytDlpCode?: number;
    ytDlpStderr?: string;
    /** Size of the downloaded file; null writes nothing (match filter). */
    downloadBytes?: number | null;
    downloadExt?: string;
    /** ffprobe's duration output. */
    duration?: string;
    /** Size of each ffmpeg output, attempt by attempt. */
    encodedBytes?: number[];
    ffmpegCode?: number;
    /** Error thrown for every command (spawn failure). */
    spawnError?: NodeJS.ErrnoException;
}

/** A fake CommandRunner that writes files where yt-dlp/ffmpeg would. */
function fakeRunner(setup: FakeSetup) {
    const calls: Call[] = [];
    const dirs: string[] = [];
    let encodes = 0;
    const runner: CommandRunner = async (command, args) => {
        calls.push({ command, args });
        if (setup.spawnError) throw setup.spawnError;
        if (command === 'yt-dlp') {
            const template = args[args.indexOf('-o') + 1];
            dirs.push(template.slice(0, template.lastIndexOf('/')));
            const code = setup.ytDlpCode ?? 0;
            if (code === 0 && setup.downloadBytes !== null) {
                await writeFile(
                    template.replace('%(ext)s', setup.downloadExt ?? 'mp4'),
                    Buffer.alloc(setup.downloadBytes ?? 1000, 1)
                );
            }
            return { stdout: '', stderr: setup.ytDlpStderr ?? '', code };
        }
        if (command === 'ffprobe') {
            return {
                stdout: `${setup.duration ?? '60.0'}\n`,
                stderr: '',
                code: 0,
            };
        }
        if (command === 'ffmpeg') {
            const sizes = setup.encodedBytes ?? [MB];
            const size = sizes[Math.min(encodes++, sizes.length - 1)];
            if ((setup.ffmpegCode ?? 0) === 0) {
                await writeFile(args[args.length - 1], Buffer.alloc(size, 2));
            }
            return { stdout: '', stderr: 'boom', code: setup.ffmpegCode ?? 0 };
        }
        throw new Error(`unexpected command ${command}`);
    };
    return { runner, calls, dirs };
}

function argValue(args: string[], flag: string): string {
    return args[args.indexOf(flag) + 1];
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('compressionBitrate', () => {
    it('fits video plus audio into the byte budget with a margin', () => {
        // 10 MiB over 60 s is ~1398 kbps in total.
        const kbps = compressionBitrate(10 * MB, 60, 96);
        expect(kbps).toBeGreaterThan(1100);
        expect(kbps).toBeLessThan(1398 - 96);
        expect(((kbps + 96) * 1000 * 60) / 8).toBeLessThanOrEqual(10 * MB);
    });

    it('goes negative when the audio alone would not fit', () => {
        expect(compressionBitrate(MB, 3600, 96)).toBeLessThan(0);
    });
});

describe('InstagramVideoService', () => {
    it('returns a small download untouched', async () => {
        const { runner, calls, dirs } = fakeRunner({ downloadBytes: 5000 });
        const service = new InstagramVideoService(OPTIONS, runner);

        const video = await service.fetchVideo(LINK);

        expect(video).not.toBeNull();
        expect(video!.name).toBe('instagram-ABC123.mp4');
        expect(video!.data.length).toBe(5000);
        expect(video!.spoiler).toBe(false);
        expect(video!.sourceUrl).toBe(LINK.url);
        expect(calls.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(existsSync(dirs[0])).toBe(false);
    });

    it('passes safe yt-dlp arguments and no credentials', async () => {
        const { runner, calls } = fakeRunner({});
        await new InstagramVideoService(OPTIONS, runner).fetchVideo(LINK);

        const args = calls[0].args;
        expect(args[args.length - 1]).toBe(LINK.url);
        expect(args[args.length - 2]).toBe('--');
        expect(argValue(args, '--playlist-items')).toBe('1');
        expect(argValue(args, '--match-filter')).toBe('duration <=? 180');
        expect(argValue(args, '--merge-output-format')).toBe('mp4');
        expect(args).toContain('--ignore-config');
        expect(args.join(' ')).not.toMatch(
            /cookies|--username|--password|netrc/
        );
    });

    it('keeps the downloaded extension', async () => {
        const { runner } = fakeRunner({ downloadExt: 'webm' });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);
        expect(video!.name).toBe('instagram-ABC123.webm');
    });

    it('prefixes spoilered videos with SPOILER_', async () => {
        const { runner } = fakeRunner({});
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo({ ...LINK, spoiler: true });
        expect(video!.name).toBe('SPOILER_instagram-ABC123.mp4');
        expect(video!.spoiler).toBe(true);
    });

    it('compresses a big download at a sane bitrate', async () => {
        const { runner, calls, dirs } = fakeRunner({
            downloadBytes: 20 * MB,
            duration: '60.5',
            encodedBytes: [8 * MB],
        });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);

        expect(video!.data.length).toBe(8 * MB);
        expect(video!.name).toBe('instagram-ABC123.mp4');
        expect(calls.map((c) => c.command)).toEqual([
            'yt-dlp',
            'ffprobe',
            'ffmpeg',
        ]);
        const args = calls[2].args;
        const kbps = parseInt(argValue(args, '-b:v'), 10);
        expect(kbps).toBe(compressionBitrate(10 * MB, 60.5, 96));
        expect(kbps).toBeGreaterThan(1000);
        expect(kbps).toBeLessThan(1400);
        expect(argValue(args, '-c:v')).toBe('libx264');
        expect(argValue(args, '-preset')).toBe('veryfast');
        expect(argValue(args, '-b:a')).toBe('96k');
        expect(argValue(args, '-movflags')).toBe('+faststart');
        expect(argValue(args, '-vf')).toContain('720');
        expect(existsSync(dirs[0])).toBe(false);
    });

    it('retries once smaller when the first encode is still too big', async () => {
        const { runner, calls } = fakeRunner({
            downloadBytes: 20 * MB,
            duration: '60',
            encodedBytes: [11 * MB, 9 * MB],
        });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);

        expect(video!.data.length).toBe(9 * MB);
        const encodes = calls.filter((c) => c.command === 'ffmpeg');
        expect(encodes).toHaveLength(2);
        const first = parseInt(argValue(encodes[0].args, '-b:v'), 10);
        const second = parseInt(argValue(encodes[1].args, '-b:v'), 10);
        expect(second).toBeLessThan(first * 0.8);
        expect(argValue(encodes[1].args, '-vf')).toContain('480');
    });

    it('gives up when the retry is still too big', async () => {
        const { runner, calls } = fakeRunner({
            downloadBytes: 20 * MB,
            encodedBytes: [11 * MB, 11 * MB],
        });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);

        expect(video).toBeNull();
        expect(calls.filter((c) => c.command === 'ffmpeg')).toHaveLength(2);
    });

    it('gives up when yt-dlp fails (private, login, no video)', async () => {
        const { runner, calls, dirs } = fakeRunner({
            ytDlpCode: 1,
            ytDlpStderr:
                'ERROR: [Instagram] ABC123: Requested content is not available, rate-limit reached or login required\n',
        });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);

        expect(video).toBeNull();
        expect(calls).toHaveLength(1);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('login required')
        );
        expect(existsSync(dirs[0])).toBe(false);
    });

    it('gives up when the match filter skipped the video', async () => {
        const { runner } = fakeRunner({ downloadBytes: null });
        expect(
            await new InstagramVideoService(OPTIONS, runner).fetchVideo(LINK)
        ).toBeNull();
    });

    it('skips a big video that is too long', async () => {
        const { runner, calls } = fakeRunner({
            downloadBytes: 20 * MB,
            duration: '600',
        });
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchVideo(LINK);

        expect(video).toBeNull();
        expect(calls.some((c) => c.command === 'ffmpeg')).toBe(false);
    });

    it('gives up when the bitrate would be too low', async () => {
        const { runner, calls } = fakeRunner({
            downloadBytes: 20 * MB,
            duration: '170',
        });
        const video = await new InstagramVideoService(
            { ...OPTIONS, maxBytes: 2 * MB },
            runner
        ).fetchVideo(LINK);

        expect(compressionBitrate(2 * MB, 170, 96)).toBeLessThan(
            MIN_VIDEO_KBPS
        );
        expect(video).toBeNull();
        expect(calls.some((c) => c.command === 'ffmpeg')).toBe(false);
    });

    it('gives up when ffmpeg fails', async () => {
        const { runner } = fakeRunner({
            downloadBytes: 20 * MB,
            ffmpegCode: 1,
        });
        expect(
            await new InstagramVideoService(OPTIONS, runner).fetchVideo(LINK)
        ).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('ffmpeg failed')
        );
    });

    it('returns null and warns once when the tools are missing', async () => {
        const error = Object.assign(new Error('spawn yt-dlp ENOENT'), {
            code: 'ENOENT',
        });
        const { runner, dirs } = fakeRunner({ spawnError: error });
        const service = new InstagramVideoService(OPTIONS, runner);

        expect(await service.fetchVideo(LINK)).toBeNull();
        expect(await service.fetchVideo(LINK)).toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('not installed')
        );
        expect(dirs).toHaveLength(0);
    });

    it('never throws on other runner errors', async () => {
        const runner: CommandRunner = async () => {
            throw new Error('yt-dlp timed out after 60000 ms');
        };
        const service = new InstagramVideoService(OPTIONS, runner);
        expect(await service.fetchVideo(LINK)).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('timed out')
        );
    });

    it('uses the configured tool paths', async () => {
        const commands: string[] = [];
        const runner: CommandRunner = async (command) => {
            commands.push(command);
            return { stdout: '', stderr: '', code: 1 };
        };
        await new InstagramVideoService(
            { ...OPTIONS, ytDlpPath: '/opt/bin/yt-dlp' },
            runner
        ).fetchVideo(LINK);
        expect(commands).toEqual(['/opt/bin/yt-dlp']);
    });

    it('runs at most maxConcurrent jobs at once, in FIFO order', async () => {
        let running = 0;
        let peak = 0;
        const started: string[] = [];
        const gates: Array<() => void> = [];
        const runner: CommandRunner = async (_command, args) => {
            started.push(args[args.length - 1]);
            running++;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => gates.push(resolve));
            running--;
            return { stdout: '', stderr: '', code: 1 };
        };
        const service = new InstagramVideoService(
            { ...OPTIONS, maxConcurrent: 2 },
            runner
        );
        const links = ['A', 'B', 'C', 'D', 'E'].map((code) => ({
            url: `https://www.instagram.com/p/${code}/`,
            spoiler: false,
        }));

        const jobs = links.map((link) => service.fetchVideo(link));
        const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

        await flush();
        expect(started).toHaveLength(2);
        while (gates.length > 0 || started.length < links.length) {
            gates.shift()?.();
            await flush();
        }
        await Promise.all(jobs);

        expect(peak).toBe(2);
        expect(started).toEqual(links.map((link) => link.url));
    });
});
