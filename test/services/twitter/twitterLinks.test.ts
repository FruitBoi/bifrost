import { describe, expect, it } from 'vitest';
import {
    findTweetLinks,
    isKnownTwitterHost,
    KNOWN_TWITTER_HOSTS,
} from '../../../src/services/twitter/twitterLinks';

const urls = (
    content: string,
    max = 10,
    options?: Parameters<typeof findTweetLinks>[2]
) => findTweetLinks(content, max, options).map((link) => link.url);

describe('findTweetLinks', () => {
    it.each([
        'https://twitter.com/jack/status/20',
        'http://twitter.com/jack/status/20',
        'https://x.com/jack/status/20',
        'https://www.twitter.com/jack/status/20',
        'https://www.x.com/jack/status/20',
        'https://mobile.twitter.com/jack/status/20',
        'https://mobile.x.com/jack/status/20',
        'https://fxtwitter.com/jack/status/20',
        'https://fixupx.com/jack/status/20',
        'https://vxtwitter.com/jack/status/20',
        'https://fixvx.com/jack/status/20',
        'https://d.fxtwitter.com/jack/status/20',
        'https://g.fxtwitter.com/jack/status/20',
        'https://d.vxtwitter.com/jack/status/20',
        'https://twittpr.com/jack/status/20',
        'https://xcancel.com/jack/status/20',
        'https://nitter.net/jack/status/20',
        'HTTPS://X.COM/jack/status/20',
        'https://x.com/jack/statuses/20',
        'https://x.com/jack/status/20/photo/1',
        'https://x.com/jack/status/20/video/2',
        'https://x.com/jack/status/20/en',
        'https://x.com/jack/status/20?s=46&t=abc',
        'https://x.com/jack/status/20#frag',
        'https://fixvx.com/jack/status/20?s=1',
    ])('canonicalises %s', (url) => {
        const links = findTweetLinks(`look ${url} wow`, 10);
        expect(links).toHaveLength(1);
        expect(links[0].url).toBe('https://x.com/jack/status/20');
        expect(links[0].id).toBe('20');
        expect(links[0].username).toBe('jack');
        expect(links[0].knownHost).toBe(true);
        expect(links[0].spoiler).toBe(false);
    });

    it('reports the lower-cased host without www.', () => {
        expect(
            findTweetLinks('https://www.FixVX.com/jack/status/1', 5)[0].host
        ).toBe('fixvx.com');
        expect(
            findTweetLinks('https://mobile.x.com/jack/status/1', 5)[0].host
        ).toBe('mobile.x.com');
        expect(
            findTweetLinks('https://d.fxtwitter.com/jack/status/1', 5)[0].host
        ).toBe('d.fxtwitter.com');
    });

    it('keeps the original case of the username', () => {
        const link = findTweetLinks('https://x.com/NASA_Gov/status/5', 5)[0];
        expect(link.username).toBe('NASA_Gov');
        expect(link.url).toBe('https://x.com/NASA_Gov/status/5');
    });

    it.each([
        'https://x.com/i/status/123',
        'https://twitter.com/i/web/status/123',
        'https://fixvx.com/i/status/123?s=1',
    ])('handles the username-less %s', (url) => {
        const links = findTweetLinks(url, 5);
        expect(links).toHaveLength(1);
        expect(links[0].url).toBe('https://x.com/i/status/123');
        expect(links[0].username).toBeNull();
    });

    it.each([
        'https://x.com/jack',
        'https://x.com/jack/',
        'https://x.com/home',
        'https://x.com/search?q=cats',
        'https://x.com/explore',
        'https://x.com/jack/status/',
        'https://x.com/jack/status/abc',
        'https://x.com/jack/status/20abc',
        'https://x.com/jack/status/123456789012345678901',
        'https://x.com/thisusernameistoolong/status/20',
        'https://x.com/jack/likes',
        'https://x.com/i/lists/123',
        'https://x.com/hashtag/status/',
        'x.com/jack/status/20',
        'xhttps://x.com/jack/status/20',
        'https://www.youtube.com/watch?v=abc',
    ])('ignores %s', (url) => {
        expect(urls(`see ${url}`)).toEqual([]);
        expect(urls(`see ${url}`, 10, { includeUnknownHosts: true })).toEqual(
            []
        );
    });

    it('returns nothing for empty content or a zero cap', () => {
        expect(findTweetLinks('', 5)).toEqual([]);
        expect(findTweetLinks('https://x.com/jack/status/20', 0)).toEqual([]);
    });

    it('keeps order and deduplicates by tweet id across hosts', () => {
        const links = findTweetLinks(
            [
                'https://x.com/b/status/2',
                'https://fixvx.com/a/status/1?s=1',
                'https://twitter.com/b/status/2',
                'https://d.fxtwitter.com/a/status/1',
                'https://x.com/i/status/2',
            ].join(' '),
            10
        );
        expect(links.map((link) => link.url)).toEqual([
            'https://x.com/b/status/2',
            'https://x.com/a/status/1',
        ]);
        expect(links[1].host).toBe('fixvx.com');
    });

    it('stops at the cap', () => {
        const content =
            'https://x.com/a/status/1 https://x.com/a/status/2 https://x.com/a/status/3';
        expect(urls(content, 2)).toEqual([
            'https://x.com/a/status/1',
            'https://x.com/a/status/2',
        ]);
    });

    it('stops the URL at trailing punctuation and markup', () => {
        expect(urls('(https://x.com/a/status/1).')).toEqual([
            'https://x.com/a/status/1',
        ]);
        expect(urls('**https://x.com/a/status/1**')).toEqual([
            'https://x.com/a/status/1',
        ]);
    });

    it('skips links wrapped in <...>', () => {
        expect(
            urls('<https://x.com/a/status/1> https://x.com/a/status/2')
        ).toEqual(['https://x.com/a/status/2']);
        expect(urls('<https://fixvx.com/a/status/1?s=1>')).toEqual([]);
    });

    it('skips links in inline code and code blocks', () => {
        expect(urls('`https://x.com/a/status/1`')).toEqual([]);
        expect(urls('``https://x.com/a/status/1``')).toEqual([]);
        expect(
            urls('```\nhttps://x.com/a/status/1\n``` https://x.com/a/status/2')
        ).toEqual(['https://x.com/a/status/2']);
    });

    describe('unknown hosts (alias discovery)', () => {
        const link = 'https://twxtter.example/jack/status/20';

        it('excludes them by default', () => {
            expect(urls(link)).toEqual([]);
            expect(urls(link, 10, { includeUnknownHosts: false })).toEqual([]);
        });

        it('returns them as unverified candidates when asked', () => {
            expect(
                findTweetLinks(`look ${link}/photo/1`, 5, {
                    includeUnknownHosts: true,
                })
            ).toEqual([
                {
                    url: 'https://x.com/jack/status/20',
                    id: '20',
                    username: 'jack',
                    host: 'twxtter.example',
                    knownHost: false,
                    spoiler: false,
                },
            ]);
        });

        it('supports www., ports and statuses on candidates', () => {
            const links = findTweetLinks(
                'https://www.Foo.Example:8443/jack/statuses/7',
                5,
                { includeUnknownHosts: true }
            );
            expect(links).toHaveLength(1);
            expect(links[0].host).toBe('foo.example');
            expect(links[0].knownHost).toBe(false);
        });

        it('ignores /i/status links on unknown hosts', () => {
            const opts = { includeUnknownHosts: true };
            expect(urls('https://foo.example/i/status/20', 5, opts)).toEqual(
                []
            );
            expect(
                urls('https://foo.example/i/web/status/20', 5, opts)
            ).toEqual([]);
        });

        it('ignores IP literals and localhost', () => {
            const opts = { includeUnknownHosts: true };
            expect(urls('http://127.0.0.1/jack/status/20', 5, opts)).toEqual(
                []
            );
            expect(
                urls('http://127.0.0.1:8080/jack/status/20', 5, opts)
            ).toEqual([]);
            expect(urls('http://localhost/jack/status/20', 5, opts)).toEqual(
                []
            );
            expect(
                urls('http://localhost:3000/jack/status/20', 5, opts)
            ).toEqual([]);
        });

        it('does not treat look-alike suffixes as known', () => {
            const links = findTweetLinks(
                'https://x.com.evil.example/a/status/1',
                5,
                {
                    includeUnknownHosts: true,
                }
            );
            expect(links[0].knownHost).toBe(false);
            expect(
                findTweetLinks('https://notfxtwitter.com/a/status/1', 5, {
                    includeUnknownHosts: true,
                })[0].knownHost
            ).toBe(false);
        });
    });

    describe('extraHosts', () => {
        const extraHosts = new Set(['tweets.example']);

        it('treats links on them as known, including /i/status', () => {
            const links = findTweetLinks(
                'https://tweets.example/jack/status/1 https://www.tweets.example/i/status/2',
                5,
                { extraHosts }
            );
            expect(links.map((link) => link.knownHost)).toEqual([true, true]);
            expect(links.map((link) => link.url)).toEqual([
                'https://x.com/jack/status/1',
                'https://x.com/i/status/2',
            ]);
        });

        it('does not apply without the option', () => {
            expect(urls('https://tweets.example/jack/status/1')).toEqual([]);
        });
    });

    describe('spoilers', () => {
        it('marks a link inside a spoiler', () => {
            expect(
                findTweetLinks('||https://x.com/a/status/1||', 5)[0].spoiler
            ).toBe(true);
        });

        it('marks a link inside a spoiler with other text', () => {
            expect(
                findTweetLinks(
                    'ending: || watch https://x.com/a/status/1 lol ||',
                    5
                )[0].spoiler
            ).toBe(true);
        });

        it('does not mark links outside spoilers', () => {
            expect(
                findTweetLinks(
                    '||secret|| https://x.com/a/status/1 ||more||',
                    5
                )[0].spoiler
            ).toBe(false);
        });

        it('handles several spoiler pairs', () => {
            const links = findTweetLinks(
                '||https://x.com/a/status/1|| https://x.com/a/status/2 ||https://x.com/a/status/3||',
                5
            );
            expect(links.map((link) => link.spoiler)).toEqual([
                true,
                false,
                true,
            ]);
        });

        it('does not count an unclosed spoiler', () => {
            expect(
                findTweetLinks('|| https://x.com/a/status/1', 5)[0].spoiler
            ).toBe(false);
        });

        it('ignores escaped pipes and pipes in code', () => {
            expect(
                findTweetLinks('\\|\\| https://x.com/a/status/1 \\|\\|', 5)[0]
                    .spoiler
            ).toBe(false);
            expect(
                findTweetLinks('`||` https://x.com/a/status/1 `||`', 5)[0]
                    .spoiler
            ).toBe(false);
        });
    });
});

describe('isKnownTwitterHost', () => {
    it.each([
        'twitter.com',
        'x.com',
        'WWW.X.COM',
        'mobile.twitter.com',
        'm.twitter.com',
        'fixvx.com',
        'www.fxtwitter.com',
        'd.fxtwitter.com',
        'g.fxtwitter.com',
        'api.fxtwitter.com',
        'd.vxtwitter.com',
        'fixupx.com',
        'd.fixupx.com',
        'girlcockx.com',
        'stupidpenisx.com',
        'nitter.poast.org',
    ])('knows %s', (host) => {
        expect(isKnownTwitterHost(host)).toBe(true);
    });

    it.each([
        'example.com',
        'notx.com',
        'x.com.evil.example',
        'notfxtwitter.com',
        'fxtwitter.com.evil.example',
        'foo.twitter.com',
        'instagram.com',
        '',
    ])('does not know %s', (host) => {
        expect(isKnownTwitterHost(host)).toBe(false);
    });

    it('honours extraHosts', () => {
        const extra = new Set(['alias.example']);
        expect(isKnownTwitterHost('alias.example')).toBe(false);
        expect(isKnownTwitterHost('alias.example', extra)).toBe(true);
        expect(isKnownTwitterHost('www.Alias.Example', extra)).toBe(true);
    });

    it('exposes a lower-case set without www.', () => {
        for (const host of KNOWN_TWITTER_HOSTS) {
            expect(host).toBe(host.toLowerCase());
            expect(host.startsWith('www.')).toBe(false);
        }
        expect(KNOWN_TWITTER_HOSTS.has('twitter.com')).toBe(true);
        expect(KNOWN_TWITTER_HOSTS.has('x.com')).toBe(true);
    });
});
