import { describe, expect, it } from 'vitest';
import {
    buildCountingSince,
    buildMessageCountFields,
    platformShares,
} from '../../src/commands/messageCountSummary';
import type { MessageCounts } from '../../src/services/messageCount/MessageCountService';

const zero = { discord: 0, fluxer: 0 };

function counts(overrides: Partial<MessageCounts> = {}): MessageCounts {
    return {
        last24h: zero,
        last7d: zero,
        last30d: zero,
        allTime: zero,
        since: null,
        ...overrides,
    };
}

describe('platformShares', () => {
    it('returns null for a zero total', () => {
        expect(platformShares(zero)).toBeNull();
    });

    it('always adds up to 100', () => {
        for (const [d, f] of [
            [1, 2],
            [1, 1],
            [2, 1],
            [1, 199],
            [5, 0],
        ]) {
            const s = platformShares({ discord: d, fluxer: f })!;
            expect(s.discord + s.fluxer).toBe(100);
        }
        expect(platformShares({ discord: 1, fluxer: 3 })).toEqual({
            discord: 25,
            fluxer: 75,
        });
    });
});

describe('buildMessageCountFields', () => {
    it('renders every window and never prints NaN for zero counts', () => {
        const fields = buildMessageCountFields(counts());
        expect(fields.map((f) => f.name)).toEqual([
            'Last 24 hours',
            'Last 7 days',
            'Last 30 days',
            'All time',
            'Counting since',
        ]);
        for (const f of fields) expect(f.value).not.toMatch(/NaN/);
        expect(fields[0].value).toContain('Total: **0**');
        expect(fields[4].value).toContain('Nothing bridged yet');
    });

    it('formats numbers with separators, totals and shares', () => {
        const fields = buildMessageCountFields(
            counts({
                last24h: { discord: 1234, fluxer: 3702 },
                allTime: { discord: 1_000_000, fluxer: 0 },
                since: new Date('2026-01-02T03:00:00Z'),
            })
        );
        expect(fields[0].value).toBe(
            'Discord: **1,234** (25%)\nFluxer: **3,702** (75%)\nTotal: **4,936**'
        );
        expect(fields[3].value).toContain('**1,000,000** (100%)');
        expect(fields[3].value).toContain('Fluxer: **0** (0%)');
        expect(fields[4].value).toContain(
            `<t:${Math.floor(Date.parse('2026-01-02T03:00:00Z') / 1000)}:D>`
        );
    });

    it('keeps fields within Discord limits', () => {
        const big = { discord: Number.MAX_SAFE_INTEGER, fluxer: 1 };
        const fields = buildMessageCountFields(
            counts({ allTime: big, since: new Date() })
        );
        expect(fields.length).toBeLessThanOrEqual(25);
        for (const f of fields)
            expect(f.value.length).toBeLessThanOrEqual(1024);
    });
});

describe('buildCountingSince', () => {
    it('handles null and invalid dates', () => {
        expect(buildCountingSince(null)).toContain('Nothing bridged yet');
        expect(buildCountingSince(new Date('x'))).toContain(
            'Nothing bridged yet'
        );
    });
});
