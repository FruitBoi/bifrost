import { describe, expect, it } from 'vitest';
import {
    endsInsideSpoiler,
    truncateKeepingSpoilers,
} from '../../src/utils/spoilers';

describe('endsInsideSpoiler', () => {
    it('tracks unmatched || markers', () => {
        expect(endsInsideSpoiler('plain')).toBe(false);
        expect(endsInsideSpoiler('a ||b')).toBe(true);
        expect(endsInsideSpoiler('a ||b|| c')).toBe(false);
        expect(endsInsideSpoiler('||a|| ||b')).toBe(true);
    });

    it('ignores escaped pipes', () => {
        expect(endsInsideSpoiler('a \\|\\|b')).toBe(false);
        expect(endsInsideSpoiler('||a \\|| b')).toBe(true);
    });
});

describe('truncateKeepingSpoilers', () => {
    it('leaves text that fits alone', () => {
        expect(truncateKeepingSpoilers('||secret||', 10)).toBe('||secret||');
    });

    it('cuts plain text with an ellipsis', () => {
        expect(truncateKeepingSpoilers('hello world', 6)).toBe('hello…');
        expect(truncateKeepingSpoilers('hello', 1)).toBe('…');
        expect(truncateKeepingSpoilers('hello', 0)).toBe('');
    });

    it('closes a spoiler the cut lands in', () => {
        const result = truncateKeepingSpoilers(
            'the killer is ||the butler||',
            22
        );
        expect(result).toBe('the killer is ||the…||');
        expect(result.length).toBeLessThanOrEqual(22);
        expect(endsInsideSpoiler(result)).toBe(false);
    });

    it('keeps already closed spoilers before the cut', () => {
        expect(truncateKeepingSpoilers('||a|| and more text', 12)).toBe(
            '||a|| and m…'
        );
    });

    it('drops a half marker instead of letting it pair with the closer', () => {
        // The cut lands between the two pipes of the opening marker.
        expect(truncateKeepingSpoilers('abc ||secret||', 6)).toBe('abc…');
        // ...and of the closing marker.
        const result = truncateKeepingSpoilers('||abcdef|| tail', 10);
        expect(result.length).toBeLessThanOrEqual(10);
        expect(endsInsideSpoiler(result)).toBe(false);
        expect(result).not.toContain('|||');
    });

    it('never reveals spoilered text at any cut', () => {
        const text = 'intro ||the hidden ending|| outro ||again||';
        for (let max = 0; max <= text.length; max++) {
            const result = truncateKeepingSpoilers(text, max);
            expect(result.length).toBeLessThanOrEqual(max);
            expect(endsInsideSpoiler(result)).toBe(false);
        }
    });

    it('does not split a surrogate pair', () => {
        expect(truncateKeepingSpoilers('ab😀cd', 4)).toBe('ab…');
    });
});
