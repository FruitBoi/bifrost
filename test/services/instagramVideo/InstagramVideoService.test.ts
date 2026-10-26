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

/** Embed page unavailable, so these tests exercise the yt-dlp fallback. */
const notFoundFetch = (async () =>
    new Response('not found', { status: 404 })) as unknown as typeof fetch;

const OPTIONS: InstagramVideoOptions = {
    maxBytes: 10 * MB,
    maxDurationSeconds: 180,
    timeoutMs: 60_000,
    maxConcurrent: 2,
    fetchImpl: notFoundFetch,
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

describe('InstagramVideoService yt-dlp fallback', () => {
    it('returns a small download untouched', async () => {
        const { runner, calls, dirs } = fakeRunner({ downloadBytes: 5000 });
        const service = new InstagramVideoService(OPTIONS, runner);

        const post = await service.fetchPost(LINK);

        expect(post).not.toBeNull();
        expect(post!.files).toHaveLength(1);
        expect(post!.files[0].name).toBe('instagram-ABC123.mp4');
        expect(post!.files[0].kind).toBe('video');
        expect(post!.files[0].data.length).toBe(5000);
        expect(post!.spoiler).toBe(false);
        expect(post!.sourceUrl).toBe(LINK.url);
        expect(post!.username).toBeNull();
        expect(post!.caption).toBeNull();
        expect(post!.profilePicUrl).toBeNull();
        expect(calls.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(existsSync(dirs[0])).toBe(false);
    });

    it('passes safe yt-dlp arguments and no credentials', async () => {
        const { runner, calls } = fakeRunner({});
        await new InstagramVideoService(OPTIONS, runner).fetchPost(LINK);

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
        ).fetchPost(LINK);
        expect(video!.files[0].name).toBe('instagram-ABC123.webm');
    });

    it('prefixes spoilered videos with SPOILER_', async () => {
        const { runner } = fakeRunner({});
        const video = await new InstagramVideoService(
            OPTIONS,
            runner
        ).fetchPost({ ...LINK, spoiler: true });
        expect(video!.files[0].name).toBe('SPOILER_instagram-ABC123.mp4');
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
        ).fetchPost(LINK);

        expect(video!.files[0].data.length).toBe(8 * MB);
        expect(video!.files[0].name).toBe('instagram-ABC123.mp4');
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
        ).fetchPost(LINK);

        expect(video!.files[0].data.length).toBe(9 * MB);
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
        ).fetchPost(LINK);

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
        ).fetchPost(LINK);

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
            await new InstagramVideoService(OPTIONS, runner).fetchPost(LINK)
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
        ).fetchPost(LINK);

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
        ).fetchPost(LINK);

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
            await new InstagramVideoService(OPTIONS, runner).fetchPost(LINK)
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

        expect(await service.fetchPost(LINK)).toBeNull();
        expect(await service.fetchPost(LINK)).toBeNull();
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
        expect(await service.fetchPost(LINK)).toBeNull();
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
        ).fetchPost(LINK);
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

        const jobs = links.map((link) => service.fetchPost(link));
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

const EMBED_URL = 'https://www.instagram.com/p/ABC123/embed/captioned/';
const VIDEO_URL =
    'https://instagram.fxyz1-2.fna.fbcdn.net/o1/v/t2/video.mp4?oe=1';
const IMAGE_URL = (n: number) =>
    `https://instagram.fxyz1-1.fna.fbcdn.net/v/t51/image-${n}.jpg?stp=x`;
const AVATAR_URL = 'https://scontent.cdninstagram.com/v/t51/avatar.jpg';

type Route = () => Response | Promise<Response>;

/** A fake fetch serving `routes` by exact URL (404 otherwise), recording calls. */
function fakeFetch(routes: Record<string, Route>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (input: string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const route = routes[url];
        return route ? route() : new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

/** A minimal embed page whose contextJSON holds `media`. */
function embedPage(media: Record<string, unknown>): string {
    const type = String(media.__typename);
    const context = {
        context: { type, shortcode: 'ABC123', copyright_blocked: false },
        gql_data: { shortcode_media: media },
    };
    return (
        '<html><body><div class="Embed" data-media-type="' +
        type +
        '"></div><script>s.handle({"require":[["PolarisEmbedSimple","init",[],[{"isSidecar":false,"contextJSON":' +
        JSON.stringify(JSON.stringify(context)) +
        '}]]]});</script></body></html>'
    );
}

const OWNER = {
    username: 'nasa',
    is_verified: true,
    profile_pic_url: AVATAR_URL,
};

const CAPTION = {
    edges: [{ node: { text: 'Liftoff! 🚀\nGo @nasa' } }],
};

function videoMedia(extra: Record<string, unknown> = {}) {
    return {
        __typename: 'GraphVideo',
        shortcode: 'ABC123',
        is_video: true,
        display_url: IMAGE_URL(0),
        video_url: VIDEO_URL,
        video_duration: 61.5,
        owner: OWNER,
        edge_media_to_caption: CAPTION,
        ...extra,
    };
}

function carouselMedia(children: Array<Record<string, unknown>>) {
    return {
        __typename: 'GraphSidecar',
        shortcode: 'ABC123',
        is_video: false,
        display_url: IMAGE_URL(1),
        owner: OWNER,
        edge_media_to_caption: CAPTION,
        edge_sidecar_to_children: {
            edges: children.map((node) => ({ node })),
        },
    };
}

const imageChild = (n: number) => ({
    __typename: 'GraphImage',
    is_video: false,
    display_url: IMAGE_URL(n),
});
const videoChild = () => ({
    __typename: 'GraphVideo',
    is_video: true,
    display_url: IMAGE_URL(9),
    video_url: VIDEO_URL,
    video_duration: 20,
});

const html = (body: string) => () =>
    new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    });
const file =
    (bytes: number, type: string, fill = 7) =>
    () =>
        new Response(Buffer.alloc(bytes, fill), {
            status: 200,
            headers: { 'content-type': type },
        });

describe('InstagramVideoService embed page', () => {
    it('posts a reel video with its caption and author', async () => {
        const { impl, calls } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: file(5000, 'video/mp4'),
        });
        const { runner, calls: commands } = fakeRunner({});
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);

        expect(post).toEqual({
            sourceUrl: LINK.url,
            spoiler: false,
            username: 'nasa',
            profilePicUrl: AVATAR_URL,
            caption: 'Liftoff! 🚀\nGo @nasa',
            files: [
                {
                    name: 'instagram-ABC123.mp4',
                    data: expect.any(Buffer),
                    kind: 'video',
                },
            ],
        });
        expect(post!.files[0].data.length).toBe(5000);
        expect(commands).toHaveLength(0);
        expect(calls.map((c) => c.url)).toEqual([EMBED_URL, VIDEO_URL]);

        // Honest, credential-free requests.
        for (const call of calls) {
            const headers = call.init!.headers as Record<string, string>;
            expect(headers['User-Agent']).toMatch(/Bifrost/);
            expect(Object.keys(headers).join(' ')).not.toMatch(
                /cookie|authorization|x-ig|x-csrf|x-fb/i
            );
            expect(call.init!.signal).toBeDefined();
        }
        expect(calls[0].init!.redirect).toBe('follow');
        expect(calls[1].init!.redirect).toBe('manual');
    });

    it('posts every carousel item in order with numbered names', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(
                embedPage(
                    carouselMedia([imageChild(1), videoChild(), imageChild(2)])
                )
            ),
            [IMAGE_URL(1)]: file(1000, 'image/jpeg', 1),
            [VIDEO_URL]: file(2000, 'video/mp4', 2),
            [IMAGE_URL(2)]: file(3000, 'image/webp', 3),
        });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            fakeRunner({}).runner
        ).fetchPost(LINK);

        expect(
            post!.files.map((f) => [f.name, f.kind, f.data.length, f.data[0]])
        ).toEqual([
            ['instagram-ABC123-1.jpg', 'image', 1000, 1],
            ['instagram-ABC123-2.mp4', 'video', 2000, 2],
            ['instagram-ABC123-3.webp', 'image', 3000, 3],
        ]);
        expect(post!.username).toBe('nasa');
    });

    it('takes at most 10 files', async () => {
        const children = Array.from({ length: 12 }, (_, i) => imageChild(i));
        const routes: Record<string, Route> = {
            [EMBED_URL]: html(embedPage(carouselMedia(children))),
        };
        children.forEach((_, i) => {
            routes[IMAGE_URL(i)] = file(100, 'image/jpeg');
        });
        const { impl } = fakeFetch(routes);
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            fakeRunner({}).runner
        ).fetchPost(LINK);
        expect(post!.files).toHaveLength(10);
        expect(post!.files[9].name).toBe('instagram-ABC123-10.jpg');
    });

    it('prefixes spoilered files with SPOILER_', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(
                embedPage(carouselMedia([imageChild(1), imageChild(2)]))
            ),
            [IMAGE_URL(1)]: file(100, 'image/jpeg'),
            [IMAGE_URL(2)]: file(100, 'image/png'),
        });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            fakeRunner({}).runner
        ).fetchPost({ ...LINK, spoiler: true });
        expect(post!.spoiler).toBe(true);
        expect(post!.files.map((f) => f.name)).toEqual([
            'SPOILER_instagram-ABC123-1.jpg',
            'SPOILER_instagram-ABC123-2.png',
        ]);
    });

    it('refuses media on non-CDN hosts and falls back to yt-dlp', async () => {
        const evil = 'https://evil.example.com/video.mp4';
        const { impl, calls } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia({ video_url: evil }))),
            [evil]: file(5000, 'video/mp4'),
        });
        const { runner, calls: commands } = fakeRunner({});
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);

        expect(calls.map((c) => c.url)).toEqual([EMBED_URL]);
        expect(commands.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(post!.files[0].name).toBe('instagram-ABC123.mp4');
        // The page still told us who posted it.
        expect(post!.username).toBe('nasa');
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('evil.example.com')
        );
    });

    it('refuses plain-http and look-alike CDN hosts', async () => {
        const urls = [
            'http://scontent.cdninstagram.com/v/a.mp4',
            'https://cdninstagram.com.evil.net/a.mp4',
            'https://notfbcdn.net/a.mp4',
        ];
        for (const url of urls) {
            const { impl, calls } = fakeFetch({
                [EMBED_URL]: html(embedPage(videoMedia({ video_url: url }))),
                [url]: file(5000, 'video/mp4'),
            });
            await new InstagramVideoService(
                { ...OPTIONS, fetchImpl: impl },
                fakeRunner({ ytDlpCode: 1 }).runner
            ).fetchPost(LINK);
            expect(calls.map((c) => c.url)).toEqual([EMBED_URL]);
        }
    });

    it('does not follow a CDN redirect to another host', async () => {
        const target = 'http://169.254.169.254/latest/meta-data';
        const { impl, calls } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: () =>
                new Response(null, {
                    status: 302,
                    headers: { location: target },
                }),
        });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            fakeRunner({ ytDlpCode: 1 }).runner
        ).fetchPost(LINK);
        expect(post).toBeNull();
        expect(calls.map((c) => c.url)).toEqual([EMBED_URL, VIDEO_URL]);
    });

    it('follows a CDN redirect to another CDN host', async () => {
        const target = 'https://scontent.cdninstagram.com/v/moved.mp4';
        const { impl } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: () =>
                new Response(null, {
                    status: 302,
                    headers: { location: target },
                }),
            [target]: file(4000, 'video/mp4'),
        });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            fakeRunner({}).runner
        ).fetchPost(LINK);
        expect(post!.files[0].data.length).toBe(4000);
    });

    it('skips an image over the budget and compresses a video to what is left', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(
                embedPage(
                    carouselMedia([imageChild(1), imageChild(2), videoChild()])
                )
            ),
            [IMAGE_URL(1)]: file(6 * MB, 'image/jpeg'),
            [IMAGE_URL(2)]: file(6 * MB, 'image/jpeg'),
            [VIDEO_URL]: file(8 * MB, 'video/mp4'),
        });
        const { runner, calls } = fakeRunner({
            duration: '20',
            encodedBytes: [3 * MB],
        });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);

        expect(post!.files.map((f) => [f.name, f.data.length])).toEqual([
            ['instagram-ABC123-1.jpg', 6 * MB],
            ['instagram-ABC123-2.mp4', 3 * MB],
        ]);
        expect(calls.map((c) => c.command)).toEqual(['ffprobe', 'ffmpeg']);
        const args = calls[1].args;
        expect(parseInt(argValue(args, '-b:v'), 10)).toBe(
            compressionBitrate(4 * MB, 20, 96)
        );
        const total = post!.files.reduce((n, f) => n + f.data.length, 0);
        expect(total).toBeLessThanOrEqual(OPTIONS.maxBytes);
        const output = args[args.length - 1];
        expect(existsSync(output.slice(0, output.lastIndexOf('/')))).toBe(
            false
        );
    });

    it('returns null without yt-dlp when nothing fits the budget', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(
                embedPage(carouselMedia([imageChild(1), imageChild(2)]))
            ),
            [IMAGE_URL(1)]: file(11 * MB, 'image/jpeg'),
            [IMAGE_URL(2)]: file(11 * MB, 'image/jpeg'),
        });
        const { runner, calls } = fakeRunner({});
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);
        expect(post).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('skips a video over the duration limit', async () => {
        const { impl, calls } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia({ video_duration: 600 }))),
            [VIDEO_URL]: file(5000, 'video/mp4'),
        });
        const { runner, calls: commands } = fakeRunner({ ytDlpCode: 1 });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);
        expect(post).toBeNull();
        expect(calls.map((c) => c.url)).toEqual([EMBED_URL]);
        // yt-dlp still gets a go (its own match filter applies).
        expect(commands.map((c) => c.command)).toEqual(['yt-dlp']);
    });

    it('skips a video download over maxDownloadBytes', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: file(3000, 'video/mp4'),
        });
        const { runner, calls } = fakeRunner({ ytDlpCode: 1 });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl, maxDownloadBytes: 2000 },
            runner
        ).fetchPost(LINK);
        expect(post).toBeNull();
        expect(calls.map((c) => c.command)).toEqual(['yt-dlp']);
    });

    it('rejects an HTML error page served as media', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: html('<html>denied</html>'),
        });
        const { runner, calls } = fakeRunner({});
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);
        expect(calls.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(post!.files[0].data[0]).toBe(1);
    });

    it('falls back to yt-dlp when the embed page cannot be fetched', async () => {
        const failing = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;
        const { runner, calls } = fakeRunner({ downloadBytes: 5000 });
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: failing },
            runner
        ).fetchPost(LINK);

        expect(calls.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(post!.files[0].data.length).toBe(5000);
        expect(post!.username).toBeNull();
        expect(post!.caption).toBeNull();
        expect(post!.profilePicUrl).toBeNull();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('fetch failed')
        );
    });

    it('falls back to yt-dlp for a video page without contextJSON', async () => {
        const page =
            '<div class="Embed" data-media-type="GraphVideo"><span class="UsernameText">nasa</span>' +
            '<img class="EmbeddedMediaImage" src="' +
            IMAGE_URL(0) +
            '"></div><script>[{"contextJSON":null}]</script>';
        const { impl, calls } = fakeFetch({ [EMBED_URL]: html(page) });
        const { runner } = fakeRunner({});
        const post = await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);
        // Never the poster image: that was the bug in issue #48.
        expect(calls.map((c) => c.url)).toEqual([EMBED_URL]);
        expect(post!.files.map((f) => f.kind)).toEqual(['video']);
        expect(post!.username).toBe('nasa');
    });

    it('caps the embed page size', async () => {
        const { impl } = fakeFetch({
            [EMBED_URL]: () =>
                new Response(Buffer.alloc(4 * MB, 32), { status: 200 }),
        });
        const { runner, calls } = fakeRunner({ ytDlpCode: 1 });
        await new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        ).fetchPost(LINK);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('over 3145728 bytes')
        );
        expect(calls).toHaveLength(1);
    });

    it('never throws, whatever fails', async () => {
        const throwing = (() => {
            throw new Error('sync boom');
        }) as unknown as typeof fetch;
        const runner: CommandRunner = async () => {
            throw new Error('runner boom');
        };
        const service = new InstagramVideoService(
            { ...OPTIONS, fetchImpl: throwing },
            runner
        );
        await expect(service.fetchPost(LINK)).resolves.toBeNull();

        const { impl } = fakeFetch({
            [EMBED_URL]: html(embedPage(videoMedia())),
            [VIDEO_URL]: () => {
                throw new Error('media boom');
            },
        });
        const second = new InstagramVideoService(
            { ...OPTIONS, fetchImpl: impl },
            runner
        );
        await expect(second.fetchPost(LINK)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('media boom')
        );
    });
});
