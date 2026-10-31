import { describe, expect, it } from 'vitest';
import {
    findLinkedMedia,
    hasPendingGifLink,
    MAX_LINKED_MEDIA,
    stripLinkedMediaLinks,
    type LinkedMediaEmbed,
} from '../../../src/services/linkedMedia/discordLinkedMedia';

const TENOR_PAGE = 'https://tenor.com/view/dancing-cat-gif-12345678';
const TENOR_EMBED: LinkedMediaEmbed = {
    type: 'gifv',
    url: TENOR_PAGE,
    video: {
        url: 'https://media.tenor.com/abcDEF123AAAPo/dancing-cat.mp4',
        proxyURL: 'https://images-ext-1.discordapp.net/external/x/y.mp4',
    },
    thumbnail: {
        url: 'https://media.tenor.com/abcDEF123AAAAe/dancing-cat.png',
    },
};

const GIPHY_PAGE = 'https://giphy.com/gifs/happy-dance-l0HlBO7eyXzSZkJri';
const GIPHY_EMBED: LinkedMediaEmbed = {
    type: 'gifv',
    url: GIPHY_PAGE,
    video: {
        url: 'https://media4.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.mp4',
    },
    thumbnail: {
        url: 'https://media4.giphy.com/media/l0HlBO7eyXzSZkJri/giphy_s.gif',
    },
};

const CDN_MP4 =
    'https://cdn.discordapp.com/attachments/1/2/clip%20one.mp4?ex=6700&is=6600&hm=abc123&';

describe('findLinkedMedia', () => {
    it('turns a lone Tenor link into its GIF rendition', () => {
        expect(findLinkedMedia(TENOR_PAGE, [TENOR_EMBED])).toEqual([
            {
                link: TENOR_PAGE,
                url: 'https://media.tenor.com/abcDEF123AAAAC/dancing-cat.gif',
                name: 'dancing-cat.gif',
                spoiler: false,
            },
        ]);
    });

    it('matches the embed loosely (trailing slash, scheme, www.)', () => {
        const link = 'http://www.tenor.com/view/dancing-cat-gif-12345678/';
        expect(findLinkedMedia(link, [TENOR_EMBED])[0]?.url).toBe(
            'https://media.tenor.com/abcDEF123AAAAC/dancing-cat.gif'
        );
    });

    it('uses the mp4 of a non-Tenor gifv embed, named after the page slug', () => {
        expect(findLinkedMedia(GIPHY_PAGE, [GIPHY_EMBED])).toEqual([
            {
                link: GIPHY_PAGE,
                url: 'https://media4.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.mp4',
                name: 'happy-dance.mp4',
                spoiler: false,
            },
        ]);
    });

    it('prefers a .gif image of a gifv embed over its mp4', () => {
        const embed: LinkedMediaEmbed = {
            type: 'gifv',
            url: 'https://klipy.com/gifs/wave',
            video: { url: 'https://static.klipy.com/a/wave.mp4' },
            image: { url: 'https://static.klipy.com/a/wave.gif' },
        };
        expect(findLinkedMedia('https://klipy.com/gifs/wave', [embed])).toEqual(
            [
                {
                    link: 'https://klipy.com/gifs/wave',
                    url: 'https://static.klipy.com/a/wave.gif',
                    name: 'wave.gif',
                    spoiler: false,
                },
            ]
        );
    });

    it('takes video embeds with a real video file', () => {
        const link = 'https://example.com/clips/42';
        const embed: LinkedMediaEmbed = {
            type: 'video',
            url: link,
            video: { url: 'https://example.com/files/clip.webm?sig=1' },
        };
        expect(findLinkedMedia(link, [embed])).toEqual([
            {
                link,
                url: 'https://example.com/files/clip.webm?sig=1',
                name: 'clip.webm',
                spoiler: false,
            },
        ]);
    });

    it('skips YouTube-style video embeds', () => {
        const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const embed: LinkedMediaEmbed = {
            type: 'video',
            url: link,
            video: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
            thumbnail: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg' },
        };
        expect(findLinkedMedia(link, [embed])).toEqual([]);
    });

    it('takes image embeds of a GIF only', () => {
        const gif = 'https://example.com/funny.gif';
        const png = 'https://example.com/funny.png';
        const embeds: LinkedMediaEmbed[] = [
            { type: 'image', url: gif, thumbnail: { url: gif } },
            { type: 'image', url: png, thumbnail: { url: png } },
        ];
        expect(
            findLinkedMedia(`${gif} ${png}`, embeds).map((m) => m.name)
        ).toEqual(['funny.gif']);
    });

    it('ignores links without a matching embed and other embed types', () => {
        expect(findLinkedMedia('https://example.com/a.gif', [])).toEqual([]);
        expect(
            findLinkedMedia(TENOR_PAGE, [{ ...TENOR_EMBED, type: 'rich' }])
        ).toEqual([]);
        expect(
            findLinkedMedia(TENOR_PAGE, [
                { ...TENOR_EMBED, url: 'https://tenor.com/view/other-gif-1' },
            ])
        ).toEqual([]);
    });

    it('downloads direct Discord CDN media links, keeping the query', () => {
        expect(findLinkedMedia(`look ${CDN_MP4}`, [])).toEqual([
            {
                link: CDN_MP4,
                url: CDN_MP4,
                name: 'clip one.mp4',
                spoiler: false,
            },
        ]);
        const gif = 'https://media.discordapp.net/attachments/1/2/Dance.GIF';
        expect(findLinkedMedia(gif, [])[0]?.name).toBe('Dance.GIF');
    });

    it('only trusts Discord hosts for direct links', () => {
        expect(
            findLinkedMedia(
                'https://cdn.discordapp.com.evil.example/a.mp4 https://example.com/b.mp4 https://cdn.discordapp.com/attachments/1/2/doc.pdf',
                []
            )
        ).toEqual([]);
    });

    it('skips links wrapped in <...>', () => {
        expect(findLinkedMedia(`<${TENOR_PAGE}>`, [TENOR_EMBED])).toEqual([]);
        expect(findLinkedMedia(`<${CDN_MP4}>`, [])).toEqual([]);
    });

    it('skips links in inline code and code blocks', () => {
        expect(findLinkedMedia(`\`${CDN_MP4}\``, [])).toEqual([]);
        expect(findLinkedMedia(`\`\`\`\n${CDN_MP4}\n\`\`\``, [])).toEqual([]);
    });

    it('marks links inside a spoiler', () => {
        const media = findLinkedMedia(`||${TENOR_PAGE}|| ${CDN_MP4}`, [
            TENOR_EMBED,
        ]);
        expect(media.map((m) => m.spoiler)).toEqual([true, false]);
    });

    it('trims trailing punctuation and markdown', () => {
        const link = 'https://cdn.discordapp.com/attachments/1/2/a.mp4';
        expect(findLinkedMedia(`(${link}).`, [])[0]?.link).toBe(link);
        expect(findLinkedMedia(`**${link}**`, [])[0]?.link).toBe(link);
    });

    it('deduplicates by link and keeps content order', () => {
        const a = 'https://cdn.discordapp.com/attachments/1/2/a.mp4';
        const b = 'https://cdn.discordapp.com/attachments/1/2/b.gif';
        expect(
            findLinkedMedia(`${b} ${a} ${b}`, []).map((m) => m.link)
        ).toEqual([b, a]);
    });

    it('stops at the cap', () => {
        const links = Array.from(
            { length: 6 },
            (_, i) => `https://cdn.discordapp.com/attachments/1/2/${i}.mp4`
        );
        expect(findLinkedMedia(links.join(' '), [])).toHaveLength(
            MAX_LINKED_MEDIA
        );
        expect(findLinkedMedia(links.join(' '), [], 2)).toHaveLength(2);
        expect(findLinkedMedia(links.join(' '), [], 0)).toEqual([]);
    });

    it('returns nothing for empty content', () => {
        expect(findLinkedMedia('', [TENOR_EMBED])).toEqual([]);
    });
});

describe('stripLinkedMediaLinks', () => {
    const media = findLinkedMedia(`${TENOR_PAGE} ${CDN_MP4}`, [TENOR_EMBED]);

    it('empties content that is only the links', () => {
        expect(stripLinkedMediaLinks(TENOR_PAGE, media)).toBe('');
        expect(
            stripLinkedMediaLinks(` ${TENOR_PAGE}\n${CDN_MP4} `, media)
        ).toBe('');
        expect(stripLinkedMediaLinks(`||${TENOR_PAGE}||`, media)).toBe('');
    });

    it('keeps content with other text unchanged', () => {
        const content = `lol ${TENOR_PAGE}`;
        expect(stripLinkedMediaLinks(content, media)).toBe(content);
    });

    it('keeps content when nothing was found', () => {
        expect(stripLinkedMediaLinks(TENOR_PAGE, [])).toBe(TENOR_PAGE);
    });
});

describe('hasPendingGifLink', () => {
    it.each([
        TENOR_PAGE,
        'https://tenor.com/en-GB/view/dancing-cat-gif-1',
        GIPHY_PAGE,
        'https://giphy.com/media/l0HlBO7eyXzSZkJri',
        'https://klipy.com/gifs/wave',
    ])('is true for an unembedded %s', (link) => {
        expect(hasPendingGifLink(`hey ${link}`, [])).toBe(true);
    });

    it('is false once an embed matches', () => {
        expect(hasPendingGifLink(TENOR_PAGE, [TENOR_EMBED])).toBe(false);
    });

    it('is false for other links, suppressed links and code', () => {
        expect(hasPendingGifLink('https://example.com/view/x', [])).toBe(false);
        expect(hasPendingGifLink('https://tenor.com/', [])).toBe(false);
        expect(hasPendingGifLink(`<${TENOR_PAGE}>`, [])).toBe(false);
        expect(hasPendingGifLink(`\`${TENOR_PAGE}\``, [])).toBe(false);
        expect(hasPendingGifLink('', [])).toBe(false);
    });
});
