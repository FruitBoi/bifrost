import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../entities/ThreadDirectory';

export interface SaveThreadDirectoryData {
    platform: ThreadDirectoryPlatform;
    guildId: string;
    channelId: string;
    messageId: string;
    title: string;
}

export interface SaveThreadDirectoryEntryData {
    platform: ThreadDirectoryPlatform;
    channelId: string;
    threadId: string;
    /** Omitted: keep the stored value (null for a new row). */
    description?: string | null;
    /** Omitted: keep the stored value (false for a new row). */
    hidden?: boolean;
}

export interface ThreadDirectoryRepository {
    /** The directory of `channelId` on `platform`, if any. */
    findDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectory | null>;

    /** Creates or replaces the directory of (platform, channelId). */
    saveDirectory(data: SaveThreadDirectoryData): Promise<ThreadDirectory>;

    /** Removes the directory of (platform, channelId); entries are kept. True when one existed. */
    deleteDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<boolean>;

    /** Every entry stored for threads of `channelId` on `platform`. */
    listEntries(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectoryEntry[]>;

    /** Creates or updates the entry of (platform, threadId). */
    saveEntry(
        data: SaveThreadDirectoryEntryData
    ): Promise<ThreadDirectoryEntry>;

    /** Removes the entry of (platform, threadId), e.g. when the thread is deleted. */
    deleteEntry(
        platform: ThreadDirectoryPlatform,
        threadId: string
    ): Promise<void>;
}
