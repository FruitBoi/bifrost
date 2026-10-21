import { describe, expect, it } from 'vitest';
import {
    mapReactionEmoji,
    reactionEmojiKey,
    toReactionEmoji,
} from '../../../src/services/reactionBridge/reactionEmoji';

describe('toReactionEmoji', () => {
    it('normalises a Unicode emoji', () => {
        expect(toReactionEmoji({ name: '👍', id: null })).toEqual({
            name: '👍',
            id: null,
            animated: false,
        });
    });

    it('normalises a custom emoji with missing optional fields', () => {
        expect(
            toReactionEmoji({ name: 'pepe', id: '1', animated: true })
        ).toEqual({ name: 'pepe', id: '1', animated: true });
        expect(toReactionEmoji({ name: 'pepe', id: '1' })).toEqual({
            name: 'pepe',
            id: '1',
            animated: false,
        });
    });

    it('returns null for an emoji without a name', () => {
        expect(toReactionEmoji({ name: null, id: '1' })).toBeNull();
        expect(toReactionEmoji({ id: '1' })).toBeNull();
    });
});

describe('reactionEmojiKey', () => {
    it('uses the character for Unicode and name:id for custom emojis', () => {
        expect(
            reactionEmojiKey({ name: '🔥', id: null, animated: false })
        ).toBe('🔥');
        expect(
            reactionEmojiKey({ name: 'pepe', id: '42', animated: false })
        ).toBe('pepe:42');
    });
});

describe('mapReactionEmoji', () => {
    const others = [
        { name: 'pepe', id: '900', animated: false },
        { name: 'party', id: '901', animated: true },
    ];

    it('maps Unicode emojis to themselves', () => {
        const emoji = { name: '👍', id: null, animated: false };
        expect(mapReactionEmoji(emoji, others)).toEqual(emoji);
    });

    it('maps a custom emoji to the other side by name', () => {
        expect(
            mapReactionEmoji(
                { name: 'party', id: '1', animated: false },
                others
            )
        ).toEqual({ name: 'party', id: '901', animated: true });
    });

    it('returns null when the other side has no emoji with that name', () => {
        expect(
            mapReactionEmoji({ name: 'nope', id: '1', animated: false }, others)
        ).toBeNull();
    });
});
