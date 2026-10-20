import { describe, expect, it } from 'vitest';
import {
    identityRefersTo,
    mapIdentityToUserId,
} from '../../../src/services/voice/fluxer/identity';

const known = new Set(['111111111111111111', '222222222222222222']);

describe('mapIdentityToUserId', () => {
    it('returns the identity when it is a known user id', () => {
        expect(mapIdentityToUserId('111111111111111111', known)).toBe(
            '111111111111111111'
        );
    });

    it.each([
        '111111111111111111:abc123',
        'user-111111111111111111',
        'u_111111111111111111_7',
        '111111111111111111.conn',
        'fluxer/111111111111111111',
        'fluxer/111111111111111111:session-9',
    ])('extracts the user id from %s', (identity) => {
        expect(mapIdentityToUserId(identity, known)).toBe('111111111111111111');
    });

    it('prefers an exact match over a token match', () => {
        const ids = new Set(['a:b', 'a']);
        expect(mapIdentityToUserId('a:b', ids)).toBe('a:b');
    });

    it('returns null for an unknown identity', () => {
        expect(mapIdentityToUserId('333333333333333333', known)).toBeNull();
        expect(mapIdentityToUserId('abc:333333333333333333', known)).toBeNull();
        expect(mapIdentityToUserId('', known)).toBeNull();
    });

    it('does not match a partial token', () => {
        // The known id is only a substring of the token, not a whole token.
        expect(mapIdentityToUserId('x1111111111111111119', known)).toBeNull();
    });

    it('returns null when nothing is known', () => {
        expect(mapIdentityToUserId('111111111111111111', new Set())).toBeNull();
    });
});

describe('identityRefersTo', () => {
    it('matches the bare id and delimited forms', () => {
        expect(identityRefersTo('bot1', 'bot1')).toBe(true);
        expect(identityRefersTo('bot1:conn', 'bot1')).toBe(true);
        expect(identityRefersTo('user1:conn', 'bot1')).toBe(false);
    });

    it('is false for a null user id', () => {
        expect(identityRefersTo('bot1', null)).toBe(false);
    });
});
