import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../../db/entities/ThreadDirectory';
import { ThreadDirectoryRepository } from '../../db/repositories/ThreadDirectoryRepository';
import {
    chunkDescriptionLines,
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
} from '../../utils/embeds';
import logger from '../../utils/logging/logger';

/** Default heading of a directory message. */
export const DEFAULT_DIRECTORY_TITLE = 'Threads Directory';
/** Longest accepted directory title (embed title limit). */
export const DIRECTORY_TITLE_MAX = 256;
/** Longest accepted thread description. */
export const DIRECTORY_DESCRIPTION_MAX = 300;

/** A thread of the directory's channel, as listed by the platform. */
export interface DirectoryThread {
    id: string;
    name: string;
}

/** The rendered directory, built by the service and sent by an adapter. */
export interface DirectoryRender {
    title: string;
    /** Embed descriptions, in order; each fits one embed and all fit one message. */
    descriptions: string[];
}

/**
 * Platform side of the threads directory: lists threads and posts, edits and
 * deletes the directory message. One adapter per platform.
 */
export interface ThreadDirectoryPlatformAdapter {
    readonly platform: ThreadDirectoryPlatform;
    /**
     * Every public thread of `channelId` (active and archived). Throws
     * ThreadDirectoryError('unsupported_channel') when the channel cannot
     * hold a directory (not a text channel, or a thread itself).
     */
    listThreads(guildId: string, channelId: string): Promise<DirectoryThread[]>;
    /** Posts the directory in `channelId`; returns the message ID. */
    sendDirectory(channelId: string, render: DirectoryRender): Promise<string>;
    /** Edits the directory message; false when the message no longer exists. */
    editDirectory(
        channelId: string,
        messageId: string,
        render: DirectoryRender
    ): Promise<boolean>;
    /** Deletes the directory message; a message that is already gone is fine. */
    deleteDirectory(channelId: string, messageId: string): Promise<void>;
    /** Link to a message, for command replies. */
    messageUrl(guildId: string, channelId: string, messageId: string): string;
}

export type ThreadDirectoryErrorReason =
    /** The channel has no directory yet. */
    | 'no_directory'
    /** The directory message was deleted; post it again. */
    | 'message_missing'
    /** The thread is not a thread of the directory's channel. */
    | 'unknown_thread'
    /** The channel cannot hold a directory. */
    | 'unsupported_channel'
    /** Title or description too long. */
    | 'too_long'
    /** No adapter registered for the platform. */
    | 'unavailable';

export class ThreadDirectoryError extends Error {
    constructor(
        public readonly reason: ThreadDirectoryErrorReason,
        message: string
    ) {
        super(message);
        this.name = 'ThreadDirectoryError';
    }
}

/** One thread as shown by `getStatus`. */
export interface DirectoryStatusThread extends DirectoryThread {
    description: string | null;
    hidden: boolean;
}

export interface DirectoryStatus {
    /** Null when the channel has no directory posted. */
    directory: ThreadDirectory | null;
    /** Every thread of the channel, in directory order, hidden ones included. */
    threads: DirectoryStatusThread[];
}

/** Line shown when the directory lists no thread. */
export const EMPTY_DIRECTORY_LINE = '*No threads yet.*';
/** Default delay before a thread event refreshes the directory. */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 5000;

/** Longest embed description `chunkDescriptionLines` produces by default. */
const EMBED_DESCRIPTION_MAX = 4092;

/** Newlines (and the whitespace around them) collapse to one space. */
function collapseNewlines(text: string): string {
    return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Compares snowflakes numerically; non-numeric IDs fall back to string order. */
function compareSnowflakes(a: string, b: string): number {
    try {
        const x = BigInt(a);
        const y = BigInt(b);
        return x < y ? -1 : x > y ? 1 : 0;
    } catch {
        return a < b ? -1 : a > b ? 1 : 0;
    }
}

/** Threads in directory order: oldest (lowest snowflake) first. */
export function sortDirectoryThreads<T extends { id: string }>(
    threads: readonly T[]
): T[] {
    return [...threads].sort((a, b) => compareSnowflakes(a.id, b.id));
}

/** One directory line: the thread mention, then its description if any. */
export function directoryLine(threadId: string, description: string | null) {
    const text = description ? collapseNewlines(description) : '';
    return text ? `<#${threadId}> — ${text}` : `<#${threadId}>`;
}

/** Embed descriptions of `lines`, or null when they do not fit one message with `title`. */
function fitLines(title: string, lines: string[]): string[] | null {
    const descriptions = chunkDescriptionLines(
        lines,
        '\n',
        EMBED_DESCRIPTION_MAX
    ).map((chunk) => chunk.join('\n'));
    if (descriptions.length > EMBEDS_PER_MESSAGE_MAX) return null;
    const total =
        title.length + descriptions.reduce((sum, d) => sum + d.length, 0);
    return total <= EMBED_TOTAL_CHARS_MAX ? descriptions : null;
}

/**
 * Renders a directory: visible threads oldest first, one line each, split
 * into embed descriptions that together fit one message. When they do not,
 * trailing lines are dropped and replaced by `…and N more`.
 */
export function renderDirectory(
    title: string,
    threads: readonly DirectoryThread[],
    entries: readonly Pick<
        ThreadDirectoryEntry,
        'threadId' | 'description' | 'hidden'
    >[]
): DirectoryRender {
    const byThread = new Map(entries.map((e) => [e.threadId, e]));
    const lines = sortDirectoryThreads(threads)
        .filter((thread) => !byThread.get(thread.id)?.hidden)
        .map((thread) =>
            directoryLine(
                thread.id,
                byThread.get(thread.id)?.description ?? null
            )
        );

    if (lines.length === 0)
        return { title, descriptions: [EMPTY_DIRECTORY_LINE] };

    const all = fitLines(title, lines);
    if (all) return { title, descriptions: all };

    const attempt = (kept: number) =>
        fitLines(title, [
            ...lines.slice(0, kept),
            `…and ${lines.length - kept} more`,
        ]);

    // Fitting k lines implies fitting fewer, so binary search the most that fit.
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (attempt(mid)) low = mid;
        else high = mid - 1;
    }
    for (let kept = low; kept >= 0; kept--) {
        const descriptions = attempt(kept);
        if (descriptions) return { title, descriptions };
    }
    // Only reachable with an absurd title; validation caps it well below.
    return { title, descriptions: [`…and ${lines.length} more`] };
}

export interface ThreadDirectoryServiceOptions {
    /** Delay before a thread event refreshes the directory (ms). */
    refreshDebounceMs?: number;
}

/**
 * Threads directories (issue #37): a bot message listing a channel's threads
 * with optional descriptions, edited in place whenever the list or a
 * description changes, and refreshed automatically (debounced) when a thread
 * of the channel is created or deleted.
 *
 * Operations on one (platform, channel) run one at a time, so a debounced
 * refresh and a command never race to edit or post the same message.
 */
export default class ThreadDirectoryService {
    private readonly adapters = new Map<
        ThreadDirectoryPlatform,
        ThreadDirectoryPlatformAdapter
    >();
    /** Tail of the operation queue of each (platform, channel). */
    private readonly queues = new Map<string, Promise<unknown>>();
    /** Pending debounced refreshes by (platform, channel). */
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly refreshDebounceMs: number;

    constructor(
        private readonly repo: ThreadDirectoryRepository,
        options: ThreadDirectoryServiceOptions = {}
    ) {
        this.refreshDebounceMs =
            options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    }

    registerAdapter(adapter: ThreadDirectoryPlatformAdapter): void {
        this.adapters.set(adapter.platform, adapter);
    }

    /**
     * Posts the directory of `channelId`, replacing (deleting) the previous
     * directory message of that channel. `title` defaults to the previous
     * title, else DEFAULT_DIRECTORY_TITLE.
     */
    async post(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        title?: string
    ): Promise<ThreadDirectory> {
        const adapter = this.adapter(platform);
        const requested = title?.trim() ? validateTitle(title) : null;

        return this.exclusive(platform, channelId, async () => {
            const previous = await this.repo.findDirectory(platform, channelId);
            const finalTitle =
                requested ?? previous?.title ?? DEFAULT_DIRECTORY_TITLE;

            const render = await this.renderFor(
                adapter,
                guildId,
                channelId,
                finalTitle
            );
            const messageId = await adapter.sendDirectory(channelId, render);

            if (previous && previous.messageId !== messageId) {
                await adapter
                    .deleteDirectory(previous.channelId, previous.messageId)
                    .catch((err) =>
                        logger.warn(
                            `⚠️ Could not delete the previous threads directory ${previous.messageId} in ${platform} channel ${channelId}:`,
                            err
                        )
                    );
            }

            return this.repo.saveDirectory({
                platform,
                guildId,
                channelId,
                messageId,
                title: finalTitle,
            });
        });
    }

    /** Re-renders and edits the existing directory message. */
    async refresh(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectory> {
        const adapter = this.adapter(platform);
        return this.exclusive(platform, channelId, async () => {
            const directory = await this.requireDirectory(platform, channelId);
            return this.refreshDirectory(adapter, directory);
        });
    }

    /**
     * Sets (or with null/blank clears) the description of `threadId`, which
     * must be a thread of `channelId`, then refreshes the directory if one
     * is posted.
     */
    async setDescription(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        threadId: string,
        description: string | null
    ): Promise<void> {
        const adapter = this.adapter(platform);
        const trimmed = description?.trim() || null;
        if (trimmed && trimmed.length > DIRECTORY_DESCRIPTION_MAX) {
            throw new ThreadDirectoryError(
                'too_long',
                `Descriptions can be at most ${DIRECTORY_DESCRIPTION_MAX} characters.`
            );
        }

        await this.updateEntry(adapter, guildId, channelId, threadId, {
            description: trimmed,
        });
    }

    /** Hides or shows `threadId` in the directory, then refreshes it if posted. */
    async setHidden(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        threadId: string,
        hidden: boolean
    ): Promise<void> {
        const adapter = this.adapter(platform);
        await this.updateEntry(adapter, guildId, channelId, threadId, {
            hidden,
        });
    }

    /** Renames the directory and refreshes it. A blank title restores the default. */
    async setTitle(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        title: string
    ): Promise<ThreadDirectory> {
        const adapter = this.adapter(platform);
        const finalTitle = title.trim()
            ? validateTitle(title)
            : DEFAULT_DIRECTORY_TITLE;

        return this.exclusive(platform, channelId, async () => {
            const directory = await this.requireDirectory(platform, channelId);
            const saved = await this.repo.saveDirectory({
                platform,
                guildId: directory.guildId,
                channelId,
                messageId: directory.messageId,
                title: finalTitle,
            });
            return this.refreshDirectory(adapter, saved);
        });
    }

    /** Deletes the directory message and stops tracking it; descriptions are kept. False when there was none. */
    async remove(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<boolean> {
        const adapter = this.adapter(platform);
        return this.exclusive(platform, channelId, async () => {
            const directory = await this.repo.findDirectory(
                platform,
                channelId
            );
            if (!directory) return false;

            await adapter
                .deleteDirectory(directory.channelId, directory.messageId)
                .catch((err) =>
                    logger.warn(
                        `⚠️ Could not delete threads directory ${directory.messageId} in ${platform} channel ${channelId}:`,
                        err
                    )
                );
            return this.repo.deleteDirectory(platform, channelId);
        });
    }

    /** The directory of `channelId` and its threads with their settings. */
    async getStatus(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string
    ): Promise<DirectoryStatus> {
        const adapter = this.adapter(platform);
        const [directory, threads, entries] = await Promise.all([
            this.repo.findDirectory(platform, channelId),
            adapter.listThreads(guildId, channelId),
            this.repo.listEntries(platform, channelId),
        ]);
        const byThread = new Map(entries.map((e) => [e.threadId, e]));

        return {
            directory,
            threads: sortDirectoryThreads(threads).map((thread) => ({
                id: thread.id,
                name: thread.name,
                description: byThread.get(thread.id)?.description ?? null,
                hidden: byThread.get(thread.id)?.hidden ?? false,
            })),
        };
    }

    /** Link to the directory message. */
    messageUrl(directory: ThreadDirectory): string {
        return this.adapter(directory.platform).messageUrl(
            directory.guildId,
            directory.channelId,
            directory.messageId
        );
    }

    /**
     * A thread was created in `parentChannelId`: refresh its directory, if
     * any, after a short debounce. Never throws.
     */
    handleThreadCreated(
        platform: ThreadDirectoryPlatform,
        parentChannelId: string | null | undefined
    ): void {
        if (!parentChannelId) return;
        this.scheduleRefresh(platform, parentChannelId);
    }

    /**
     * A thread was deleted: forget its entry and refresh the parent's
     * directory, if any, after a short debounce. Never throws.
     */
    handleThreadDeleted(
        platform: ThreadDirectoryPlatform,
        parentChannelId: string | null | undefined,
        threadId: string
    ): void {
        try {
            this.repo
                .deleteEntry(platform, threadId)
                .catch((err) =>
                    logger.error(
                        `❌ Could not forget the threads directory entry of deleted ${platform} thread ${threadId}:`,
                        err
                    )
                );
        } catch (err) {
            logger.error(
                `❌ Could not forget the threads directory entry of deleted ${platform} thread ${threadId}:`,
                err
            );
        }
        if (!parentChannelId) return;
        this.scheduleRefresh(platform, parentChannelId);
    }

    private adapter(
        platform: ThreadDirectoryPlatform
    ): ThreadDirectoryPlatformAdapter {
        const adapter = this.adapters.get(platform);
        if (!adapter) {
            throw new ThreadDirectoryError(
                'unavailable',
                `Threads directories are not available on ${platform}.`
            );
        }
        return adapter;
    }

    private async requireDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectory> {
        const directory = await this.repo.findDirectory(platform, channelId);
        if (!directory) {
            throw new ThreadDirectoryError(
                'no_directory',
                'This channel has no threads directory yet.'
            );
        }
        return directory;
    }

    private async renderFor(
        adapter: ThreadDirectoryPlatformAdapter,
        guildId: string,
        channelId: string,
        title: string
    ): Promise<DirectoryRender> {
        const [threads, entries] = await Promise.all([
            adapter.listThreads(guildId, channelId),
            this.repo.listEntries(adapter.platform, channelId),
        ]);
        return renderDirectory(title, threads, entries);
    }

    /** Edits `directory`'s message; must run inside the channel's queue. */
    private async refreshDirectory(
        adapter: ThreadDirectoryPlatformAdapter,
        directory: ThreadDirectory
    ): Promise<ThreadDirectory> {
        const render = await this.renderFor(
            adapter,
            directory.guildId,
            directory.channelId,
            directory.title
        );
        const edited = await adapter.editDirectory(
            directory.channelId,
            directory.messageId,
            render
        );
        if (!edited) {
            throw new ThreadDirectoryError(
                'message_missing',
                'The threads directory message was deleted; post it again.'
            );
        }
        return directory;
    }

    private async updateEntry(
        adapter: ThreadDirectoryPlatformAdapter,
        guildId: string,
        channelId: string,
        threadId: string,
        change: { description?: string | null; hidden?: boolean }
    ): Promise<void> {
        const platform = adapter.platform;
        const threads = await adapter.listThreads(guildId, channelId);
        if (!threads.some((thread) => thread.id === threadId)) {
            throw new ThreadDirectoryError(
                'unknown_thread',
                'That is not a thread of this channel.'
            );
        }

        await this.exclusive(platform, channelId, async () => {
            await this.repo.saveEntry({
                platform,
                channelId,
                threadId,
                ...change,
            });
            const directory = await this.repo.findDirectory(
                platform,
                channelId
            );
            if (directory) await this.refreshDirectory(adapter, directory);
        });
    }

    /** Runs `task` after every earlier operation on the same channel has settled. */
    private exclusive<T>(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const key = `${platform}:${channelId}`;
        const previous = this.queues.get(key) ?? Promise.resolve();
        const run = previous.then(task, task);
        const tail = run.then(
            () => undefined,
            () => undefined
        );
        this.queues.set(key, tail);
        void tail.then(() => {
            if (this.queues.get(key) === tail) this.queues.delete(key);
        });
        return run;
    }

    private scheduleRefresh(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): void {
        try {
            const key = `${platform}:${channelId}`;
            const pending = this.timers.get(key);
            if (pending) clearTimeout(pending);

            const timer = setTimeout(() => {
                this.timers.delete(key);
                void this.autoRefresh(platform, channelId);
            }, this.refreshDebounceMs);
            (timer as { unref?: () => void }).unref?.();
            this.timers.set(key, timer);
        } catch (err) {
            logger.error(
                `❌ Could not schedule a threads directory refresh for ${platform} channel ${channelId}:`,
                err
            );
        }
    }

    private async autoRefresh(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<void> {
        try {
            const adapter = this.adapters.get(platform);
            if (!adapter) return;
            await this.exclusive(platform, channelId, async () => {
                const directory = await this.repo.findDirectory(
                    platform,
                    channelId
                );
                if (directory) await this.refreshDirectory(adapter, directory);
            });
        } catch (err) {
            if (
                err instanceof ThreadDirectoryError &&
                err.reason === 'message_missing'
            ) {
                logger.warn(
                    `⚠️ Threads directory of ${platform} channel ${channelId} was deleted; it will update again once re-posted.`
                );
            } else {
                logger.error(
                    `❌ Could not refresh the threads directory of ${platform} channel ${channelId}:`,
                    err
                );
            }
        }
    }
}

function validateTitle(title: string): string {
    const trimmed = collapseNewlines(title);
    if (trimmed.length > DIRECTORY_TITLE_MAX) {
        throw new ThreadDirectoryError(
            'too_long',
            `Titles can be at most ${DIRECTORY_TITLE_MAX} characters.`
        );
    }
    return trimmed;
}
