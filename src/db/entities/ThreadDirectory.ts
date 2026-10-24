export type ThreadDirectoryPlatform = 'discord' | 'fluxer';

/**
 * A threads directory message (issue #37): a message the bot posted in a
 * channel listing that channel's threads with optional descriptions, kept up
 * to date by editing it. All IDs belong to `platform`; there is at most one
 * directory per (platform, channelId).
 */
export interface ThreadDirectory {
    id: number;
    platform: ThreadDirectoryPlatform;
    guildId: string;
    /** The channel whose threads are listed and where the message lives. */
    channelId: string;
    /** The directory message the bot posted. */
    messageId: string;
    /** Heading of the directory message. */
    title: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Per-thread settings of a threads directory. Rows outlive the directory
 * itself, so removing and re-posting a directory keeps its descriptions.
 * Unique per (platform, threadId).
 */
export interface ThreadDirectoryEntry {
    id: number;
    platform: ThreadDirectoryPlatform;
    /** Parent channel of the thread (the directory's channel). */
    channelId: string;
    threadId: string;
    /** Shown after the thread in the directory; null for none. */
    description: string | null;
    /** Hidden threads are left out of the directory. */
    hidden: boolean;
    createdAt: Date;
    updatedAt: Date;
}
