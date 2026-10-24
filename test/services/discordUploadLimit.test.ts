import { describe, expect, it } from 'vitest';
import {
    DISCORD_DEFAULT_UPLOAD_LIMIT,
    appendAttachmentLinks,
    discordUploadLimitForTier,
    splitOversizedAttachments,
} from '../../src/services/discordUploadLimit';
import { WebhookAttachment } from '../../src/services/WebhookService';

const MiB = 1024 * 1024;

function att(
    name: string,
    size?: number,
    spoiler?: boolean
): WebhookAttachment {
    return {
        url: `https://cdn.example/${name}`,
        name,
        size,
        ...(spoiler ? { spoiler } : {}),
    };
}

describe('discordUploadLimitForTier', () => {
    it('maps boost tiers to upload limits', () => {
        expect(discordUploadLimitForTier(2)).toBe(50 * MiB);
        expect(discordUploadLimitForTier(3)).toBe(100 * MiB);
    });

    it('falls back to the default for tiers 0/1 and missing values', () => {
        expect(DISCORD_DEFAULT_UPLOAD_LIMIT).toBe(10 * MiB);
        expect(discordUploadLimitForTier(0)).toBe(10 * MiB);
        expect(discordUploadLimitForTier(1)).toBe(10 * MiB);
        expect(discordUploadLimitForTier(null)).toBe(10 * MiB);
        expect(discordUploadLimitForTier(undefined)).toBe(10 * MiB);
    });
});

describe('splitOversizedAttachments', () => {
    it('uploads everything when all files are small', () => {
        const list = [att('a.png', 1 * MiB), att('b.png', 2 * MiB)];
        const { upload, linked } = splitOversizedAttachments(list, 10 * MiB);
        expect(upload).toEqual(list);
        expect(linked).toEqual([]);
    });

    it('links a single oversized video', () => {
        const video = att('clip.mp4', 30 * MiB);
        const { upload, linked } = splitOversizedAttachments(
            [video],
            10 * MiB
        );
        expect(upload).toEqual([]);
        expect(linked).toEqual([video]);
    });

    it('accepts a file exactly at the limit', () => {
        const exact = att('exact.bin', 10 * MiB);
        const { upload, linked } = splitOversizedAttachments(
            [exact],
            10 * MiB
        );
        expect(upload).toEqual([exact]);
        expect(linked).toEqual([]);
    });

    it('counts sizes cumulatively', () => {
        const first = att('one.bin', 6 * MiB);
        const second = att('two.bin', 6 * MiB);
        const { upload, linked } = splitOversizedAttachments(
            [first, second],
            10 * MiB
        );
        expect(upload).toEqual([first]);
        expect(linked).toEqual([second]);
    });

    it('uploads files of unknown size', () => {
        const unknown = att('mystery.bin');
        const { upload, linked } = splitOversizedAttachments(
            [unknown],
            10 * MiB
        );
        expect(upload).toEqual([unknown]);
        expect(linked).toEqual([]);
    });

    it('still uploads a later smaller file after a big one was linked', () => {
        const big = att('big.mp4', 30 * MiB);
        const small = att('small.png', 1 * MiB);
        const { upload, linked } = splitOversizedAttachments(
            [big, small],
            10 * MiB
        );
        expect(upload).toEqual([small]);
        expect(linked).toEqual([big]);
    });

    it('preserves order within each list', () => {
        const a = att('a.png', 1 * MiB);
        const b = att('b.mp4', 30 * MiB);
        const c = att('c.png', 2 * MiB);
        const d = att('d.mp4', 40 * MiB);
        const e = att('e.png', 3 * MiB);
        const { upload, linked } = splitOversizedAttachments(
            [a, b, c, d, e],
            10 * MiB
        );
        expect(upload.map((x) => x.name)).toEqual(['a.png', 'c.png', 'e.png']);
        expect(linked.map((x) => x.name)).toEqual(['b.mp4', 'd.mp4']);
    });
});

describe('appendAttachmentLinks', () => {
    const video = att('clip.mp4', 30 * MiB);

    it('puts the link alone when content is empty', () => {
        expect(appendAttachmentLinks('', [video])).toBe(video.url);
        expect(appendAttachmentLinks('   ', [video])).toBe(video.url);
    });

    it('appends each link on its own line after the content', () => {
        const other = att('other.mp4', 30 * MiB);
        expect(appendAttachmentLinks('look', [video, other])).toBe(
            `look\n${video.url}\n${other.url}`
        );
    });

    it('wraps spoiler links in ||', () => {
        const spoiled = att('secret.mp4', 30 * MiB, true);
        expect(appendAttachmentLinks('look', [spoiled])).toBe(
            `look\n||${spoiled.url}||`
        );
    });

    it('returns the content unchanged when nothing is linked', () => {
        expect(appendAttachmentLinks('hello', [])).toBe('hello');
        expect(appendAttachmentLinks('', [])).toBe('');
    });

    it('trims the content with an ellipsis so links fit in 2000 chars', () => {
        const content = 'x'.repeat(2000);
        const result = appendAttachmentLinks(content, [video]);
        expect(result.length).toBeLessThanOrEqual(2000);
        expect(result.endsWith(`…\n${video.url}`)).toBe(true);
        expect(result.startsWith('xxx')).toBe(true);
    });

    it('never exceeds maxLength, even with a custom limit', () => {
        const content = 'y'.repeat(500);
        for (const max of [60, 100, 200, 2000]) {
            const result = appendAttachmentLinks(content, [video], max);
            expect(result.length).toBeLessThanOrEqual(max);
            expect(result).toContain(video.url);
        }
    });

    it('keeps as many whole links as fit when links alone overflow', () => {
        const links = [att('a.mp4', 1), att('b.mp4', 1), att('c.mp4', 1)];
        const max = links[0]!.url.length * 2 + 1; // two urls plus newline
        const result = appendAttachmentLinks('hello', links, max);
        expect(result.length).toBeLessThanOrEqual(max);
        expect(result).toContain(links[0]!.url);
        expect(result).toContain(links[1]!.url);
        expect(result).not.toContain(links[2]!.url);
    });
});
