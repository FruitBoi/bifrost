import { describe, expect, it, vi } from 'vitest';
import {
    buildFluxerDirectoryEmbeds,
    fluxerMessageText,
} from '../../../src/services/threadDirectory/FluxerThreadDirectoryAdapter';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('buildFluxerDirectoryEmbeds', () => {
    it('puts the title on the first embed and the timestamp on the last, when the page has them', () => {
        const first = buildFluxerDirectoryEmbeds({
            title: 'Threads Directory',
            descriptions: ['a', 'b'],
            timestamp: false,
        }).map((e) => e.toJSON());
        expect(first.map((e) => e.title)).toEqual([
            'Threads Directory',
            undefined,
        ]);
        expect(first.map((e) => e.description)).toEqual(['a', 'b']);
        expect(first.every((e) => e.timestamp === undefined)).toBe(true);

        const last = buildFluxerDirectoryEmbeds({
            descriptions: ['c', 'd'],
            timestamp: true,
        }).map((e) => e.toJSON());
        expect(last.every((e) => e.title === undefined)).toBe(true);
        expect(last[0].timestamp).toBeUndefined();
        expect(last[1].timestamp).toBeDefined();
    });
});

describe('fluxerMessageText', () => {
    it('joins content and embed titles/descriptions', () => {
        expect(
            fluxerMessageText({
                content: 'Threads Directory',
                embeds: [
                    { title: 'Title', description: 'line 1\nline 2' },
                    { title: null, description: 'line 3' },
                ],
            })
        ).toBe('Threads Directory\nTitle\nline 1\nline 2\nline 3');
        expect(fluxerMessageText({ content: '', embeds: [] })).toBe('');
    });
});
