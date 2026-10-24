import { describe, expect, it, vi } from 'vitest';
import {
    fetchAllDiscordPins,
    fetchAllFluxerPins,
    isDiscordPinsChannel,
    isFluxerPinsChannel,
} from '../../../src/services/pinBridge/pinChannels';

describe('fetchAllDiscordPins', () => {
    it('follows pages using the oldest pin time as the cursor', async () => {
        const fetchPins = vi
            .fn()
            .mockResolvedValueOnce({
                items: [
                    { pinnedTimestamp: 300, message: { id: 'c' } },
                    { pinnedTimestamp: 200, message: { id: 'b' } },
                ],
                hasMore: true,
            })
            .mockResolvedValueOnce({
                items: [{ pinnedTimestamp: 100, message: { id: 'a' } }],
                hasMore: false,
            });

        const pins = await fetchAllDiscordPins({ messages: { fetchPins } });

        expect(pins.map((p) => [p.id, p.pinnedAt])).toEqual([
            ['c', 300],
            ['b', 200],
            ['a', 100],
        ]);
        expect(fetchPins).toHaveBeenNthCalledWith(2, {
            limit: 50,
            before: new Date(200),
        });
    });
});

describe('fetchAllFluxerPins', () => {
    it('follows pages using the oldest pinned_at as the cursor', async () => {
        const t1 = '2026-01-01T00:00:00.000Z';
        const t2 = '2026-01-02T00:00:00.000Z';
        const page = vi
            .fn()
            .mockResolvedValueOnce({
                messages: [{ id: 'b' }],
                pinnedAt: [t2],
                hasMore: true,
            })
            .mockResolvedValueOnce({
                messages: [{ id: 'a' }],
                pinnedAt: [t1],
                hasMore: false,
            });

        const pins = await fetchAllFluxerPins({
            fetchPinnedMessagesPage: page,
        });

        expect(pins.map((p) => [p.id, p.pinnedAt])).toEqual([
            ['b', Date.parse(t2)],
            ['a', Date.parse(t1)],
        ]);
        expect(page).toHaveBeenNthCalledWith(2, { limit: 50, before: t2 });
    });
});

describe('channel guards', () => {
    it('recognise the pin APIs by shape', () => {
        expect(
            isDiscordPinsChannel({ messages: { fetchPins: () => {} } })
        ).toBe(true);
        expect(isDiscordPinsChannel(null)).toBe(false);
        expect(isFluxerPinsChannel({ fetchPinnedMessagesPage: () => {} })).toBe(
            true
        );
        expect(isFluxerPinsChannel({})).toBe(false);
    });
});
