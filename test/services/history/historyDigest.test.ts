import { describe, expect, it } from 'vitest';
import WebhookEmbed from '../../../src/services/WebhookEmbed';
import { WebhookMessageData } from '../../../src/services/WebhookService';
import {
    DIGEST_ENTRY_SEPARATOR,
    DIGEST_MAX_CHARS,
    DIGEST_MAX_FILES,
    DigestEntry,
    digestHeader,
    formatDigestLine,
    packDigest,
    timestampTag,
    truncateText,
} from '../../../src/services/history/historyDigest';
import {
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
} from '../../../src/utils/embeds';

const IDENTITY = { username: 'Bifröst', avatarURL: 'https://bot/avatar.png' };
const WHEN = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
const UNIX = Math.floor(WHEN.getTime() / 1000);

function entry(
    sourceId: string,
    content: string,
    payload: Partial<WebhookMessageData> = {},
    overrides: Partial<Omit<DigestEntry, 'payload' | 'sourceId'>> = {}
): DigestEntry {
    return {
        sourceId,
        authorName: 'Alice',
        createdAt: WHEN,
        payload: {
            content,
            username: 'Alice',
            avatarURL: 'https://alice.png',
            ...payload,
        },
        ...overrides,
    };
}

function attachment(name: string, spoiler = false) {
    return { url: `https://cdn/${name}`, name, spoiler };
}

function embed(description: string) {
    return new WebhookEmbed({ description });
}

describe('formatDigestLine', () => {
    it('heads the content with the author and the original time', () => {
        expect(formatDigestLine(entry('1', 'hello'), true)).toBe(
            `-# **Alice** · <t:${UNIX}:f>\nhello`
        );
        expect(timestampTag(WHEN)).toBe(`<t:${UNIX}:f>`);
    });

    it('leaves the time out without timestamps', () => {
        expect(formatDigestLine(entry('1', 'hello'), false)).toBe(
            '-# **Alice**\nhello'
        );
        expect(digestHeader(entry('1', ''), false)).toBe('-# **Alice**');
    });

    it('is the header alone for empty content', () => {
        expect(formatDigestLine(entry('1', ''), true)).toBe(
            `-# **Alice** · <t:${UNIX}:f>`
        );
    });

    it('keeps multi-line content and notes each attachment', () => {
        const line = formatDigestLine(
            entry('1', 'line one\nline two', {
                attachments: [attachment('cat.png'), attachment('dog.jpg')],
            }),
            false
        );
        expect(line).toBe(
            '-# **Alice**\nline one\nline two\n📎 cat.png\n📎 dog.jpg'
        );
    });

    it('uses the entry author name, not the payload username', () => {
        const line = formatDigestLine(
            entry(
                '1',
                'x',
                { username: 'webhook-name' },
                { authorName: 'Bob' }
            ),
            false
        );
        expect(line.startsWith('-# **Bob**')).toBe(true);
    });
});

describe('truncateText', () => {
    it('cuts with an ellipsis only when too long', () => {
        expect(truncateText('hello', 5)).toBe('hello');
        expect(truncateText('hello', 4)).toBe('hel…');
        expect(truncateText('hello', 4)).toHaveLength(4);
        expect(truncateText('hello', 1)).toBe('…');
        expect(truncateText('hello', 0)).toBe('');
    });

    it('closes a spoiler cut in half so it stays hidden', () => {
        expect(truncateText('spoiler: ||the ending||', 16)).toBe(
            'spoiler: ||th…||'
        );
    });
});

describe('packDigest', () => {
    it('returns no posts for no entries', () => {
        expect(packDigest([], IDENTITY, true)).toEqual([]);
    });

    it('packs a few entries into one post as the bot, without pings', () => {
        const posts = packDigest(
            [
                entry('1', 'first', { mentionUserIds: ['u1'] }),
                entry('2', 'second', { mentionRoleIds: ['r1'] }),
            ],
            IDENTITY,
            false
        );
        expect(posts).toHaveLength(1);
        const [post] = posts;
        expect(post.sourceIds).toEqual(['1', '2']);
        expect(post.payload).toEqual({
            content: `-# **Alice**\nfirst${DIGEST_ENTRY_SEPARATOR}-# **Alice**\nsecond`,
            username: IDENTITY.username,
            avatarURL: IDENTITY.avatarURL,
            suppressMentions: true,
        });
        expect(post.payload).not.toHaveProperty('mentionUserIds');
        expect(post.payload).not.toHaveProperty('mentionRoleIds');
        expect(post.payload).not.toHaveProperty('attachments');
        expect(post.payload).not.toHaveProperty('embeds');
    });

    it('includes the timestamp headers when asked', () => {
        const [post] = packDigest([entry('1', 'first')], IDENTITY, true);
        expect(post.payload.content).toBe(
            `-# **Alice** · <t:${UNIX}:f>\nfirst`
        );
    });

    it('flushes a post when the next entry would exceed the character limit', () => {
        const entries = Array.from({ length: 10 }, (_, i) =>
            entry(String(i), 'x'.repeat(400))
        );
        const posts = packDigest(entries, IDENTITY, false);
        // Each entry is 12 + 1 + 400 = 413 chars; four fit (4*413 + 3*2 = 1658), five do not.
        expect(posts.map((p) => p.sourceIds)).toEqual([
            ['0', '1', '2', '3'],
            ['4', '5', '6', '7'],
            ['8', '9'],
        ]);
        for (const post of posts) {
            expect(post.payload.content.length).toBeLessThanOrEqual(
                DIGEST_MAX_CHARS
            );
            expect(
                post.payload.content.split(DIGEST_ENTRY_SEPARATOR)
            ).toHaveLength(post.sourceIds.length);
        }
    });

    it('honours a custom character limit', () => {
        const posts = packDigest(
            [entry('1', 'aaaa'), entry('2', 'bbbb'), entry('3', 'cccc')],
            IDENTITY,
            false,
            { maxChars: 40 }
        );
        // Each entry is 17 chars; two make 36, three would be 55.
        expect(posts.map((p) => p.sourceIds)).toEqual([['1', '2'], ['3']]);
    });

    it('flushes by attachment count and carries the attachments as files', () => {
        const entries = [1, 2, 3].map((i) =>
            entry(String(i), `m${i}`, {
                attachments: [
                    attachment(`${i}a.png`),
                    attachment(`${i}b.png`, true),
                    attachment(`${i}c.png`),
                    attachment(`${i}d.png`),
                ],
            })
        );
        const posts = packDigest(entries, IDENTITY, false);
        expect(DIGEST_MAX_FILES).toBe(10);
        expect(posts.map((p) => p.sourceIds)).toEqual([['1', '2'], ['3']]);
        expect(posts[0].payload.attachments?.map((a) => a.name)).toEqual([
            '1a.png',
            '1b.png',
            '1c.png',
            '1d.png',
            '2a.png',
            '2b.png',
            '2c.png',
            '2d.png',
        ]);
        expect(posts[0].payload.attachments?.[1].spoiler).toBe(true);
        expect(posts[0].payload.content).toContain('📎 2d.png');
        expect(posts[1].payload.attachments).toHaveLength(4);
    });

    it('flushes by embed count and carries the embeds', () => {
        const entries = [1, 2, 3].map((i) =>
            entry(String(i), `m${i}`, { embeds: [embed(`e${i}`)] })
        );
        const posts = packDigest(entries, IDENTITY, false, { maxEmbeds: 2 });
        expect(posts.map((p) => p.sourceIds)).toEqual([['1', '2'], ['3']]);
        expect(posts[0].payload.embeds).toHaveLength(2);
        expect(posts[0].payload.embeds?.[1].toPlainObject().description).toBe(
            'e2'
        );
        expect(posts[1].payload.embeds).toHaveLength(1);
    });

    it('flushes by summed embed characters', () => {
        const entries = [1, 2].map((i) =>
            entry(String(i), `m${i}`, { embeds: [embed('x'.repeat(3500))] })
        );
        expect(EMBED_TOTAL_CHARS_MAX).toBe(6000);
        const posts = packDigest(entries, IDENTITY, false);
        expect(posts.map((p) => p.sourceIds)).toEqual([['1'], ['2']]);
    });

    it('truncates an entry whose content alone exceeds the limit', () => {
        const long = entry('1', 'y'.repeat(5000), {
            attachments: [attachment('a.png')],
        });
        const posts = packDigest(
            [entry('0', 'short'), long, entry('2', 'after')],
            IDENTITY,
            false
        );
        expect(posts.map((p) => p.sourceIds)).toEqual([['0'], ['1'], ['2']]);
        const content = posts[1].payload.content;
        expect(content.length).toBe(DIGEST_MAX_CHARS);
        expect(content.startsWith('-# **Alice**\nyyy')).toBe(true);
        expect(content.endsWith('…\n📎 a.png')).toBe(true);
    });

    it('drops extra attachments and embeds of an oversize entry', () => {
        const big = entry('1', 'm', {
            attachments: Array.from({ length: 15 }, (_, i) =>
                attachment(`${i}.png`)
            ),
            embeds: Array.from({ length: 12 }, (_, i) => embed(`e${i}`)),
        });
        const [post] = packDigest([big], IDENTITY, false);
        expect(post.payload.attachments).toHaveLength(DIGEST_MAX_FILES);
        expect(post.payload.embeds).toHaveLength(EMBEDS_PER_MESSAGE_MAX);
        expect(post.payload.content.match(/📎/g)).toHaveLength(
            DIGEST_MAX_FILES
        );
        expect(post.sourceIds).toEqual(['1']);
    });

    it('drops embeds of an oversize entry beyond the embed character total', () => {
        const big = entry('1', 'm', {
            embeds: [
                embed('a'.repeat(4000)),
                embed('b'.repeat(4000)),
                embed('c'),
            ],
        });
        const [post] = packDigest([big], IDENTITY, false);
        // The second embed does not fit; the third is dropped with it to keep order.
        expect(
            post.payload.embeds?.map((e) => e.toPlainObject().description)
        ).toEqual(['a'.repeat(4000)]);
    });

    it('cuts the whole text when even the header does not fit', () => {
        const [post] = packDigest(
            [
                entry(
                    '1',
                    'hello',
                    {},
                    { authorName: 'A very long author name' }
                ),
            ],
            IDENTITY,
            false,
            { maxChars: 10 }
        );
        expect(post.payload.content).toHaveLength(10);
        expect(post.payload.content.endsWith('…')).toBe(true);
    });

    it('keeps every entry in exactly one post, in order', () => {
        const entries = Array.from({ length: 50 }, (_, i) =>
            entry(String(i), 'z'.repeat(50 + (i % 7) * 100))
        );
        const posts = packDigest(entries, IDENTITY, true);
        expect(posts.length).toBeGreaterThan(1);
        expect(posts.flatMap((p) => p.sourceIds)).toEqual(
            entries.map((e) => e.sourceId)
        );
    });
});
