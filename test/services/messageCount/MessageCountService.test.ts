import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagePlatform } from '../../../src/db/entities/MessageLink';
import { MessageCountRepository } from '../../../src/db/repositories/MessageCountRepository';
import MessageCountService, {
    HOUR_MS,
    toEpochHour,
} from '../../../src/services/messageCount/MessageCountService';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** In-memory MessageCountRepository with the same semantics as the table. */
class MemoryMessageCountRepository implements MessageCountRepository {
    buckets = new Map<string, number>();

    private key(guildLinkId: string, platform: MessagePlatform, hour: number) {
        return JSON.stringify([guildLinkId, platform, hour]);
    }

    private entries() {
        return [...this.buckets].map(([key, count]) => {
            const [guildLinkId, platform, hour] = JSON.parse(key) as [
                string,
                MessagePlatform,
                number,
            ];
            return { guildLinkId, platform, hour, count };
        });
    }

    async increment(
        guildLinkId: string,
        platform: MessagePlatform,
        hour: number
    ) {
        const key = this.key(guildLinkId, platform, hour);
        this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    }

    async sumByPlatform(guildLinkId: string, sinceHour?: number) {
        const sums: Record<MessagePlatform, number> = { discord: 0, fluxer: 0 };
        for (const e of this.entries()) {
            if (e.guildLinkId !== guildLinkId) continue;
            if (sinceHour !== undefined && e.hour < sinceHour) continue;
            sums[e.platform] += e.count;
        }
        return sums;
    }

    async firstHour(guildLinkId: string) {
        const hours = this.entries()
            .filter((e) => e.guildLinkId === guildLinkId)
            .map((e) => e.hour);
        return hours.length ? Math.min(...hours) : null;
    }
}

// 2026-10-24T15:42:10.500Z: deliberately not on an hour boundary.
const NOW = new Date(Date.UTC(2026, 9, 24, 15, 42, 10, 500));
const CURRENT_HOUR = Math.floor(NOW.getTime() / HOUR_MS);

describe('MessageCountService', () => {
    let repo: MemoryMessageCountRepository;
    let clock: Date;
    let service: MessageCountService;

    /** Records `n` messages as if they were bridged `hoursAgo` hours before NOW. */
    const recordAt = async (
        hoursAgo: number,
        source: MessagePlatform,
        n = 1,
        guildLinkId = 'g1'
    ) => {
        clock = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
        for (let i = 0; i < n; i++) await service.record(guildLinkId, source);
        clock = NOW;
    };

    beforeEach(() => {
        vi.mocked(logger.warn).mockClear();
        repo = new MemoryMessageCountRepository();
        clock = NOW;
        service = new MessageCountService(repo, () => clock);
    });

    it('computes the UTC epoch hour', () => {
        expect(toEpochHour(NOW)).toBe(CURRENT_HOUR);
        expect(toEpochHour(new Date(0))).toBe(0);
        expect(toEpochHour(new Date(HOUR_MS - 1))).toBe(0);
        expect(toEpochHour(new Date(HOUR_MS))).toBe(1);
    });

    it('records into the current UTC hour bucket per guild link and platform', async () => {
        const increment = vi.spyOn(repo, 'increment');
        await service.record('g1', 'discord');
        await service.record('g1', 'fluxer');
        expect(increment).toHaveBeenNthCalledWith(
            1,
            'g1',
            'discord',
            CURRENT_HOUR
        );
        expect(increment).toHaveBeenNthCalledWith(
            2,
            'g1',
            'fluxer',
            CURRENT_HOUR
        );
    });

    it('returns zeros and a null since when nothing was recorded', async () => {
        const zero = { discord: 0, fluxer: 0 };
        expect(await service.getCounts('g1')).toEqual({
            last24h: zero,
            last7d: zero,
            last30d: zero,
            allTime: zero,
            since: null,
        });
    });

    it('keeps the platforms and guild links apart', async () => {
        await recordAt(0, 'discord', 3);
        await recordAt(0, 'fluxer', 2);
        await recordAt(0, 'discord', 7, 'g2');

        const counts = await service.getCounts('g1');
        expect(counts.last24h).toEqual({ discord: 3, fluxer: 2 });
        expect(counts.allTime).toEqual({ discord: 3, fluxer: 2 });
        expect((await service.getCounts('g2')).allTime).toEqual({
            discord: 7,
            fluxer: 0,
        });
    });

    it('includes the bucket 23 hours back in last24h but not the one 24 hours back', async () => {
        await recordAt(23, 'discord');
        await recordAt(24, 'fluxer');

        const counts = await service.getCounts('g1');
        expect(counts.last24h).toEqual({ discord: 1, fluxer: 0 });
        expect(counts.last7d).toEqual({ discord: 1, fluxer: 1 });
    });

    it('uses 168 hourly buckets for last7d and 720 for last30d', async () => {
        await recordAt(167, 'discord');
        await recordAt(168, 'fluxer');
        await recordAt(719, 'discord', 2);
        await recordAt(720, 'fluxer', 4);
        await recordAt(5000, 'discord', 8);

        const counts = await service.getCounts('g1');
        expect(counts.last24h).toEqual({ discord: 0, fluxer: 0 });
        expect(counts.last7d).toEqual({ discord: 1, fluxer: 0 });
        expect(counts.last30d).toEqual({ discord: 3, fluxer: 1 });
        expect(counts.allTime).toEqual({ discord: 11, fluxer: 5 });
    });

    it('reports the start of the first recorded hour as since', async () => {
        await recordAt(0, 'fluxer');
        await recordAt(50, 'discord');

        const { since } = await service.getCounts('g1');
        expect(since).toEqual(new Date((CURRENT_HOUR - 50) * HOUR_MS));
        expect(since?.toISOString()).toBe('2026-10-22T13:00:00.000Z');
    });

    it('queries the windows with the right since hours, in parallel', async () => {
        const sum = vi.spyOn(repo, 'sumByPlatform');
        const first = vi.spyOn(repo, 'firstHour');
        let pending = 0;
        let maxPending = 0;
        sum.mockImplementation(async () => {
            pending++;
            maxPending = Math.max(maxPending, pending);
            await new Promise((r) => setTimeout(r, 5));
            pending--;
            return { discord: 0, fluxer: 0 };
        });

        await service.getCounts('g1');
        expect(sum.mock.calls).toEqual([
            ['g1', CURRENT_HOUR - 23],
            ['g1', CURRENT_HOUR - 167],
            ['g1', CURRENT_HOUR - 719],
            ['g1'],
        ]);
        expect(first).toHaveBeenCalledWith('g1');
        expect(maxPending).toBe(4);
    });

    it('swallows and logs repository failures in record', async () => {
        vi.spyOn(repo, 'increment').mockRejectedValueOnce(new Error('db down'));

        await expect(service.record('g1', 'fluxer')).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);

        // The next message is counted normally.
        await service.record('g1', 'fluxer');
        expect((await service.getCounts('g1')).allTime).toEqual({
            discord: 0,
            fluxer: 1,
        });
    });

    it('swallows a clock that throws in record', async () => {
        const broken = new MessageCountService(repo, () => {
            throw new Error('no clock');
        });
        await expect(broken.record('g1', 'discord')).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});
