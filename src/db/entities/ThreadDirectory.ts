export type ThreadDirectoryPlatform = 'discord' | 'fluxer';

/**
 * A threads directory (issue #37): one or more messages the bot posted in a
 * channel listing that channel's threads (plus channels/threads added from
 * elsewhere) with optional descriptions and roles, kept up to date by
 * editing them. All IDs belong to `platform`; there is at most one directory
 * per (platform, channelId).
 */
export interface ThreadDirectory {
    id: number;
    platform: ThreadDirectoryPlatform;
    guildId: string;
    /** The channel whose threads are listed and where the messages live. */
    channelId: string;
    /** The first directory message (same as `messageIds[0]`). */
    messageId: string;
    /** Every directory message, in order; a long directory spans several. */
    messageIds: string[];
    /** Heading of the directory (on its first message). */
    title: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Per-thread settings of a threads directory. Rows outlive the directory
 * itself, so removing and re-posting a directory keeps its descriptions.
 * Unique per (platform, channelId, threadId): a channel or thread added with
 * `directory add` may be listed by several directories.
 */
export interface ThreadDirectoryEntry {
    id: number;
    platform: ThreadDirectoryPlatform;
    /** Guild of the directory; null for rows written before it was stored. */
    guildId: string | null;
    /** The directory's channel (the parent of native threads). */
    channelId: string;
    /** The listed thread, or for added entries any channel or thread of the guild. */
    threadId: string;
    /** Shown before the thread in the directory; null for none. */
    description: string | null;
    /** Hidden threads are left out of the directory. */
    hidden: boolean;
    /** Role linked to the thread (shown in the directory, self-assignable with `lfg`); null for none. */
    roleId: string | null;
    /** True when listed with `directory add` (lives outside the directory channel). */
    added: boolean;
    createdAt: Date;
    updatedAt: Date;
}
