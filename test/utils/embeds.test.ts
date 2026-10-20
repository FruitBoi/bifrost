import { describe, expect, it } from 'vitest';
import {
    batchEmbeds,
    chunkDescriptionLines,
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
    embedCharCount,
    type EmbedLike,
} from '../../src/utils/embeds';

function embed(
    description: string,
    extra: Partial<EmbedLike['data']> = {}
): EmbedLike {
    return { data: { description, ...extra } };
}

describe('chunkDescriptionLines', () => {
    it('keeps lines together while they fit', () => {
        expect(chunkDescriptionLines(['a', 'b', 'c'])).toEqual([
            ['a', 'b', 'c'],
        ]);
    });

    it('counts the separator towards the max', () => {
        // 'aaaa' + '\n\n' + 'bbbb' = 10 chars
        expect(chunkDescriptionLines(['aaaa', 'bbbb'], '\n\n', 10)).toEqual([
            ['aaaa', 'bbbb'],
        ]);
        expect(chunkDescriptionLines(['aaaa', 'bbbb'], '\n\n', 9)).toEqual([
            ['aaaa'],
            ['bbbb'],
        ]);
        expect(chunkDescriptionLines(['aaaa', 'bbbb'], '\n', 9)).toEqual([
            ['aaaa', 'bbbb'],
        ]);
    });

    it('never produces a joined chunk longer than the max', () => {
        const lines = Array.from({ length: 200 }, (_, i) =>
            `line ${i} `.repeat(5)
        );
        const chunks = chunkDescriptionLines(lines, '\n\n', 500);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks)
            expect(chunk.join('\n\n').length).toBeLessThanOrEqual(500);
        expect(chunks.flat()).toEqual(lines);
    });

    it('defaults to a 4092-char max', () => {
        const line = 'x'.repeat(2000);
        // 2000 + 2 + 2000 = 4002 fits, a third line does not
        expect(chunkDescriptionLines([line, line, line])).toEqual([
            [line, line],
            [line],
        ]);
    });

    it('gives a single over-long line its own chunk', () => {
        const long = 'x'.repeat(50);
        expect(chunkDescriptionLines(['a', long, 'b'], '\n\n', 10)).toEqual([
            ['a'],
            [long],
            ['b'],
        ]);
    });

    it('returns no chunks for no lines', () => {
        expect(chunkDescriptionLines([])).toEqual([]);
    });
});

describe('embedCharCount', () => {
    it('sums title, description, footer, author and fields', () => {
        expect(
            embedCharCount({
                data: {
                    title: 'abc',
                    description: 'defg',
                    footer: { text: 'hi' },
                    author: { name: 'z' },
                    fields: [
                        { name: 'n1', value: 'v11' },
                        { name: 'n', value: 'v' },
                    ],
                },
            })
        ).toBe(3 + 4 + 2 + 1 + 5 + 2);
    });

    it('treats missing and null parts as zero', () => {
        expect(embedCharCount({ data: {} })).toBe(0);
        expect(
            embedCharCount({
                data: {
                    title: null,
                    description: null,
                    footer: null,
                    author: null,
                    fields: null,
                },
            })
        ).toBe(0);
        expect(embedCharCount({ data: { footer: {} } })).toBe(0);
    });
});

describe('batchEmbeds', () => {
    it('exposes the platform limits', () => {
        expect(EMBED_TOTAL_CHARS_MAX).toBe(6000);
        expect(EMBEDS_PER_MESSAGE_MAX).toBe(10);
    });

    it('returns no batches for no embeds', () => {
        expect(batchEmbeds([])).toEqual([]);
    });

    it('puts a single small embed in one batch', () => {
        const e = embed('hello');
        expect(batchEmbeds([e])).toEqual([[e]]);
    });

    it('splits two full-size descriptions into separate batches, in order', () => {
        const first = embed('a'.repeat(4092));
        const second = embed('b'.repeat(4092));
        const batches = batchEmbeds([first, second]);
        expect(batches).toEqual([[first], [second]]);
    });

    it('keeps order and every embed across batches', () => {
        const embeds = Array.from({ length: 7 }, (_, i) =>
            embed(String(i).repeat(2000))
        );
        const batches = batchEmbeds(embeds);
        expect(batches.flat()).toEqual(embeds);
        for (const batch of batches) {
            const total = batch.reduce((sum, e) => sum + embedCharCount(e), 0);
            expect(total).toBeLessThanOrEqual(6000);
        }
        // 3 x 2000 = 6000 fits exactly
        expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    });

    it('counts a title on the first embed and a footer on the last', () => {
        const titled = embed('a'.repeat(3000), { title: 'Channel links' });
        const footed = embed('b'.repeat(3000), { footer: { text: 'Page 1' } });
        // 3000 + 3000 = 6000 would fit, but the title and footer push it over
        expect(batchEmbeds([titled, footed])).toEqual([[titled], [footed]]);

        const plainA = embed('a'.repeat(3000));
        const plainB = embed('b'.repeat(3000));
        expect(batchEmbeds([plainA, plainB])).toEqual([[plainA, plainB]]);
    });

    it('never puts more than 10 embeds in a batch, even when tiny', () => {
        const embeds = Array.from({ length: 25 }, (_, i) => embed(String(i)));
        const batches = batchEmbeds(embeds);
        expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
        expect(batches.flat()).toEqual(embeds);
    });

    it('lets an embed over the char limit stand alone', () => {
        const huge = embed('x'.repeat(7000));
        const small = embed('y');
        expect(batchEmbeds([small, huge, small])).toEqual([
            [small],
            [huge],
            [small],
        ]);
    });

    it('honours overridden limits', () => {
        const embeds = Array.from({ length: 5 }, () => embed('x'.repeat(10)));
        expect(batchEmbeds(embeds, 25).map((b) => b.length)).toEqual([2, 2, 1]);
        expect(batchEmbeds(embeds, 6000, 2).map((b) => b.length)).toEqual([
            2, 2, 1,
        ]);
    });
});
