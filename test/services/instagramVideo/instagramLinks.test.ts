import { describe, expect, it } from 'vitest';
import {
    findInstagramLinks,
    instagramShortcode,
} from '../../../src/services/instagramVideo/instagramLinks';

const urls = (content: string, max = 10) =>
    findInstagramLinks(content, max).map((link) => link.url);

describe('findInstagramLinks', () => {
    it.each([
        ['https://www.instagram.com/p/ABC123/', 'p/ABC123'],
        ['https://instagram.com/p/ABC123', 'p/ABC123'],
        ['http://instagram.com/p/ABC123/', 'p/ABC123'],
        ['https://m.instagram.com/p/ABC123/', 'p/ABC123'],
        ['https://www.instagram.com/reel/C_x-9Yz/', 'reel/C_x-9Yz'],
        ['https://www.instagram.com/reels/C_x-9Yz/', 'reel/C_x-9Yz'],
        ['https://www.instagram.com/tv/B1tv2/', 'tv/B1tv2'],
        [
            'https://www.instagram.com/reel/ABC/?igsh=MWQ1ZGUxMzBkMA==',
            'reel/ABC',
        ],
        ['https://www.instagram.com/p/ABC/?utm_source=ig_web#frag', 'p/ABC'],
        ['https://www.instagram.com/some.user_1/reel/ABC/', 'reel/ABC'],
        ['https://instagram.com/someuser/p/ABC', 'p/ABC'],
        ['HTTPS://WWW.INSTAGRAM.COM/REEL/AbC/', 'reel/AbC'],
        // Embed-fixer redirect sites (issue #52).
        ['https://www.kkinstagram.com/reel/ABC/', 'reel/ABC'],
        ['https://kkinstagram.com/p/ABC/?igsh=x', 'p/ABC'],
        ['https://www.ddinstagram.com/reel/ABC/', 'reel/ABC'],
        ['https://d.ddinstagram.com/p/ABC/', 'p/ABC'],
        ['https://g.ddinstagram.com/reel/ABC/', 'reel/ABC'],
        ['https://vxinstagram.com/reels/ABC/', 'reel/ABC'],
        ['https://uuinstagram.com/p/ABC/', 'p/ABC'],
        ['https://eeinstagram.com/p/ABC/', 'p/ABC'],
        ['https://www.instagramez.com/reel/ABC/', 'reel/ABC'],
        ['https://kkinstagram.com/some.user/reel/ABC/', 'reel/ABC'],
    ])('canonicalises %s', (url, path) => {
        expect(urls(`look ${url} wow`)).toEqual([
            `https://www.instagram.com/${path}/`,
        ]);
    });

    it.each([
        'https://www.instagram.com/someuser/',
        'https://www.instagram.com/stories/someuser/1234567890/',
        'https://www.instagram.com/explore/tags/cats/',
        'https://www.instagram.com/',
        'https://notinstagram.com/p/ABC/',
        'https://instagram.com.evil.example/p/ABC/',
        'https://kkinstagram.com.evil.example/p/ABC/',
        'https://xxkkinstagram.com/p/ABC/',
        'https://kkinstagram.com/someuser/',
        'https://www.youtube.com/watch?v=abc',
        'instagram.com/p/ABC/',
        'xhttps://instagram.com/p/ABC/',
        'https://www.instagram.com/p/',
    ])('ignores %s', (url) => {
        expect(urls(`see ${url}`)).toEqual([]);
    });

    it('returns nothing for empty content or a zero cap', () => {
        expect(findInstagramLinks('', 5)).toEqual([]);
        expect(findInstagramLinks('https://instagram.com/p/ABC/', 0)).toEqual(
            []
        );
    });

    it('keeps order and deduplicates by canonical URL', () => {
        expect(
            urls(
                [
                    'https://instagram.com/reel/B/',
                    'https://www.instagram.com/p/A/?igsh=x',
                    'https://m.instagram.com/reels/B',
                    'https://www.instagram.com/p/A/',
                ].join(' ')
            )
        ).toEqual([
            'https://www.instagram.com/reel/B/',
            'https://www.instagram.com/p/A/',
        ]);
    });

    it('stops at the cap', () => {
        const content =
            'https://instagram.com/p/A/ https://instagram.com/p/B/ https://instagram.com/p/C/';
        expect(urls(content, 2)).toEqual([
            'https://www.instagram.com/p/A/',
            'https://www.instagram.com/p/B/',
        ]);
    });

    it('stops the URL at trailing punctuation and markup', () => {
        expect(urls('(https://instagram.com/p/ABC).')).toEqual([
            'https://www.instagram.com/p/ABC/',
        ]);
        expect(urls('**https://instagram.com/p/ABC/**')).toEqual([
            'https://www.instagram.com/p/ABC/',
        ]);
    });

    it('skips links wrapped in <...>', () => {
        expect(
            urls(
                '<https://www.instagram.com/p/HIDDEN/> https://www.instagram.com/p/SHOWN/'
            )
        ).toEqual(['https://www.instagram.com/p/SHOWN/']);
        expect(urls('<https://instagram.com/reel/X/?igsh=1>')).toEqual([]);
    });

    it('skips links in inline code and code blocks', () => {
        expect(urls('`https://instagram.com/p/A/`')).toEqual([]);
        expect(urls('``https://instagram.com/p/A/``')).toEqual([]);
        expect(
            urls(
                '```\nhttps://instagram.com/p/A/\n``` https://instagram.com/p/B/'
            )
        ).toEqual(['https://www.instagram.com/p/B/']);
    });

    describe('spoilers', () => {
        it('marks a link inside a spoiler', () => {
            expect(
                findInstagramLinks('||https://instagram.com/reel/A/||', 5)
            ).toEqual([
                { url: 'https://www.instagram.com/reel/A/', spoiler: true },
            ]);
        });

        it('marks a link inside a spoiler with other text', () => {
            expect(
                findInstagramLinks(
                    'ending: || watch https://instagram.com/reel/A/ lol ||',
                    5
                )[0].spoiler
            ).toBe(true);
        });

        it('does not mark links outside spoilers', () => {
            expect(
                findInstagramLinks(
                    '||secret|| https://instagram.com/p/A/ ||more||',
                    5
                )
            ).toEqual([
                { url: 'https://www.instagram.com/p/A/', spoiler: false },
            ]);
        });

        it('handles several spoiler pairs', () => {
            const links = findInstagramLinks(
                '||https://instagram.com/p/A/|| https://instagram.com/p/B/ ||https://instagram.com/p/C/||',
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
                findInstagramLinks('|| https://instagram.com/p/A/', 5)[0]
                    .spoiler
            ).toBe(false);
        });

        it('ignores escaped pipes and pipes in code', () => {
            expect(
                findInstagramLinks(
                    '\\|\\| https://instagram.com/p/A/ \\|\\|',
                    5
                )[0].spoiler
            ).toBe(false);
            expect(
                findInstagramLinks('`||` https://instagram.com/p/A/ `||`', 5)[0]
                    .spoiler
            ).toBe(false);
        });
    });
});

describe('instagramShortcode', () => {
    it('extracts the shortcode', () => {
        expect(
            instagramShortcode('https://www.instagram.com/reel/ABC_1-x/')
        ).toBe('ABC_1-x');
        expect(instagramShortcode('https://example.com/')).toBeNull();
    });
});
