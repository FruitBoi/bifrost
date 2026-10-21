import { describe, expect, it } from 'vitest';
import { CleanOptions } from '../../../src/services/clean/cleanArgs';
import {
    CLEAN_FETCH_MULTIPLIER,
    CLEAN_PAGE_SIZE,
    CleanCandidate,
    CleanSource,
    cleanFetchLimit,
    collectMessagesToClean,
    compareSnowflakes,
    DISCORD_BULK_DELETE_MAX_AGE_MS,
    hasCleanFilters,
    MAX_CLEAN_FETCH,
    matchesCleanFilters,
} from '../../../src/services/clean/cleanFilter';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Well beyond Number's 2^53 precision, like real snowflakes. */
const BASE = BigInt('1561105750388908000');
const TRIGGER_ID = (BASE + BigInt(1)).toString();

/** ID of the i-th most recent message in the fake channel (0 = newest). */
function idAt(i: number): string {
    return (BASE - BigInt(i)).toString();
}

/** The options for `clean <count>` without any filter. */
function bare(count: number): CleanOptions {
    return {
        count,
        userId: null,
        regex: null,
        invertRegex: false,
        maxAgeMs: null,
        minAgeMs: null,
        ignorePinned: false,
        attachmentsOnly: false,
        botsOnly: false,
        fromId: null,
        toId: null,
    };
}

/** The i-th most recent message, one second apart, newest one second old. */
function msg(
    i: number,
    overrides: Partial<CleanCandidate> = {}
): CleanCandidate {
    return {
        id: idAt(i),
        authorId: 'alice',
        authorIsBot: false,
        content: `message ${i}`,
        createdAt: new Date(NOW - (i + 1) * 1000),
        pinned: false,
        hasAttachments: false,
        ...overrides,
    };
}

/** `n` messages newest first, each customised by index. */
function history(
    n: number,
    customise: (i: number) => Partial<CleanCandidate> = () => ({})
): CleanCandidate[] {
    return Array.from({ length: n }, (_, i) => msg(i, customise(i)));
}

interface FakeSource extends CleanSource {
    calls: { beforeId: string; limit: number }[];
}

interface FakeSourceOptions {
    /** Return each page oldest first instead of newest first. */
    shuffle?: boolean;
    /** Never return more than this many messages per page (a short page). */
    maxPage?: number;
    /** Return every message older than the cursor, ignoring `limit`. */
    ignoreLimit?: boolean;
}

function makeSource(
    messages: CleanCandidate[],
    {
        shuffle = false,
        maxPage = Infinity,
        ignoreLimit = false,
    }: FakeSourceOptions = {}
): FakeSource {
    const sorted = [...messages].sort((a, b) => compareSnowflakes(b.id, a.id));
    const calls: FakeSource['calls'] = [];
    return {
        calls,
        async fetchBefore(beforeId, limit) {
            calls.push({ beforeId, limit });
            const older = sorted.filter(
                (m) => compareSnowflakes(m.id, beforeId) < 0
            );
            const page = ignoreLimit
                ? older
                : older.slice(0, Math.min(limit, maxPage));
            if (!shuffle) return page;
            // Oldest first, with the two newest swapped into the middle so
            // the page is neither ascending nor descending.
            const reversed = [...page].reverse();
            if (reversed.length > 2) {
                const last = reversed.pop()!;
                reversed.splice(1, 0, last);
            }
            return reversed;
        },
    };
}

const neverMatches: CleanOptions = { ...bare(1), userId: 'nobody' };

describe('constants', () => {
    it('match the documented limits', () => {
        expect(MAX_CLEAN_FETCH).toBe(1000);
        expect(CLEAN_FETCH_MULTIPLIER).toBe(50);
        expect(CLEAN_PAGE_SIZE).toBe(100);
        expect(DISCORD_BULK_DELETE_MAX_AGE_MS).toBe(14 * DAY_MS);
    });
});

describe('compareSnowflakes', () => {
    it('compares IDs beyond Number precision', () => {
        const a = '1561105750388908139';
        const b = '1561105750388908140';
        // Sanity check: as doubles these are indistinguishable.
        expect(Number(a)).toBe(Number(b));
        expect(compareSnowflakes(a, b)).toBeLessThan(0);
        expect(compareSnowflakes(b, a)).toBeGreaterThan(0);
    });

    it('returns 0 for equal IDs', () => {
        expect(
            compareSnowflakes('1561105750388908139', '1561105750388908139')
        ).toBe(0);
        expect(compareSnowflakes('7', '7')).toBe(0);
    });

    it('compares numerically, not lexically, across lengths', () => {
        expect(compareSnowflakes('99', '100')).toBeLessThan(0);
        expect(compareSnowflakes('100', '99')).toBeGreaterThan(0);
        expect(compareSnowflakes('9', '10000000000000000000')).toBeLessThan(0);
        expect(compareSnowflakes('007', '7')).toBe(0);
    });

    it('sorts newest first when used as a reversed comparator', () => {
        const ids = ['10', '9', '1000000000000000000', '100'];
        expect([...ids].sort((a, b) => compareSnowflakes(b, a))).toEqual([
            '1000000000000000000',
            '100',
            '10',
            '9',
        ]);
    });
});

describe('hasCleanFilters', () => {
    it('is false for a bare count', () => {
        expect(hasCleanFilters(bare(1))).toBe(false);
        expect(hasCleanFilters(bare(100))).toBe(false);
    });

    it.each<[string, Partial<CleanOptions>]>([
        ['userId', { userId: 'alice' }],
        ['regex', { regex: /x/ }],
        ['maxAgeMs', { maxAgeMs: 1 }],
        ['minAgeMs', { minAgeMs: 1 }],
        ['ignorePinned', { ignorePinned: true }],
        ['attachmentsOnly', { attachmentsOnly: true }],
        ['botsOnly', { botsOnly: true }],
        ['fromId', { fromId: '1' }],
        ['toId', { toId: '1' }],
    ])('is true with only %s set', (_name, overrides) => {
        expect(hasCleanFilters({ ...bare(5), ...overrides })).toBe(true);
    });

    it('ignores invertRegex without a regex', () => {
        expect(hasCleanFilters({ ...bare(5), invertRegex: true })).toBe(false);
    });

    it('treats a zero age as a filter (the parser maps "no limit" to null)', () => {
        expect(hasCleanFilters({ ...bare(5), maxAgeMs: 0 })).toBe(true);
    });
});

describe('cleanFetchLimit', () => {
    it('is exactly the count without filters', () => {
        expect(cleanFetchLimit(bare(1))).toBe(1);
        expect(cleanFetchLimit(bare(3))).toBe(3);
        expect(cleanFetchLimit(bare(100))).toBe(100);
    });

    it.each([
        [1, 50],
        [2, 100],
        [3, 150],
        [19, 950],
        [20, 1000],
        [21, 1000],
        [100, 1000],
    ])(
        'is 50 per wanted message with filters, capped: %i -> %i',
        (count, limit) => {
            expect(cleanFetchLimit({ ...bare(count), botsOnly: true })).toBe(
                limit
            );
            expect(cleanFetchLimit({ ...bare(count), regex: /x/ })).toBe(limit);
        }
    );
});

describe('matchesCleanFilters', () => {
    it('passes everything without filters', () => {
        expect(matchesCleanFilters(msg(0), bare(1), NOW)).toBe(true);
        expect(
            matchesCleanFilters(
                msg(0, {
                    pinned: true,
                    authorIsBot: true,
                    hasAttachments: true,
                    createdAt: new Date(NOW - 400 * DAY_MS),
                    content: '',
                }),
                bare(1),
                NOW
            )
        ).toBe(true);
    });

    it('filters by author ID', () => {
        const options = { ...bare(1), userId: 'bob' };
        expect(
            matchesCleanFilters(msg(0, { authorId: 'bob' }), options, NOW)
        ).toBe(true);
        expect(
            matchesCleanFilters(msg(0, { authorId: 'alice' }), options, NOW)
        ).toBe(false);
        // Exact match only.
        expect(
            matchesCleanFilters(msg(0, { authorId: 'bobby' }), options, NOW)
        ).toBe(false);
    });

    it('filters by regex', () => {
        const options = { ...bare(1), regex: /^spam/ };
        expect(
            matchesCleanFilters(msg(0, { content: 'spam!' }), options, NOW)
        ).toBe(true);
        expect(
            matchesCleanFilters(msg(0, { content: 'SPAM!' }), options, NOW)
        ).toBe(false);
        expect(
            matchesCleanFilters(msg(0, { content: 'no spam' }), options, NOW)
        ).toBe(false);
        expect(matchesCleanFilters(msg(0, { content: '' }), options, NOW)).toBe(
            false
        );
        expect(
            matchesCleanFilters(
                msg(0, { content: 'SPAM!' }),
                { ...options, regex: /^spam/i },
                NOW
            )
        ).toBe(true);
    });

    it('inverts the regex with invertRegex', () => {
        const options = { ...bare(1), regex: /^spam/, invertRegex: true };
        expect(
            matchesCleanFilters(msg(0, { content: 'spam!' }), options, NOW)
        ).toBe(false);
        expect(
            matchesCleanFilters(msg(0, { content: 'hello' }), options, NOW)
        ).toBe(true);
        expect(matchesCleanFilters(msg(0, { content: '' }), options, NOW)).toBe(
            true
        );
    });

    it('ignores invertRegex without a regex', () => {
        expect(
            matchesCleanFilters(msg(0), { ...bare(1), invertRegex: true }, NOW)
        ).toBe(true);
    });

    it('applies maxAgeMs inclusively', () => {
        const options = { ...bare(1), maxAgeMs: 60_000 };
        const at = (ageMs: number) =>
            msg(0, { createdAt: new Date(NOW - ageMs) });
        expect(matchesCleanFilters(at(0), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(59_999), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(60_000), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(60_001), options, NOW)).toBe(false);
        expect(matchesCleanFilters(at(DAY_MS), options, NOW)).toBe(false);
        // A message from the future is younger than anything.
        expect(matchesCleanFilters(at(-5000), options, NOW)).toBe(true);
    });

    it('applies minAgeMs inclusively', () => {
        const options = { ...bare(1), minAgeMs: 60_000 };
        const at = (ageMs: number) =>
            msg(0, { createdAt: new Date(NOW - ageMs) });
        expect(matchesCleanFilters(at(0), options, NOW)).toBe(false);
        expect(matchesCleanFilters(at(59_999), options, NOW)).toBe(false);
        expect(matchesCleanFilters(at(60_000), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(60_001), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(DAY_MS), options, NOW)).toBe(true);
    });

    it('combines maxAgeMs and minAgeMs into a window', () => {
        const options = { ...bare(1), minAgeMs: 1000, maxAgeMs: 2000 };
        const at = (ageMs: number) =>
            msg(0, { createdAt: new Date(NOW - ageMs) });
        expect(matchesCleanFilters(at(999), options, NOW)).toBe(false);
        expect(matchesCleanFilters(at(1000), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(1500), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(2000), options, NOW)).toBe(true);
        expect(matchesCleanFilters(at(2001), options, NOW)).toBe(false);
    });

    it('measures ages from the injected now', () => {
        const message = msg(0, { createdAt: new Date(NOW - 1000) });
        const options = { ...bare(1), maxAgeMs: 500 };
        expect(matchesCleanFilters(message, options, NOW)).toBe(false);
        expect(matchesCleanFilters(message, options, NOW - 600)).toBe(true);
        // The default is the wall clock, so a message from the far past
        // fails and one from the far future passes.
        expect(
            matchesCleanFilters(
                msg(0, { createdAt: new Date('2000-01-01T00:00:00Z') }),
                options
            )
        ).toBe(false);
        expect(
            matchesCleanFilters(
                msg(0, { createdAt: new Date('2100-01-01T00:00:00Z') }),
                options
            )
        ).toBe(true);
    });

    it('skips pinned messages with ignorePinned', () => {
        const options = { ...bare(1), ignorePinned: true };
        expect(
            matchesCleanFilters(msg(0, { pinned: true }), options, NOW)
        ).toBe(false);
        expect(
            matchesCleanFilters(msg(0, { pinned: false }), options, NOW)
        ).toBe(true);
        // Without the switch pinned messages are fair game.
        expect(
            matchesCleanFilters(msg(0, { pinned: true }), bare(1), NOW)
        ).toBe(true);
    });

    it('keeps only messages with attachments with attachmentsOnly', () => {
        const options = { ...bare(1), attachmentsOnly: true };
        expect(
            matchesCleanFilters(msg(0, { hasAttachments: true }), options, NOW)
        ).toBe(true);
        expect(
            matchesCleanFilters(msg(0, { hasAttachments: false }), options, NOW)
        ).toBe(false);
    });

    it('keeps only bot messages with botsOnly', () => {
        const options = { ...bare(1), botsOnly: true };
        expect(
            matchesCleanFilters(msg(0, { authorIsBot: true }), options, NOW)
        ).toBe(true);
        expect(
            matchesCleanFilters(msg(0, { authorIsBot: false }), options, NOW)
        ).toBe(false);
    });

    it('applies fromId inclusively (that message and older)', () => {
        const options = { ...bare(1), fromId: idAt(10) };
        expect(matchesCleanFilters(msg(9), options, NOW)).toBe(false);
        expect(matchesCleanFilters(msg(0), options, NOW)).toBe(false);
        expect(matchesCleanFilters(msg(10), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(11), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(500), options, NOW)).toBe(true);
    });

    it('applies toId inclusively (that message and newer)', () => {
        const options = { ...bare(1), toId: idAt(10) };
        expect(matchesCleanFilters(msg(11), options, NOW)).toBe(false);
        expect(matchesCleanFilters(msg(500), options, NOW)).toBe(false);
        expect(matchesCleanFilters(msg(10), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(9), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(0), options, NOW)).toBe(true);
    });

    it('combines fromId and toId into a range', () => {
        const options = { ...bare(1), fromId: idAt(5), toId: idAt(10) };
        expect(matchesCleanFilters(msg(4), options, NOW)).toBe(false);
        expect(matchesCleanFilters(msg(5), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(7), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(10), options, NOW)).toBe(true);
        expect(matchesCleanFilters(msg(11), options, NOW)).toBe(false);
        // A reversed range matches nothing.
        const reversed = { ...bare(1), fromId: idAt(10), toId: idAt(5) };
        expect(matchesCleanFilters(msg(7), reversed, NOW)).toBe(false);
    });

    it('compares IDs numerically for fromId and toId', () => {
        const options = { ...bare(1), fromId: '100' };
        expect(matchesCleanFilters(msg(0, { id: '99' }), options, NOW)).toBe(
            true
        );
        expect(matchesCleanFilters(msg(0, { id: '1000' }), options, NOW)).toBe(
            false
        );
    });

    it('requires every active filter to pass', () => {
        const options: CleanOptions = {
            count: 1,
            userId: 'bot-1',
            regex: /spam/i,
            invertRegex: false,
            maxAgeMs: DAY_MS,
            minAgeMs: 1000,
            ignorePinned: true,
            attachmentsOnly: true,
            botsOnly: true,
            fromId: idAt(1),
            toId: idAt(20),
        };
        const good = msg(5, {
            authorId: 'bot-1',
            authorIsBot: true,
            content: 'SPAM here',
            createdAt: new Date(NOW - 3600_000),
            pinned: false,
            hasAttachments: true,
        });
        expect(matchesCleanFilters(good, options, NOW)).toBe(true);

        const breaking: Partial<CleanCandidate>[] = [
            { authorId: 'bot-2' },
            { content: 'ham' },
            { createdAt: new Date(NOW - 2 * DAY_MS) },
            { createdAt: new Date(NOW - 500) },
            { pinned: true },
            { hasAttachments: false },
            { authorIsBot: false },
            { id: idAt(0) },
            { id: idAt(21) },
        ];
        for (const change of breaking) {
            expect(
                matchesCleanFilters({ ...good, ...change }, options, NOW),
                JSON.stringify(change)
            ).toBe(false);
        }
        expect(
            matchesCleanFilters(good, { ...options, invertRegex: true }, NOW)
        ).toBe(false);
    });
});

describe('collectMessagesToClean', () => {
    it('fetches exactly count messages without filters and returns them newest first', async () => {
        const source = makeSource(history(10));
        const ids = await collectMessagesToClean(source, bare(3), TRIGGER_ID, {
            now: NOW,
        });
        expect(ids).toEqual([idAt(0), idAt(1), idAt(2)]);
        expect(source.calls).toEqual([{ beforeId: TRIGGER_ID, limit: 3 }]);
    });

    it('fetches a single page of 100 for clean 100 without filters', async () => {
        const source = makeSource(history(150));
        const ids = await collectMessagesToClean(
            source,
            bare(100),
            TRIGGER_ID,
            {
                now: NOW,
            }
        );
        expect(ids).toHaveLength(100);
        expect(ids[0]).toBe(idAt(0));
        expect(ids[99]).toBe(idAt(99));
        expect(source.calls).toEqual([{ beforeId: TRIGGER_ID, limit: 100 }]);
    });

    it('starts the cursor at the trigger message so it is never selected', async () => {
        const source = makeSource([msg(0, { id: TRIGGER_ID }), ...history(5)]);
        const ids = await collectMessagesToClean(source, bare(2), TRIGGER_ID, {
            now: NOW,
        });
        expect(source.calls[0].beforeId).toBe(TRIGGER_ID);
        expect(ids).toEqual([idAt(0), idAt(1)]);
        expect(ids).not.toContain(TRIGGER_ID);
    });

    it('returns fewer than count when the history is shorter', async () => {
        const source = makeSource(history(2));
        const ids = await collectMessagesToClean(source, bare(5), TRIGGER_ID, {
            now: NOW,
        });
        expect(ids).toEqual([idAt(0), idAt(1)]);
        // A short page is not the end: the next page is empty and ends it.
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 5 },
            { beforeId: idAt(1), limit: 3 },
        ]);
    });

    it('returns nothing for an empty channel', async () => {
        const source = makeSource([]);
        expect(
            await collectMessagesToClean(source, bare(5), TRIGGER_ID, {
                now: NOW,
            })
        ).toEqual([]);
        expect(source.calls).toEqual([{ beforeId: TRIGGER_ID, limit: 5 }]);
    });

    it('pages with 100 and continues from the oldest ID of the previous page', async () => {
        const bots = new Set([5, 120, 130]);
        const source = makeSource(
            history(300, (i) => ({ authorIsBot: bots.has(i) }))
        );
        const ids = await collectMessagesToClean(
            source,
            { ...bare(3), botsOnly: true },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(5), idAt(120), idAt(130)]);
        // Count 3 with a filter looks at 150 messages: 100 then the remaining
        // 50, starting after the oldest message of the first page.
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 100 },
            { beforeId: idAt(99), limit: 50 },
        ]);
    });

    it('requests fetchLimit - fetched for the last page (count 3 filtered: 100 then 50)', async () => {
        const source = makeSource(history(300));
        const ids = await collectMessagesToClean(
            source,
            { ...bare(3), userId: 'nobody' },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([]);
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 100 },
            { beforeId: idAt(99), limit: 50 },
        ]);
    });

    it('requests fetchLimit - fetched for the last page (count 5 filtered: 100, 100, 50)', async () => {
        const source = makeSource(history(300));
        const ids = await collectMessagesToClean(
            source,
            { ...bare(5), userId: 'nobody' },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([]);
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 100 },
            { beforeId: idAt(99), limit: 100 },
            { beforeId: idAt(199), limit: 50 },
        ]);
    });

    it('looks through 50 messages for count 1 with a filter', async () => {
        const source = makeSource(history(300));
        await collectMessagesToClean(source, neverMatches, TRIGGER_ID, {
            now: NOW,
        });
        expect(source.calls).toEqual([{ beforeId: TRIGGER_ID, limit: 50 }]);
    });

    it('looks through 100 messages for count 2 with a filter', async () => {
        const source = makeSource(history(300));
        await collectMessagesToClean(
            source,
            { ...neverMatches, count: 2 },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(source.calls).toEqual([{ beforeId: TRIGGER_ID, limit: 100 }]);
    });

    it('stops after 1000 messages: count 20 filtered makes exactly 10 fetches of 100', async () => {
        const source = makeSource(history(1500));
        const ids = await collectMessagesToClean(
            source,
            { ...neverMatches, count: 20 },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([]);
        expect(source.calls).toHaveLength(10);
        expect(source.calls.map((c) => c.limit)).toEqual(Array(10).fill(100));
        expect(source.calls.map((c) => c.beforeId)).toEqual([
            TRIGGER_ID,
            ...Array.from({ length: 9 }, (_, i) => idAt(i * 100 + 99)),
        ]);
    });

    it('caps the search at 1000 for count 21 (last page still 100)', async () => {
        const source = makeSource(history(1500));
        await collectMessagesToClean(
            source,
            { ...neverMatches, count: 21 },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(source.calls).toHaveLength(10);
        expect(source.calls[9]).toEqual({ beforeId: idAt(899), limit: 100 });
        const total = source.calls.reduce((sum, c) => sum + c.limit, 0);
        expect(total).toBe(1000);
    });

    it('finds a match on the very last searched message but not one past the limit', async () => {
        const matchAt = (i: number) =>
            makeSource(history(200, (j) => ({ authorIsBot: j === i })));
        const options = { ...bare(1), botsOnly: true };
        expect(
            await collectMessagesToClean(matchAt(49), options, TRIGGER_ID, {
                now: NOW,
            })
        ).toEqual([idAt(49)]);
        expect(
            await collectMessagesToClean(matchAt(50), options, TRIGGER_ID, {
                now: NOW,
            })
        ).toEqual([]);
    });

    it('stops fetching as soon as count matches are found', async () => {
        const source = makeSource(
            history(300, (i) => ({ authorIsBot: i < 2 }))
        );
        const ids = await collectMessagesToClean(
            source,
            { ...bare(2), botsOnly: true },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(0), idAt(1)]);
        expect(source.calls).toHaveLength(1);
    });

    it('never returns more than count even if more messages match', async () => {
        const source = makeSource(history(300, () => ({ authorIsBot: true })));
        const ids = await collectMessagesToClean(
            source,
            { ...bare(4), botsOnly: true },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(0), idAt(1), idAt(2), idAt(3)]);
    });

    it('never returns more than count when the source ignores the page size', async () => {
        const source = makeSource(history(50), { ignoreLimit: true });
        const ids = await collectMessagesToClean(source, bare(5), TRIGGER_ID, {
            now: NOW,
        });
        expect(ids).toEqual([idAt(0), idAt(1), idAt(2), idAt(3), idAt(4)]);
        expect(source.calls).toHaveLength(1);
        const filtered = makeSource(
            history(50, (i) => ({ authorIsBot: i % 2 === 0 })),
            { ignoreLimit: true }
        );
        expect(
            await collectMessagesToClean(
                filtered,
                { ...bare(3), botsOnly: true },
                TRIGGER_ID,
                { now: NOW }
            )
        ).toEqual([idAt(0), idAt(2), idAt(4)]);
    });

    it('re-sorts shuffled pages newest first and pages from the true oldest ID', async () => {
        const source = makeSource(
            history(250, (i) => ({
                authorIsBot: i === 7 || i === 3 || i === 140,
            })),
            { shuffle: true }
        );
        const ids = await collectMessagesToClean(
            source,
            { ...bare(3), botsOnly: true },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(3), idAt(7), idAt(140)]);
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 100 },
            { beforeId: idAt(99), limit: 50 },
        ]);
    });

    it('returns shuffled unfiltered pages newest first', async () => {
        const source = makeSource(history(10), { shuffle: true });
        const ids = await collectMessagesToClean(source, bare(5), TRIGGER_ID, {
            now: NOW,
        });
        expect(ids).toEqual([idAt(0), idAt(1), idAt(2), idAt(3), idAt(4)]);
    });

    it('keeps going after a short page (Fluxer cutoff filtering)', async () => {
        const source = makeSource(
            history(100, (i) => ({ authorIsBot: i === 40 })),
            { maxPage: 30 }
        );
        const ids = await collectMessagesToClean(
            source,
            { ...bare(1), botsOnly: true },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(40)]);
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 50 },
            { beforeId: idAt(29), limit: 20 },
        ]);
    });

    it('counts short pages towards the fetch limit by what was returned', async () => {
        const source = makeSource(history(100), { maxPage: 30 });
        await collectMessagesToClean(source, neverMatches, TRIGGER_ID, {
            now: NOW,
        });
        // 30 + 20 = 50 = the fetch limit for count 1 with a filter.
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 50 },
            { beforeId: idAt(29), limit: 20 },
        ]);
    });

    it('stops on an empty page even when the limit is not reached', async () => {
        const source = makeSource(history(5));
        const ids = await collectMessagesToClean(
            source,
            neverMatches,
            TRIGGER_ID,
            {
                now: NOW,
            }
        );
        expect(ids).toEqual([]);
        expect(source.calls).toEqual([
            { beforeId: TRIGGER_ID, limit: 50 },
            { beforeId: idAt(4), limit: 45 },
        ]);
    });

    describe('maxDeletableAgeMs', () => {
        const tooOld = new Date(NOW - DISCORD_BULK_DELETE_MAX_AGE_MS - 1);
        const messages = history(10, (i) => ({
            authorIsBot: i === 1 || i === 3 || i === 5,
            createdAt: i >= 3 ? tooOld : new Date(NOW - (i + 1) * 1000),
        }));
        const options = { ...bare(3), botsOnly: true };

        it('ends the search at the first undeletable message', async () => {
            const source = makeSource(messages);
            const ids = await collectMessagesToClean(
                source,
                options,
                TRIGGER_ID,
                {
                    now: NOW,
                    maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS,
                }
            );
            // idAt(3) matches but is too old; idAt(5) is older still.
            expect(ids).toEqual([idAt(1)]);
            expect(source.calls).toHaveLength(1);
        });

        it('ends the search even when the undeletable message does not match', async () => {
            const source = makeSource(
                history(10, (i) => ({
                    authorIsBot: i === 1 || i === 5,
                    createdAt: i >= 3 ? tooOld : new Date(NOW - (i + 1) * 1000),
                }))
            );
            const ids = await collectMessagesToClean(
                source,
                options,
                TRIGGER_ID,
                {
                    now: NOW,
                    maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS,
                }
            );
            expect(ids).toEqual([idAt(1)]);
            expect(source.calls).toHaveLength(1);
        });

        it('returns nothing when the newest message is already undeletable', async () => {
            const source = makeSource(
                history(10, () => ({ createdAt: tooOld }))
            );
            const ids = await collectMessagesToClean(
                source,
                bare(5),
                TRIGGER_ID,
                {
                    now: NOW,
                    maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS,
                }
            );
            expect(ids).toEqual([]);
            expect(source.calls).toHaveLength(1);
        });

        it('still deletes a message exactly at the age limit', async () => {
            const atLimit = new Date(NOW - DISCORD_BULK_DELETE_MAX_AGE_MS);
            const source = makeSource([
                msg(0),
                msg(1, { createdAt: atLimit }),
                msg(2, { createdAt: tooOld }),
            ]);
            const ids = await collectMessagesToClean(
                source,
                bare(3),
                TRIGGER_ID,
                {
                    now: NOW,
                    maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS,
                }
            );
            expect(ids).toEqual([idAt(0), idAt(1)]);
        });

        it('does not fetch another page after stopping', async () => {
            const source = makeSource(
                history(300, (i) => ({
                    createdAt:
                        i >= 50 ? tooOld : new Date(NOW - (i + 1) * 1000),
                }))
            );
            const ids = await collectMessagesToClean(
                source,
                { ...neverMatches, count: 20 },
                TRIGGER_ID,
                { now: NOW, maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS }
            );
            expect(ids).toEqual([]);
            expect(source.calls).toHaveLength(1);
        });

        it('is disabled by null and by default', async () => {
            for (const extra of [{ maxDeletableAgeMs: null }, {}]) {
                const source = makeSource(messages);
                const ids = await collectMessagesToClean(
                    source,
                    options,
                    TRIGGER_ID,
                    { now: NOW, ...extra }
                );
                expect(ids).toEqual([idAt(1), idAt(3), idAt(5)]);
            }
        });

        it('measures the age from the injected now', async () => {
            const source = makeSource(messages);
            const ids = await collectMessagesToClean(
                source,
                options,
                TRIGGER_ID,
                {
                    now: NOW - DAY_MS,
                    maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS,
                }
            );
            expect(ids).toEqual([idAt(1), idAt(3), idAt(5)]);
        });
    });

    it('applies the age filters with the injected now', async () => {
        const source = makeSource(history(10));
        // Messages are one second apart starting one second ago.
        const ids = await collectMessagesToClean(
            source,
            { ...bare(10), maxAgeMs: 3000 },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(0), idAt(1), idAt(2)]);
        const older = await collectMessagesToClean(
            makeSource(history(10)),
            { ...bare(10), minAgeMs: 8000 },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(older).toEqual([idAt(7), idAt(8), idAt(9)]);
    });

    it('honours -from and -to while still paging the full window', async () => {
        const source = makeSource(history(300));
        const ids = await collectMessagesToClean(
            source,
            { ...bare(3), fromId: idAt(120), toId: idAt(121) },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(120), idAt(121)]);
        // Only two matches exist, so the whole 150-message window is searched.
        expect(source.calls.map((c) => c.limit)).toEqual([100, 50]);
    });

    it('applies a user filter across pages', async () => {
        const source = makeSource(
            history(250, (i) => ({ authorId: i % 100 === 0 ? 'bob' : 'alice' }))
        );
        const ids = await collectMessagesToClean(
            source,
            { ...bare(5), userId: 'bob' },
            TRIGGER_ID,
            { now: NOW }
        );
        expect(ids).toEqual([idAt(0), idAt(100), idAt(200)]);
        expect(source.calls.map((c) => c.limit)).toEqual([100, 100, 50]);
    });
});
