import { describe, expect, it } from 'vitest';
import { instagramEmbedFields } from '../../../src/services/instagramVideo/instagramEmbed';
import type { InstagramPost } from '../../../src/services/instagramVideo/InstagramVideoService';

function post(overrides: Partial<InstagramPost> = {}): InstagramPost {
    return {
        sourceUrl: 'https://www.instagram.com/p/ABC123/',
        spoiler: false,
        username: 'someone',
        profilePicUrl: 'https://cdn.example/pic.jpg',
        caption: 'Hello world',
        files: [],
        ...overrides,
    };
}

describe('instagramEmbedFields', () => {
    it('fills author, title, caption and footer', () => {
        expect(instagramEmbedFields(post())).toEqual({
            url: 'https://www.instagram.com/p/ABC123/',
            title: 'Instagram post',
            description: 'Hello world',
            authorName: '@someone',
            authorUrl: 'https://www.instagram.com/someone/',
            authorIconUrl: 'https://cdn.example/pic.jpg',
            footer: 'Instagram',
            color: 0xe1306c,
        });
    });

    it('titles reels and omits unknown author and empty caption', () => {
        const fields = instagramEmbedFields(
            post({
                sourceUrl: 'https://www.instagram.com/reel/XYZ/',
                username: null,
                caption: '   ',
            })
        );
        expect(fields.title).toBe('Instagram reel');
        expect(fields.authorName).toBeUndefined();
        expect(fields.authorIconUrl).toBeUndefined();
        expect(fields.description).toBeUndefined();
    });

    it('truncates long captions without splitting surrogate pairs', () => {
        const fields = instagramEmbedFields(
            post({ caption: '😀'.repeat(2000) })
        );
        const chars = Array.from(fields.description ?? '');
        expect(chars).toHaveLength(1000);
        expect(chars.at(-1)).toBe('…');
        expect(chars[0]).toBe('😀');
    });

    it('wraps spoiler captions and neutralizes inner ||', () => {
        const fields = instagramEmbedFields(
            post({ spoiler: true, caption: 'a || b' })
        );
        expect(fields.description?.startsWith('||')).toBe(true);
        expect(fields.description?.endsWith('||')).toBe(true);
        expect(fields.description?.slice(2, -2)).not.toContain('||');
    });
});
