import { describe, expect, it } from 'vitest';
import { sanitizeDiscordWebhookUsername } from '../../src/utils/sanitizeDiscordWebhookUsername';

describe('sanitizeDiscordWebhookUsername', () => {
    it('leaves ordinary names untouched', () => {
        expect(sanitizeDiscordWebhookUsername('Brandon')).toBe('Brandon');
    });

    it('rewrites names containing "discord" so Discord accepts them', () => {
        const out = sanitizeDiscordWebhookUsername('DiscordFan');
        expect(out.toLowerCase()).not.toContain('discord');
        expect(out).toHaveLength('DiscordFan'.length);
    });

    it('rewrites every occurrence, case-insensitively', () => {
        const out = sanitizeDiscordWebhookUsername('discord DISCORD dIsCoRd');
        expect(out.toLowerCase()).not.toContain('discord');
    });

    it('rewrites names containing "clyde"', () => {
        expect(
            sanitizeDiscordWebhookUsername('clyde').toLowerCase()
        ).not.toContain('clyde');
    });

    it('truncates to 80 characters', () => {
        expect(sanitizeDiscordWebhookUsername('a'.repeat(100))).toHaveLength(
            80
        );
    });

    it('falls back when the name is empty', () => {
        expect(sanitizeDiscordWebhookUsername('   ')).toBe('Bifröst user');
    });
});
