import { describe, expect, it } from 'vitest';
import {
    MAX_SYNDICATION_BYTES,
    decodeEntities,
    fetchTweet,
    isTwitterCdnUrl,
    parseTweetResult,
    syndicationToken,
    tweetSyndicationUrl,
} from '../../../src/services/twitter/tweetSyndication';

const PHOTO = 'https://pbs.twimg.com/media/Fabc123.jpg';
const AVATAR = 'https://pbs.twimg.com/profile_images/1/me_normal.jpg';

/** A minimal syndication `tweet-result` body. */
function tweetJson(extra: Record<string, unknown> = {}) {
    return {
        __typename: 'Tweet',
        id_str: '1683920951807971329',
        text: 'Hello &amp; welcome &lt;3 https://t.co/link https://t.co/media',
        display_text_range: [0, 46],
        entities: {
            urls: [
                {
                    url: 'https://t.co/link',
                    expanded_url: 'https://example.com/page',
                    display_url: 'example.com/page',
                },
            ],
            media: [{ url: 'https://t.co/media' }],
        },
        user: {
            screen_name: 'NASA',
            name: 'NASA Space',
            profile_image_url_https: AVATAR,
        },
        mediaDetails: [{ type: 'photo', media_url_https: PHOTO }],
        ...extra,
    };
}

const video = (variants: Array<Record<string, unknown>>, extra = {}) => ({
    type: 'video',
    media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg',
    video_info: { duration_millis: 12_500, variants },
    ...extra,
});

describe('syndicationToken', () => {
    it('matches the embed script formula', () => {
        const id = '1683920951807971329';
        expect(syndicationToken(id)).toBe(
            ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
        );
        expect(syndicationToken(id)).toBe('42y6zv7ufp');
    });

    it('handles tiny ids', () => {
        expect(() => syndicationToken('20')).not.toThrow();
        expect(syndicationToken('20')).toMatch(/^[0-9a-z]+$/);
    });

    it('builds the endpoint URL', () => {
        const url = new URL(tweetSyndicationUrl('20'));
        expect(url.origin).toBe('https://cdn.syndication.twimg.com');
        expect(url.pathname).toBe('/tweet-result');
        expect(url.searchParams.get('id')).toBe('20');
        expect(url.searchParams.get('lang')).toBe('en');
        expect(url.searchParams.get('token')).toBe(syndicationToken('20'));
    });
});

describe('isTwitterCdnUrl', () => {
    it('accepts https twimg hosts only', () => {
        expect(isTwitterCdnUrl(PHOTO)).toBe(true);
        expect(isTwitterCdnUrl('https://video.twimg.com/a.mp4')).toBe(true);
        expect(isTwitterCdnUrl('http://video.twimg.com/a.mp4')).toBe(false);
        expect(isTwitterCdnUrl('https://twimg.com/a.mp4')).toBe(false);
        expect(isTwitterCdnUrl('https://eviltwimg.com/a.mp4')).toBe(false);
        expect(isTwitterCdnUrl('https://video.twimg.com.evil.io/a')).toBe(
            false
        );
        expect(isTwitterCdnUrl('https://u:p@video.twimg.com/a')).toBe(false);
        expect(isTwitterCdnUrl('https://video.twimg.com:8443/a')).toBe(false);
        expect(isTwitterCdnUrl('not a url')).toBe(false);
    });
});

describe('decodeEntities', () => {
    it('decodes &amp; last so escapes stay literal', () => {
        expect(decodeEntities('a &amp;lt; b &lt; c &gt; d')).toBe(
            'a &lt; b < c > d'
        );
    });
});

describe('parseTweetResult', () => {
    it('reads author, text and a photo', () => {
        expect(parseTweetResult(tweetJson())).toEqual({
            id: '1683920951807971329',
            screenName: 'NASA',
            name: 'NASA Space',
            profileImageUrl: AVATAR,
            text: 'Hello & welcome <3 https://example.com/page',
            media: [
                {
                    kind: 'image',
                    urls: [`${PHOTO}?name=large`, `${PHOTO}?name=medium`],
                    durationSeconds: null,
                },
            ],
        });
    });

    it('prefers the long note_tweet text and its links', () => {
        const tweet = parseTweetResult(
            tweetJson({
                note_tweet: {
                    note_tweet_results: {
                        result: {
                            text: 'A very long text https://t.co/long',
                            entity_set: {
                                urls: [
                                    {
                                        url: 'https://t.co/long',
                                        expanded_url: 'https://long.example/',
                                    },
                                ],
                            },
                        },
                    },
                },
            })
        );
        expect(tweet!.text).toBe('A very long text https://long.example/');
    });

    it('drops leading reply mentions hidden by display_text_range', () => {
        const tweet = parseTweetResult(
            tweetJson({
                text: '@alice @bob nice one',
                display_text_range: [12, 20],
                entities: {},
                mediaDetails: [],
            })
        );
        expect(tweet!.text).toBe('nice one');
        expect(tweet!.media).toEqual([]);
    });

    it('cuts trailing media links after display_text_range', () => {
        const tweet = parseTweetResult(
            tweetJson({
                text: '@bob look https://t.co/abc',
                display_text_range: [5, 9],
                entities: {},
            })
        );
        expect(tweet!.text).toBe('look');
    });

    it('keeps text when the range start is not just mentions', () => {
        const tweet = parseTweetResult(
            tweetJson({
                text: 'Tom &amp; Jerry',
                display_text_range: [4, 15],
                entities: {},
            })
        );
        expect(tweet!.text).toBe('Tom & Jerry');
    });

    it('returns null text for a media-only tweet', () => {
        const tweet = parseTweetResult(
            tweetJson({
                text: 'https://t.co/media',
                display_text_range: [0, 0],
                entities: {},
            })
        );
        expect(tweet!.text).toBeNull();
    });

    it('sorts mp4 video variants by bitrate and skips HLS', () => {
        const tweet = parseTweetResult(
            tweetJson({
                mediaDetails: [
                    video([
                        {
                            content_type: 'application/x-mpegURL',
                            url: 'https://video.twimg.com/pl.m3u8',
                        },
                        {
                            bitrate: 832000,
                            content_type: 'video/mp4',
                            url: 'https://video.twimg.com/mid.mp4',
                        },
                        {
                            bitrate: 2176000,
                            content_type: 'video/mp4',
                            url: 'https://video.twimg.com/high.mp4',
                        },
                        {
                            bitrate: 256000,
                            content_type: 'video/mp4',
                            url: 'https://video.twimg.com/low.mp4',
                        },
                    ]),
                ],
            })
        );
        expect(tweet!.media).toEqual([
            {
                kind: 'video',
                urls: [
                    'https://video.twimg.com/high.mp4',
                    'https://video.twimg.com/mid.mp4',
                    'https://video.twimg.com/low.mp4',
                ],
                durationSeconds: 12.5,
            },
        ]);
    });

    it('treats animated GIFs as videos and caps media at four', () => {
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
        const photo = { type: 'photo', media_url_https: PHOTO };
        const tweet = parseTweetResult(
            tweetJson({ mediaDetails: [gif, photo, photo, photo, photo] })
        );
        expect(tweet!.media).toHaveLength(4);
        expect(tweet!.media[0]).toEqual({
            kind: 'video',
            urls: ['https://video.twimg.com/tweet_video/g.mp4'],
            durationSeconds: null,
        });
    });

    it('skips videos without an mp4 variant', () => {
        const tweet = parseTweetResult(
            tweetJson({
                mediaDetails: [
                    video([
                        {
                            content_type: 'application/x-mpegURL',
                            url: 'https://video.twimg.com/pl.m3u8',
                        },
                    ]),
                ],
            })
        );
        expect(tweet!.media).toEqual([]);
    });

    it('rejects tombstones, empty objects and junk', () => {
        expect(parseTweetResult({})).toBeNull();
        expect(parseTweetResult({ __typename: 'TweetTombstone' })).toBeNull();
        expect(parseTweetResult(null)).toBeNull();
        expect(parseTweetResult([1, 2])).toBeNull();
        expect(parseTweetResult({ text: 'no id' })).toBeNull();
    });
});

describe('fetchTweet', () => {
    const respond = (body: BodyInit | null, status = 200, headers = {}) =>
        (async () =>
            new Response(body, { status, headers })) as unknown as typeof fetch;

    it('fetches the endpoint with an honest, credential-free request', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl = (async (input: string, init?: RequestInit) => {
            calls.push({ url: String(input), init });
            return new Response(JSON.stringify(tweetJson()), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await fetchTweet('1683920951807971329', {
            fetchImpl,
            timeoutMs: 1000,
        });

        expect(result.status).toBe('ok');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(tweetSyndicationUrl('1683920951807971329'));
        const headers = calls[0].init!.headers as Record<string, string>;
        expect(headers['User-Agent']).toMatch(/Bifrost/);
        expect(Object.keys(headers).join(' ')).not.toMatch(
            /cookie|authorization|csrf|guest/i
        );
        expect(calls[0].init!.signal).toBeDefined();
    });

    it('reports 404, empty bodies and tombstones as missing', async () => {
        const options = { timeoutMs: 1000 };
        for (const fetchImpl of [
            respond('not found', 404),
            respond('', 200),
            respond('{}', 200),
            respond(JSON.stringify({ __typename: 'TweetTombstone' }), 200),
        ]) {
            expect(await fetchTweet('1', { ...options, fetchImpl })).toEqual({
                status: 'missing',
            });
        }
    });

    it('reports other errors as failed', async () => {
        const options = { timeoutMs: 1000 };
        const throwing = (async () => {
            throw new Error('ECONNRESET');
        }) as unknown as typeof fetch;
        const cases: Array<[typeof fetch, RegExp]> = [
            [respond('busy', 503), /HTTP 503/],
            [respond('<html>', 200), /not JSON/],
            [respond('[]', 200), /no tweet data/],
            [throwing, /ECONNRESET/],
            [
                respond('{}', 200, {
                    'content-length': String(MAX_SYNDICATION_BYTES + 1),
                }),
                /over/,
            ],
        ];
        for (const [fetchImpl, reason] of cases) {
            const result = await fetchTweet('1', { ...options, fetchImpl });
            expect(result.status).toBe('failed');
            expect(result.status === 'failed' && result.reason).toMatch(reason);
        }
    });
});
