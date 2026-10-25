/**
 * Bridged message counts (issue #46): tracks how many messages each side of
 * a guild link sends through the bridge, so the activity of the Discord and
 * Fluxer servers can be compared.
 *
 * The relays call {@link MessageCountService.record} once per message that
 * was bridged live; history imports, pins and edits are not counted. Counts
 * are stored per guild link, source platform and UTC hour, so
 * {@link MessageCountService.getCounts} can report rolling windows that end
 * with the current (partial) hour. The buckets are durable: unlike message
 * links they survive message deletes and are only removed with their guild
 * link.
 */
import { MessagePlatform } from '../../db/entities/MessageLink';
import { MessageCountRepository } from '../../db/repositories/MessageCountRepository';
import logger from '../../utils/logging/logger';

/** Length of one bucket: an hour in milliseconds. */
export const HOUR_MS = 3_600_000;

export interface PlatformCounts {
    discord: number;
    fluxer: number;
}

export interface MessageCounts {
    /** Current hour bucket plus the previous 23. */
    last24h: PlatformCounts;
    /** Last 168 hourly buckets, current one included. */
    last7d: PlatformCounts;
    /** Last 720 hourly buckets, current one included. */
    last30d: PlatformCounts;
    allTime: PlatformCounts;
    /** Start of the first recorded hour for this guild link, or null when nothing was recorded yet. */
    since: Date | null;
}

/** UTC epoch hour of a date: `Math.floor(ms / 3_600_000)`. */
export const toEpochHour = (date: Date): number =>
    Math.floor(date.getTime() / HOUR_MS);

export default class MessageCountService {
    /**
     * @param repository Where the hourly buckets are stored.
     * @param now Clock used to pick the bucket and the windows. Default the
     * current time.
     */
    constructor(
        private readonly repository: MessageCountRepository,
        private readonly now: () => Date = () => new Date()
    ) {}

    /**
     * Counts one message bridged from `source` in this guild link.
     * Best-effort: never rejects, so a database hiccup cannot fail a relay;
     * failures are logged.
     */
    async record(guildLinkId: string, source: MessagePlatform): Promise<void> {
        try {
            const hour = toEpochHour(this.now());
            await this.repository.increment(guildLinkId, source, hour);
        } catch (err) {
            logger.warn(
                `⚠️ Failed to count a bridged ${source} message for guild link ${guildLinkId}:`,
                err
            );
        }
    }

    /** Message counts per platform for the last 24 hours, 7 days, 30 days and all time. */
    async getCounts(guildLinkId: string): Promise<MessageCounts> {
        const current = toEpochHour(this.now());
        const [last24h, last7d, last30d, allTime, firstHour] =
            await Promise.all([
                this.repository.sumByPlatform(guildLinkId, current - 23),
                this.repository.sumByPlatform(guildLinkId, current - 167),
                this.repository.sumByPlatform(guildLinkId, current - 719),
                this.repository.sumByPlatform(guildLinkId),
                this.repository.firstHour(guildLinkId),
            ]);

        return {
            last24h: toPlatformCounts(last24h),
            last7d: toPlatformCounts(last7d),
            last30d: toPlatformCounts(last30d),
            allTime: toPlatformCounts(allTime),
            since: firstHour === null ? null : new Date(firstHour * HOUR_MS),
        };
    }
}

/** Copies only the two platforms, so callers get a plain, complete object. */
const toPlatformCounts = (
    sums: Partial<Record<MessagePlatform, number>>
): PlatformCounts => ({
    discord: sums.discord ?? 0,
    fluxer: sums.fluxer ?? 0,
});
