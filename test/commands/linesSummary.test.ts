import { describe, expect, it } from 'vitest';
import { buildClaudeLinesSummary } from '../../src/commands/linesSummary';
import type { ClaudeLinesStats } from '../../src/services/claudeLines/ClaudeLinesService';

const commit = (over = {}) => ({
    sha: 'abcdef1234567890',
    headline: 'Add the thing',
    url: 'https://github.com/o/r/commit/abcdef1',
    additions: 1500,
    deletions: 3,
    committedAt: '2026-01-02T03:04:05Z',
    ...over,
});

const stats = (over: Partial<ClaudeLinesStats> = {}): ClaudeLinesStats => ({
    repo: 'o/r',
    commits: 67,
    additions: 12345,
    deletions: 1234,
    totalCommits: 100,
    totalAdditions: 24690,
    firstCommitAt: '2026-01-01T00:00:00Z',
    latest: commit(),
    biggest: commit({ additions: 9000 }),
    truncated: false,
    fetchedAt: 0,
    ...over,
});

const field = (s: ReturnType<typeof buildClaudeLinesSummary>, name: string) =>
    s.fields.find((f) => f.name === name)?.value;

describe('buildClaudeLinesSummary', () => {
    it('formats totals and fields', () => {
        const s = buildClaudeLinesSummary(stats());
        expect(s.title).toBe('🤖 Lines of code written by Claude');
        expect(s.description).toBe(
            'Claude has written **12,345** lines of code in [o/r](https://github.com/o/r) across **67** commits.'
        );
        expect(field(s, 'Added')).toBe('+12,345');
        expect(field(s, 'Deleted')).toBe('-1,234');
        expect(field(s, 'Net')).toBe('+11,111');
        expect(field(s, 'Share of all lines added')).toBe('50.0%');
        expect(field(s, 'Biggest commit')).toBe(
            '[`abcdef1`](https://github.com/o/r/commit/abcdef1) +9,000: Add the thing'
        );
        const ts = Date.parse('2026-01-02T03:04:05Z') / 1000;
        expect(field(s, 'Latest commit')).toContain(`<t:${ts}:R>`);
        expect(field(s, 'Since')).toBe(
            `<t:${Date.parse('2026-01-01T00:00:00Z') / 1000}:D>`
        );
    });

    it('handles negative net and zero total additions', () => {
        const s = buildClaudeLinesSummary(
            stats({ additions: 10, deletions: 25, totalAdditions: 0 })
        );
        expect(field(s, 'Net')).toBe('-15');
        expect(field(s, 'Share of all lines added')).toBe('0.0%');
    });

    it('omits null commits and since', () => {
        const s = buildClaudeLinesSummary(
            stats({ latest: null, biggest: null, firstCommitAt: null })
        );
        expect(field(s, 'Biggest commit')).toBeUndefined();
        expect(field(s, 'Latest commit')).toBeUndefined();
        expect(field(s, 'Since')).toBeUndefined();
    });

    it('truncates long headlines', () => {
        const s = buildClaudeLinesSummary(
            stats({ latest: commit({ headline: 'x'.repeat(300) }) })
        );
        const value = field(s, 'Latest commit') as string;
        expect(value).toContain('…');
        expect(value.length).toBeLessThan(1024);
    });

    it('notes truncation', () => {
        const s = buildClaudeLinesSummary(stats({ truncated: true }));
        expect(s.description).toContain(
            '(only the most recent commits were counted)'
        );
    });

    it('handles zero commits', () => {
        const s = buildClaudeLinesSummary(stats({ commits: 0, additions: 0 }));
        expect(s.description).toBe(
            'Claude has not written any lines in [o/r](https://github.com/o/r) yet. Give it time.'
        );
        expect(s.fields).toEqual([]);
    });
});
