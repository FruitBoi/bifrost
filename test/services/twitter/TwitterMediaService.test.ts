import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TwitterMediaService, {
    CommandRunner,
    TwitterMediaOptions,
} from '../../../src/services/twitter/TwitterMediaService';
import { tweetSyndicationUrl } from '../../../src/services/twitter/tweetSyndication';
import type { TweetLink } from '../../../src/services/twitter/twitterLinks';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MB = 1024 * 1024;
const ID = '1683920951807971329';
const API_URL = tweetSyndicationUrl(ID);
const PHOTO = (n: number) => `https://pbs.twimg.com/media/photo${n}.jpg`;
const LARGE = (n: number) => `${PHOTO(n)}?name=large`;
const MEDIUM = (n: number) => `${PHOTO(n)}?name=medium`;
const AVATAR = 'https://pbs.twimg.com/profile_images/1/me_normal.jpg';
const HIGH = 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4';
const MID = 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/mid.mp4';
const LOW = 'https://video.twimg.com/ext_tw_video/1/pu/vid/320x180/low.mp4';

const OPTIONS: TwitterMediaOptions = {
    maxBytes: 10 * MB,
    maxDurationSeconds: 180,
    timeoutMs: 60_000,
    maxConcurrent: 2,
};

const LINK: TweetLink = {
    url: `https://x.com/NASA/status/${ID}`,
    id: ID,
    username: 'NASA',
    host: 'x.com',
    knownHost: true,
    spoiler: false,
};

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

const json = (body: unknown) => () =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
const file =
    (bytes: number, type: string, fill = 7) =>
    () =>
        new Response(Buffer.alloc(bytes, fill), {
            status: 200,
            headers: {
                'content-type': type,
                'content-length': String(bytes),
            },
        });
const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
        new Response(null, { status: code, headers });

const photo = (n: number) => ({ type: 'photo', media_url_https: PHOTO(n) });
const video = (seconds = 30) => ({
    type: 'video',
    video_info: {
        duration_millis: seconds * 1000,
        variants: [
            {
                content_type: 'application/x-mpegURL',
                url: 'https://video.twimg.com/pl.m3u8',
            },
            { bitrate: 832000, content_type: 'video/mp4', url: MID },
            { bitrate: 2176000, content_type: 'video/mp4', url: HIGH },
            { bitrate: 256000, content_type: 'video/mp4', url: LOW },
        ],
    },
});

function tweet(extra: Record<string, unknown> = {}) {
    return {
        __typename: 'Tweet',
        id_str: ID,
        text: 'Liftoff! https://t.co/m',
        entities: { media: [{ url: 'https://t.co/m' }] },
        user: {
            screen_name: 'NASA',
            name: 'NASA Space',
            profile_image_url_https: AVATAR,
        },
        mediaDetails: [photo(1)],
        ...extra,
    };
}

interface Call {
    command: string;
    args: string[];
}

/** A fake CommandRunner that writes files where yt-dlp/ffmpeg would. */
function fakeRunner(
    setup: {
        ytDlpCode?: number;
        downloadBytes?: number;
        duration?: string;
        encodedBytes?: number;
        spawnError?: NodeJS.ErrnoException;
    } = {}
) {
    const calls: Call[] = [];
    const dirs: string[] = [];
    const runner: CommandRunner = async (command, args) => {
        calls.push({ command, args });
        if (setup.spawnError) throw setup.spawnError;
        if (command === 'yt-dlp') {
            const template = args[args.indexOf('-o') + 1];
            dirs.push(template.slice(0, template.lastIndexOf('/')));
            const code = setup.ytDlpCode ?? 0;
            if (code === 0) {
                await writeFile(
                    template.replace('%(ext)s', 'mp4'),
                    Buffer.alloc(setup.downloadBytes ?? 1000, 1)
                );
            }
            return { stdout: '', stderr: 'ERROR: nope', code };
        }
        if (command === 'ffprobe') {
            return {
                stdout: `${setup.duration ?? '30.0'}\n`,
                stderr: '',
                code: 0,
            };
        }
        if (command === 'ffmpeg') {
            await writeFile(
                args[args.length - 1],
                Buffer.alloc(setup.encodedBytes ?? MB, 2)
            );
            return { stdout: '', stderr: '', code: 0 };
        }
        throw new Error(`unexpected command ${command}`);
    };
    return { runner, calls, dirs };
}

function service(
    routes: Record<string, Route>,
    runnerSetup: Parameters<typeof fakeRunner>[0] = {},
    options: Partial<TwitterMediaOptions> = {}
) {
    const fetchFake = fakeFetch(routes);
    const runnerFake = fakeRunner(runnerSetup);
    const svc = new TwitterMediaService(
        { ...OPTIONS, fetchImpl: fetchFake.impl, ...options },
        runnerFake.runner
    );
    return {
        svc,
        fetchCalls: fetchFake.calls,
        commands: runnerFake.calls,
        dirs: runnerFake.dirs,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('TwitterMediaService syndication data', () => {
    it('posts a photo tweet with its text and author', async () => {
        const { svc, fetchCalls, commands } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: file(4000, 'image/jpeg'),
        });

        const post = await svc.fetchPost(LINK);

        expect(post).toEqual({
            sourceUrl: LINK.url,
            spoiler: false,
            username: 'NASA',
            displayName: 'NASA Space',
            profilePicUrl: AVATAR,
            text: 'Liftoff!',
            files: [
                {
                    name: `twitter-${ID}.jpg`,
                    data: expect.any(Buffer),
                    kind: 'image',
                },
            ],
        });
        expect(post!.files[0].data.length).toBe(4000);
        expect(commands).toHaveLength(0);
        expect(fetchCalls.map((c) => c.url)).toEqual([API_URL, LARGE(1)]);
        for (const call of fetchCalls) {
            const headers = call.init!.headers as Record<string, string>;
            expect(headers['User-Agent']).toMatch(/Bifrost/);
            expect(Object.keys(headers).join(' ')).not.toMatch(
                /cookie|authorization|csrf|guest/i
            );
            expect(call.init!.signal).toBeDefined();
        }
        expect(fetchCalls[1].init!.redirect).toBe('manual');
    });

    it('fills in the real handle for /i/status/ links', async () => {
        const { svc } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: file(10, 'image/jpeg'),
        });
        const post = await svc.fetchPost({
            ...LINK,
            url: `https://x.com/i/status/${ID}`,
            username: null,
        });
        expect(post!.sourceUrl).toBe(LINK.url);
        expect(post!.username).toBe('NASA');
    });

    it('returns a text-only tweet with no files', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(
                tweet({
                    text: 'just words',
                    entities: {},
                    mediaDetails: undefined,
                })
            ),
        });
        const post = await svc.fetchPost(LINK);
        expect(post!.text).toBe('just words');
        expect(post!.files).toEqual([]);
        expect(fetchCalls).toHaveLength(1);
    });

    it('downloads the highest-bitrate mp4, gifs and photos in order', async () => {
        const gif = {
            type: 'animated_gif',
            video_info: {
                variants: [
                    {
                        bitrate: 0,
                        content_type: 'video/mp4',
                        url: 'https://video.twimg.com/tweet_video/g.mp4',
                    },
                ],
            },
        };
        const { svc, fetchCalls } = service({
            [API_URL]: json(tweet({ mediaDetails: [video(), gif, photo(2)] })),
            [HIGH]: file(3000, 'video/mp4'),
            'https://video.twimg.com/tweet_video/g.mp4': file(
                2000,
                'video/mp4'
            ),
            [LARGE(2)]: file(1000, 'image/png'),
        });
        const post = await svc.fetchPost({ ...LINK, spoiler: true });

        expect(post!.spoiler).toBe(true);
        expect(post!.files.map((f) => [f.name, f.kind, f.data.length])).toEqual(
            [
                [`SPOILER_twitter-${ID}-1.mp4`, 'video', 3000],
                [`SPOILER_twitter-${ID}-2.mp4`, 'video', 2000],
                [`SPOILER_twitter-${ID}-3.png`, 'image', 1000],
            ]
        );
        expect(fetchCalls.map((c) => c.url)).not.toContain(MID);
    });

    it('returns null for a missing tweet without trying yt-dlp', async () => {
        for (const route of [
            status(404),
            json({ __typename: 'TweetTombstone' }),
            () => new Response('', { status: 200 }),
        ]) {
            const { svc, commands } = service({ [API_URL]: route });
            expect(await svc.fetchPost(LINK)).toBeNull();
            expect(commands).toHaveLength(0);
        }
    });

    it('falls back to yt-dlp when the data cannot be loaded', async () => {
        const { svc, commands, dirs } = service(
            { [API_URL]: status(503) },
            { downloadBytes: 5000 }
        );
        const post = await svc.fetchPost(LINK);

        expect(post).toEqual({
            sourceUrl: LINK.url,
            spoiler: false,
            username: 'NASA',
            displayName: null,
            profilePicUrl: null,
            text: null,
            files: [
                {
                    name: `twitter-${ID}.mp4`,
                    data: expect.any(Buffer),
                    kind: 'video',
                },
            ],
        });
        const args = commands[0].args;
        expect(commands.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(args[args.length - 1]).toBe(LINK.url);
        expect(args).toContain('--ignore-config');
        expect(args[args.indexOf('--match-filter') + 1]).toBe(
            'duration <=? 180'
        );
        expect(args.join(' ')).not.toMatch(
            /cookies|--username|--password|netrc/
        );
        expect(existsSync(dirs[0])).toBe(false);
    });

    it('returns null when the data fails and yt-dlp finds nothing', async () => {
        const { svc } = service({ [API_URL]: status(500) }, { ytDlpCode: 1 });
        expect(await svc.fetchPost(LINK)).toBeNull();
    });

    it('tries yt-dlp when every video variant fails, keeping the card', async () => {
        const { svc, commands } = service(
            {
                [API_URL]: json(tweet({ mediaDetails: [video()] })),
                [HIGH]: status(403),
                [MID]: status(403),
                [LOW]: status(403),
            },
            { downloadBytes: 700 }
        );
        const post = await svc.fetchPost(LINK);
        expect(commands.map((c) => c.command)).toEqual(['yt-dlp']);
        expect(post!.text).toBe('Liftoff!');
        expect(post!.files.map((f) => f.data.length)).toEqual([700]);
    });

    it('keeps the card when the yt-dlp fallback is not installed', async () => {
        const enoent = Object.assign(new Error('spawn yt-dlp ENOENT'), {
            code: 'ENOENT',
        });
        const { svc } = service(
            {
                [API_URL]: json(tweet({ mediaDetails: [video()] })),
            },
            { spawnError: enoent }
        );
        const post = await svc.fetchPost(LINK);
        expect(post!.files).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('not installed')
        );
    });

    it('skips videos over the duration limit', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(tweet({ mediaDetails: [video(600)] })),
        });
        const post = await svc.fetchPost(LINK);
        expect(post!.files).toEqual([]);
        expect(fetchCalls).toHaveLength(1);
    });

    it('drops an avatar that is not on twimg', async () => {
        const { svc } = service({
            [API_URL]: json(
                tweet({
                    mediaDetails: [],
                    user: {
                        screen_name: 'NASA',
                        profile_image_url_https: 'https://evil.example/a.jpg',
                    },
                })
            ),
        });
        expect((await svc.fetchPost(LINK))!.profilePicUrl).toBeNull();
    });
});

describe('TwitterMediaService CDN allow-list', () => {
    it('follows redirects within twimg', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: status(302, { location: '/media/moved.jpg' }),
            'https://pbs.twimg.com/media/moved.jpg': file(100, 'image/jpeg'),
        });
        const post = await svc.fetchPost(LINK);
        expect(post!.files[0].data.length).toBe(100);
        expect(fetchCalls.map((c) => c.url)).toContain(
            'https://pbs.twimg.com/media/moved.jpg'
        );
    });

    it('refuses a redirect off twimg', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: status(302, { location: 'https://evil.example/x.jpg' }),
        });
        const post = await svc.fetchPost(LINK);
        expect(post!.files).toEqual([]);
        expect(fetchCalls.map((c) => c.url)).not.toContain(
            'https://evil.example/x.jpg'
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('not a Twitter CDN')
        );
    });

    it('refuses media URLs off twimg', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(
                tweet({
                    mediaDetails: [
                        {
                            type: 'photo',
                            media_url_https: 'https://evil.example/p.jpg',
                        },
                    ],
                })
            ),
        });
        const post = await svc.fetchPost(LINK);
        expect(post!.files).toEqual([]);
        expect(fetchCalls.map((c) => c.url)).toEqual([API_URL]);
    });
});

describe('TwitterMediaService size budget', () => {
    it('takes a lower bitrate when the best one does not fit', async () => {
        const { svc, commands } = service(
            {
                [API_URL]: json(tweet({ mediaDetails: [video()] })),
                [HIGH]: file(2 * MB, 'video/mp4'),
                [MID]: file(800_000, 'video/mp4'),
            },
            {},
            { maxBytes: MB }
        );
        const post = await svc.fetchPost(LINK);
        expect(post!.files.map((f) => f.data.length)).toEqual([800_000]);
        expect(commands).toHaveLength(0);
    });

    it('compresses the smallest variant when none fits', async () => {
        const { svc, commands, fetchCalls } = service(
            {
                [API_URL]: json(tweet({ mediaDetails: [video()] })),
                [HIGH]: file(4 * MB, 'video/mp4'),
                [MID]: file(3 * MB, 'video/mp4'),
                [LOW]: file(2 * MB, 'video/mp4'),
            },
            { encodedBytes: 900_000 },
            { maxBytes: MB }
        );
        const post = await svc.fetchPost(LINK);
        expect(post!.files.map((f) => [f.name, f.data.length])).toEqual([
            [`twitter-${ID}.mp4`, 900_000],
        ]);
        expect(commands.map((c) => c.command)).toEqual(['ffprobe', 'ffmpeg']);
        expect(fetchCalls.filter((c) => c.url === LOW)).toHaveLength(2);
    });

    it('takes the medium rendition of a photo that is too big', async () => {
        const { svc } = service(
            {
                [API_URL]: json(tweet()),
                [LARGE(1)]: file(2 * MB, 'image/jpeg'),
                [MEDIUM(1)]: file(500_000, 'image/jpeg'),
            },
            {},
            { maxBytes: MB }
        );
        const post = await svc.fetchPost(LINK);
        expect(post!.files.map((f) => f.data.length)).toEqual([500_000]);
    });

    it('keeps what fits and still returns the card', async () => {
        const { svc } = service(
            {
                [API_URL]: json(tweet({ mediaDetails: [photo(1), photo(2)] })),
                [LARGE(1)]: file(700_000, 'image/jpeg'),
                [LARGE(2)]: file(700_000, 'image/jpeg'),
                [MEDIUM(2)]: file(400_000, 'image/jpeg'),
            },
            {},
            { maxBytes: MB }
        );
        const post = await svc.fetchPost(LINK);
        expect(post!.text).toBe('Liftoff!');
        expect(post!.files.map((f) => [f.name, f.data.length])).toEqual([
            [`twitter-${ID}.jpg`, 700_000],
        ]);
    });
});

describe('TwitterMediaService alias discovery', () => {
    const alias = (host: string, username = 'NASA'): TweetLink => ({
        ...LINK,
        url: `https://x.com/${username}/status/${ID}`,
        username,
        host,
        knownHost: false,
    });

    it('accepts an unknown host when the tweet is by the linked user', async () => {
        const { svc, fetchCalls } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: file(10, 'image/jpeg'),
        });
        const post = await svc.fetchPost(alias('newfix.example', 'nasa'));

        expect(post).not.toBeNull();
        expect(post!.files).toHaveLength(1);
        expect(svc.discoveredHosts().has('newfix.example')).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            'Twitter: discovered alias host newfix.example'
        );
        // Only Twitter itself is contacted, never the unknown host.
        for (const call of fetchCalls) {
            expect(new URL(call.url).hostname).toMatch(/\.twimg\.com$/);
        }

        await svc.fetchPost(alias('newfix.example', 'someone_else'));
        const discoveries = vi
            .mocked(logger.info)
            .mock.calls.filter(([msg]) => String(msg).includes('discovered'));
        expect(discoveries).toHaveLength(1);
    });

    it('rejects a host whose link names another user, and remembers it', async () => {
        const { svc, fetchCalls } = service({ [API_URL]: json(tweet()) });

        expect(
            await svc.fetchPost(alias('scam.example', 'elonmusk'))
        ).toBeNull();
        expect(fetchCalls).toHaveLength(1);
        expect(svc.discoveredHosts().size).toBe(0);

        expect(await svc.fetchPost(alias('scam.example', 'NASA'))).toBeNull();
        expect(fetchCalls).toHaveLength(1);
    });

    it('does not reject a host when the tweet does not exist', async () => {
        const { svc, fetchCalls, commands } = service({
            [API_URL]: status(404),
        });
        expect(await svc.fetchPost(alias('nope.example'))).toBeNull();
        expect(await svc.fetchPost(alias('nope.example'))).toBeNull();
        expect(fetchCalls).toHaveLength(2);
        expect(commands).toHaveLength(0);
        expect(svc.discoveredHosts().size).toBe(0);
    });

    it('does not reject a host on a transient failure, nor use yt-dlp', async () => {
        const { svc, fetchCalls, commands } = service({
            [API_URL]: status(503),
        });
        expect(await svc.fetchPost(alias('flaky.example'))).toBeNull();
        expect(await svc.fetchPost(alias('flaky.example'))).toBeNull();
        expect(fetchCalls).toHaveLength(2);
        expect(commands).toHaveLength(0);
    });

    it('cannot verify an unknown host without a username', async () => {
        const { svc, fetchCalls } = service({ [API_URL]: json(tweet()) });
        const link = { ...alias('newfix.example'), username: null };
        expect(await svc.fetchPost(link)).toBeNull();
        expect(fetchCalls).toHaveLength(0);
    });

    it('skips verification for known hosts', async () => {
        const { svc } = service({
            [API_URL]: json(tweet()),
            [LARGE(1)]: file(10, 'image/jpeg'),
        });
        const post = await svc.fetchPost({
            ...LINK,
            username: 'whoever',
            host: 'fixvx.com',
        });
        expect(post).not.toBeNull();
        expect(svc.discoveredHosts().size).toBe(0);
    });
});

describe('TwitterMediaService concurrency', () => {
    it('runs at most maxConcurrent jobs at once, in FIFO order', async () => {
        let running = 0;
        let peak = 0;
        const started: string[] = [];
        const gates: Array<() => void> = [];
        const fetchImpl = (async (input: string) => {
            started.push(new URL(String(input)).searchParams.get('id')!);
            running++;
            peak = Math.max(peak, running);
            await new Promise<void>((resolve) => gates.push(resolve));
            running--;
            return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch;
        const svc = new TwitterMediaService(
            { ...OPTIONS, maxConcurrent: 2, fetchImpl },
            fakeRunner().runner
        );
        const ids = ['1', '2', '3', '4', '5'];
        const jobs = ids.map((id) => svc.fetchPost({ ...LINK, id }));
        const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

        await flush();
        expect(started).toHaveLength(2);
        while (gates.length > 0 || started.length < ids.length) {
            gates.shift()?.();
            await flush();
        }
        expect(await Promise.all(jobs)).toEqual([null, null, null, null, null]);
        expect(peak).toBe(2);
        expect(started).toEqual(ids);
    });
});
