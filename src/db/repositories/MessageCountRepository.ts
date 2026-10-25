import { MessagePlatform } from '../entities/MessageLink';

export interface MessageCountRepository {
    /** Atomically adds one to the (guild link, platform, hour) bucket, creating it when missing. */
    increment(
        guildLinkId: string,
        sourcePlatform: MessagePlatform,
        hour: number
    ): Promise<void>;

    /** Sum of counts per platform for buckets with hour >= sinceHour (all buckets when undefined). */
    sumByPlatform(
        guildLinkId: string,
        sinceHour?: number
    ): Promise<Record<MessagePlatform, number>>;

    /** Smallest recorded hour for the guild link, or null when nothing was recorded. */
    firstHour(guildLinkId: string): Promise<number | null>;
}
