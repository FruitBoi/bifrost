import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../entities/ThreadDirectory';

export interface SaveThreadDirectoryData {
    platform: ThreadDirectoryPlatform;
    guildId: string;
    channelId: string;
    /** Every directory message, in order; must not be empty. */
    messageIds: string[];
    title: string;
}

export interface SaveThreadDirectoryEntryData {
    platform: ThreadDirectoryPlatform;
    channelId: string;
    threadId: string;
    /** Omitted: keep the stored value (null for a new row). */
    guildId?: string | null;
    /** Omitted: keep the stored value (null for a new row). */
    description?: string | null;
    /** Omitted: keep the stored value (false for a new row). */
    hidden?: boolean;
    /** Omitted: keep the stored value (null for a new row). */
    roleId?: string | null;
    /** Omitted: keep the stored value (false for a new row). */
    added?: boolean;
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

    /** Every entry of the directory channel `channelId` on `platform`. */
    listEntries(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectoryEntry[]>;

    /** Every entry of the guild that has a role linked, in insertion order. */
    listRoleEntries(
        platform: ThreadDirectoryPlatform,
        guildId: string
    ): Promise<ThreadDirectoryEntry[]>;

    /** Creates or updates the entry of (platform, channelId, threadId). */
    saveEntry(
        data: SaveThreadDirectoryEntryData
    ): Promise<ThreadDirectoryEntry>;

    /** Removes the entry of (platform, channelId, threadId). True when one existed. */
    deleteEntry(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        threadId: string
    ): Promise<boolean>;

    /**
     * Removes every entry of `threadId` (in any directory), e.g. when the
     * thread is deleted. Returns the directory channels that had one.
     */
    deleteEntriesForThread(
        platform: ThreadDirectoryPlatform,
        threadId: string
    ): Promise<string[]>;
}
