import { describe, expect, it } from 'vitest';
import { twitterEmbedFields } from '../../../src/services/twitter/twitterEmbed';
import type { TwitterPost } from '../../../src/services/twitter/TwitterMediaService';

function post(overrides: Partial<TwitterPost> = {}): TwitterPost {
    return {
        sourceUrl: 'https://x.com/NASA/status/123',
        spoiler: false,
        username: 'NASA',
        displayName: 'NASA Space',
        profilePicUrl: 'https://pbs.twimg.com/profile_images/1/me_normal.jpg',
        text: 'Hello world',
        files: [],
        ...overrides,
    };
}

describe('twitterEmbedFields', () => {
    it('fills author, title, text and footer', () => {
        expect(twitterEmbedFields(post())).toEqual({
            url: 'https://x.com/NASA/status/123',
            title: 'Tweet by NASA Space',
            description: 'Hello world',
            authorName: 'NASA Space (@NASA)',
            authorUrl: 'https://x.com/NASA',
            authorIconUrl:
                'https://pbs.twimg.com/profile_images/1/me_normal.jpg',
            footer: 'X (Twitter)',
            color: 0x1d9bf0,
        });
    });

    it('falls back to a generic title and handle-only author', () => {
        const fields = twitterEmbedFields(
            post({ displayName: null, profilePicUrl: null })
        );
        expect(fields.title).toBe('Post on X');
        expect(fields.authorName).toBe('@NASA');
        expect(fields.authorIconUrl).toBeUndefined();
    });

    it('omits unknown author and empty text', () => {
        const fields = twitterEmbedFields(
            post({ username: null, displayName: null, text: '   ' })
        );
        expect(fields.authorName).toBeUndefined();
        expect(fields.authorUrl).toBeUndefined();
        expect(fields.authorIconUrl).toBeUndefined();
        expect(fields.description).toBeUndefined();
    });

    it('truncates long text without splitting surrogate pairs', () => {
        const fields = twitterEmbedFields(post({ text: '😀'.repeat(2000) }));
        const chars = Array.from(fields.description ?? '');
        expect(chars).toHaveLength(1000);
        expect(chars.at(-1)).toBe('…');
        expect(chars[0]).toBe('😀');
    });

    it('wraps spoiler text and neutralizes inner ||', () => {
        const fields = twitterEmbedFields(
            post({ spoiler: true, text: 'a || b' })
        );
        expect(fields.description?.startsWith('||')).toBe(true);
        expect(fields.description?.endsWith('||')).toBe(true);
        expect(fields.description?.slice(2, -2)).not.toContain('||');
    });
});
