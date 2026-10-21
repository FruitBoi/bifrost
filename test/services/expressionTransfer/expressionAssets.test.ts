import { describe, expect, it } from 'vitest';
import {
    BULK_CHUNK_SIZE,
    chunk,
    emojiNameProblem,
    isValidFluxerEmojiName,
    isValidFluxerStickerName,
    normalizeStickerDescription,
    normalizeStickerTags,
    pickImageMime,
    planTransfer,
    stickerNameProblem,
    toDataUrl,
} from '../../../src/services/expressionTransfer/expressionAssets';

describe('emoji names', () => {
    it('accepts 2–32 ASCII letters, digits and underscores', () => {
        expect(isValidFluxerEmojiName('ok')).toBe(true);
        expect(isValidFluxerEmojiName('Pepe_Hands2')).toBe(true);
        expect(isValidFluxerEmojiName('a'.repeat(32))).toBe(true);
        expect(isValidFluxerEmojiName(' padded ')).toBe(true);
    });

    it('rejects names that are too short, too long or non-ASCII', () => {
        expect(emojiNameProblem('a')).toContain('2–32');
        expect(emojiNameProblem('a'.repeat(33))).toContain('2–32');
        expect(emojiNameProblem('héllo')).toContain('ASCII');
        expect(emojiNameProblem('has space')).toContain('ASCII');
        expect(emojiNameProblem('dash-ed')).toContain('ASCII');
        expect(emojiNameProblem('')).not.toBeNull();
    });
});

describe('sticker names', () => {
    it('accepts 2–30 trimmed characters of any script', () => {
        expect(isValidFluxerStickerName('hi')).toBe(true);
        expect(isValidFluxerStickerName('Grüße aus Köln!')).toBe(true);
        expect(isValidFluxerStickerName('x'.repeat(30))).toBe(true);
        expect(stickerNameProblem('  ab  ')).toBeNull();
    });

    it('rejects names outside 2–30 characters after trimming', () => {
        expect(stickerNameProblem('a')).toContain('2–30');
        expect(stickerNameProblem(' a ')).toContain('2–30');
        expect(stickerNameProblem('x'.repeat(31))).toContain('2–30');
    });
});

describe('normalizeStickerDescription', () => {
    it('turns missing or blank descriptions into null', () => {
        expect(normalizeStickerDescription(null)).toBeNull();
        expect(normalizeStickerDescription(undefined)).toBeNull();
        expect(normalizeStickerDescription('   ')).toBeNull();
    });

    it('trims and caps at 500 characters', () => {
        expect(normalizeStickerDescription('  a cat  ')).toBe('a cat');
        expect(normalizeStickerDescription('d'.repeat(600))).toHaveLength(500);
    });
});

describe('normalizeStickerTags', () => {
    it('splits Discord’s comma-separated tag string', () => {
        expect(normalizeStickerTags('wave')).toEqual(['wave']);
        expect(normalizeStickerTags(' wave, hello ,,bye ')).toEqual([
            'wave',
            'hello',
            'bye',
        ]);
    });

    it('returns an empty list for missing tags', () => {
        expect(normalizeStickerTags(null)).toEqual([]);
        expect(normalizeStickerTags('')).toEqual([]);
        expect(normalizeStickerTags(' , ')).toEqual([]);
    });

    it('caps each tag at 30 characters and the list at 10', () => {
        const tags = normalizeStickerTags(
            Array.from({ length: 12 }, (_, i) => `t${i}`).join(',')
        );
        expect(tags).toHaveLength(10);
        expect(normalizeStickerTags('x'.repeat(40))).toEqual(['x'.repeat(30)]);
    });
});

describe('planTransfer', () => {
    const noProblem = () => null;

    it('uploads items in name/id order and skips existing names', () => {
        const plan = planTransfer(
            [
                { id: '3', name: 'zebra' },
                { id: '2', name: 'apple' },
                { id: '1', name: 'apple' },
                { id: '4', name: 'mango' },
            ],
            ['mango'],
            { nameProblem: noProblem }
        );
        expect(plan.upload.map((i) => i.id)).toEqual(['1', '3']);
        expect(plan.skipped).toEqual([
            { name: 'apple', reason: 'duplicate name on Discord' },
            { name: 'mango', reason: 'already exists on Fluxer' },
        ]);
    });

    it('compares names exactly, case-sensitively', () => {
        const plan = planTransfer(
            [
                { id: '1', name: 'Pepe' },
                { id: '2', name: 'pepe' },
            ],
            ['PEPE'],
            { nameProblem: noProblem }
        );
        expect(plan.upload.map((i) => i.name)).toEqual(['Pepe', 'pepe']);
        expect(plan.skipped).toEqual([]);
    });

    it('skips invalid names with the problem spelled out', () => {
        const plan = planTransfer(
            [
                { id: '1', name: 'a' },
                { id: '2', name: 'fine' },
            ],
            [],
            { nameProblem: emojiNameProblem }
        );
        expect(plan.upload.map((i) => i.name)).toEqual(['fine']);
        expect(plan.skipped).toEqual([
            {
                name: 'a',
                reason: 'invalid name for Fluxer: must be 2–32 characters',
            },
        ]);
    });

    it('skips untransferable items before anything else', () => {
        const plan = planTransfer(
            [
                { id: '1', name: 'lottie', lottie: true },
                { id: '2', name: 'lottie', lottie: false },
            ],
            [],
            {
                nameProblem: noProblem,
                untransferableReason: (item) =>
                    item.lottie
                        ? 'Lottie stickers cannot be transferred'
                        : null,
            }
        );
        expect(plan.upload.map((i) => i.id)).toEqual(['2']);
        expect(plan.skipped).toEqual([
            { name: 'lottie', reason: 'Lottie stickers cannot be transferred' },
        ]);
    });

    it('matches trimmed names against the Fluxer guild', () => {
        const plan = planTransfer([{ id: '1', name: ' hug ' }], ['hug'], {
            nameProblem: noProblem,
        });
        expect(plan.upload).toEqual([]);
        expect(plan.skipped).toEqual([
            { name: 'hug', reason: 'already exists on Fluxer' },
        ]);
    });
});

describe('pickImageMime', () => {
    it('uses an image Content-Type, dropping parameters', () => {
        expect(pickImageMime('image/png', 'https://x/e.gif')).toBe('image/png');
        expect(pickImageMime('Image/GIF; charset=binary', 'https://x/e')).toBe(
            'image/gif'
        );
    });

    it('falls back to the URL extension for non-image Content-Types', () => {
        expect(
            pickImageMime('application/octet-stream', 'https://x/e.webp?size=4')
        ).toBe('image/webp');
        expect(pickImageMime(null, 'https://x/s.png')).toBe('image/png');
        expect(pickImageMime('text/html', 'https://x/s.gif#frag')).toBe(
            'image/gif'
        );
        expect(pickImageMime(null, 'not a url/file.JPG')).toBe('image/jpeg');
    });

    it('falls back to application/octet-stream when nothing is known', () => {
        expect(pickImageMime(null, 'https://x/noext')).toBe(
            'application/octet-stream'
        );
        expect(pickImageMime('', 'https://x/weird.bin')).toBe(
            'application/octet-stream'
        );
    });
});

describe('toDataUrl', () => {
    it('builds a base64 data URL with the chosen mime', () => {
        const bytes = Buffer.from('hello');
        expect(toDataUrl(bytes, 'image/png', 'https://x/e.gif')).toBe(
            `data:image/png;base64,${bytes.toString('base64')}`
        );
        expect(toDataUrl(bytes, null, 'https://x/e.gif')).toBe(
            `data:image/gif;base64,${bytes.toString('base64')}`
        );
    });
});

describe('chunk', () => {
    it('splits into consecutive groups of at most size', () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(chunk([], 3)).toEqual([]);
        expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    });

    it('rejects non-positive sizes', () => {
        expect(() => chunk([1], 0)).toThrow(RangeError);
    });

    it('uses a bulk chunk size of 10', () => {
        expect(BULK_CHUNK_SIZE).toBe(10);
    });
});
