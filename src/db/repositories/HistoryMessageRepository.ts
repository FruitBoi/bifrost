import { MessagePlatform } from '../entities/MessageLink';

export interface CreateHistoryMessageData {
    guildLinkId: string;
    channelLinkId: string;
    sourcePlatform: MessagePlatform;
    sourceMessageId: string;
    targetMessageId: string;
}

export interface HistoryMessageRepository {
    /**
     * Inserts rows; a row whose (sourcePlatform, sourceMessageId) already
     * exists is ignored, so re-running a transfer never duplicates anything.
     */
    createMany(rows: CreateHistoryMessageData[]): Promise<void>;

    /** Of `sourceMessageIds`, those already recorded for `sourcePlatform`. */
    findTransferredIds(
        sourcePlatform: MessagePlatform,
        sourceMessageIds: readonly string[]
    ): Promise<Set<string>>;

    deleteByChannelLinkId(channelLinkId: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    count(): Promise<number>;
}
