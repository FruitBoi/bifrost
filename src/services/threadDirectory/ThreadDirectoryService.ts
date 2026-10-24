import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../../db/entities/ThreadDirectory';
import { ThreadDirectoryRepository } from '../../db/repositories/ThreadDirectoryRepository';
import { parseChannelRef, parseRoleRef } from '../../utils/channelRef';
import {
    chunkDescriptionLines,
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
} from '../../utils/embeds';
import logger from '../../utils/logging/logger';
import { DirectoryImportItem } from './directoryImport';

/** Default heading of a directory. */
export const DEFAULT_DIRECTORY_TITLE = 'Threads Directory';
/** Longest accepted directory title (embed title limit). */
export const DIRECTORY_TITLE_MAX = 256;
/** Longest accepted thread description. */
export const DIRECTORY_DESCRIPTION_MAX = 300;
/** Most messages one directory spans; beyond that it ends with `…and N more`. */
export const DIRECTORY_MESSAGES_MAX = 10;

/** A thread of the directory's channel, as listed by the platform. */
export interface DirectoryThread {
    id: string;
    name: string;
}

/** Any channel or thread of a guild, as resolved by the platform. */
export interface DirectoryChannel {
    id: string;
    name: string;
    /** Parent channel (of a thread) or category; null for none. */
    parentId: string | null;
}

/** A guild role, as listed by the platform. */
export interface DirectoryRole {
    id: string;
    name: string;
    /** Managed by an integration (bots, boosts); cannot be self-assigned. */
    managed: boolean;
    /** Permission bitfield (Discord-compatible bits). */
    permissions: bigint | string;
}

/** The rendered directory, built by the service and sent by an adapter. */
export interface DirectoryRender {
    title: string;
    /**
     * One entry per message, in order: that message's embed descriptions.
     * Each description fits one embed and each message fits the per-message
     * limits (the title counting towards the first).
     */
    pages: string[][];
}

/** One directory message as an adapter sends or edits it. */
export interface DirectoryPage {
    /** Heading on the first embed; only set on the first message. */
    title?: string;
    /** Embed descriptions, in order. */
    descriptions: string[];
    /** Timestamp on the last embed; only set on the last message. */
    timestamp: boolean;
}

/**
 * Platform side of the threads directory: lists threads, resolves channels
 * and roles, manages member roles and posts, edits and deletes the directory
 * messages. One adapter per platform.
 */
export interface ThreadDirectoryPlatformAdapter {
    readonly platform: ThreadDirectoryPlatform;
    /**
     * Every public thread of `channelId` (active and archived). Throws
     * ThreadDirectoryError('unsupported_channel') when the channel cannot
     * hold a directory (not a text channel, or a thread itself).
     */
    listThreads(guildId: string, channelId: string): Promise<DirectoryThread[]>;
    /** Posts one directory message in `channelId`; returns its ID. */
    sendDirectoryMessage(
        channelId: string,
        page: DirectoryPage
    ): Promise<string>;
    /** Edits one directory message; false when the message no longer exists. */
    editDirectoryMessage(
        channelId: string,
        messageId: string,
        page: DirectoryPage
    ): Promise<boolean>;
    /** Deletes one directory message; a message that is already gone is fine. */
    deleteDirectoryMessage(channelId: string, messageId: string): Promise<void>;
    /** Link to a message, for command replies. */
    messageUrl(guildId: string, channelId: string, messageId: string): string;
    /** Any channel or thread `id` of `guildId`; null when not found there. */
    resolveChannel(
        guildId: string,
        id: string
    ): Promise<DirectoryChannel | null>;
    /** Every role of the guild. */
    listRoles(guildId: string): Promise<DirectoryRole[]>;
    /** Role IDs the member has. */
    memberRoleIds(guildId: string, userId: string): Promise<string[]>;
    /** Gives a role; throws ThreadDirectoryError('role_forbidden') when the bot may not. */
    addMemberRole(
        guildId: string,
        userId: string,
        roleId: string
    ): Promise<void>;
    /** Removes a role; throws ThreadDirectoryError('role_forbidden') when the bot may not. */
    removeMemberRole(
        guildId: string,
        userId: string,
        roleId: string
    ): Promise<void>;
    /** Content plus embed titles/descriptions of a message, newline-joined; null when it cannot be fetched. */
    fetchMessageText(
        channelId: string,
        messageId: string
    ): Promise<string | null>;
}

export type ThreadDirectoryErrorReason =
    /** The channel has no directory yet. */
    | 'no_directory'
    /** The directory message was deleted; post it again. */
    | 'message_missing'
    /** Not a thread of the directory's channel, nor an added entry. */
    | 'unknown_thread'
    /** The channel cannot hold a directory. */
    | 'unsupported_channel'
    /** Title or description too long. */
    | 'too_long'
    /** No adapter registered for the platform. */
    | 'unavailable'
    /** The `add` target is not a channel or thread of this guild. */
    | 'unknown_channel'
    /** The role was not found in the guild. */
    | 'unknown_role'
    /** The role is @everyone, managed, or grants moderator/admin permissions. */
    | 'unsafe_role'
    /** The lfg target is not a role linked to a directory entry of the guild. */
    | 'not_lfg_role'
    /** The bot cannot add or remove that role. */
    | 'role_forbidden'
    /** The import source message could not be fetched. */
    | 'message_not_found';

export class ThreadDirectoryError extends Error {
    constructor(
        public readonly reason: ThreadDirectoryErrorReason,
        message: string
    ) {
        super(message);
        this.name = 'ThreadDirectoryError';
    }
}

/** One listed entry as shown by `getStatus` (native threads and added channels/threads). */
export interface DirectoryStatusThread extends DirectoryThread {
    description: string | null;
    hidden: boolean;
    roleId: string | null;
    /** True for entries added with `directory add` (outside the directory channel). */
    added: boolean;
}

export interface DirectoryStatus {
    /** Null when the channel has no directory posted. */
    directory: ThreadDirectory | null;
    /** Every listed entry, in directory order, hidden ones included. */
    threads: DirectoryStatusThread[];
}

export interface DirectoryImportResult {
    /** Entries (native threads, or already added ones) whose description/role were set. */
    updated: string[];
    /** Channels/threads outside the directory channel that were added. */
    added: string[];
    /** Lines that could not be matched: the item's name, else its ID, else '?'. */
    skipped: string[];
}

/** A role linked to a directory entry, which members may give themselves. */
export interface LfgRole {
    roleId: string;
    roleName: string;
    /** Directory channel and listed thread/channel the role is linked to. */
    channelId: string;
    threadId: string;
    description: string | null;
}

/** Line shown when the directory lists no thread. */
export const EMPTY_DIRECTORY_LINE = '*No threads yet.*';
/** Default delay before a thread event refreshes the directory. */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 5000;

/** Longest embed description `chunkDescriptionLines` produces by default. */
const EMBED_DESCRIPTION_MAX = 4092;

/**
 * Permissions a self-assignable role must not grant (same bits on Discord
 * and Fluxer): Kick/Ban Members, Administrator, Manage Channels/Guild,
 * Manage Messages, Manage Roles, Moderate Members.
 */
const UNSAFE_ROLE_PERMISSIONS = [1, 2, 3, 4, 5, 13, 28, 40].reduce(
    (bits, bit) => bits | (BigInt(1) << BigInt(bit)),
    BigInt(0)
);

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

/**
 * One directory line: `description: <#thread> - <@&role>`, leaving out the
 * description and the role part when absent.
 */
export function directoryLine(
    threadId: string,
    description: string | null,
    roleId: string | null = null
): string {
    const text = description ? collapseNewlines(description) : '';
    const thread = text ? `${text}: <#${threadId}>` : `<#${threadId}>`;
    return roleId ? `${thread} - <@&${roleId}>` : thread;
}

/** True when the role must not be linked or self-assigned. */
export function isUnsafeRole(role: DirectoryRole, guildId: string): boolean {
    if (role.id === guildId || role.managed) return true;
    let permissions: bigint;
    try {
        permissions = BigInt(role.permissions);
    } catch {
        return true;
    }
    return (permissions & UNSAFE_ROLE_PERMISSIONS) !== BigInt(0);
}

type RenderEntry = Pick<
    ThreadDirectoryEntry,
    'threadId' | 'description' | 'hidden' | 'roleId' | 'added'
>;

/** IDs of every listed entry: native threads plus added entries, deduped. */
function listedIds(
    threads: readonly DirectoryThread[],
    entries: readonly RenderEntry[]
): Set<string> {
    return new Set([
        ...threads.map((thread) => thread.id),
        ...entries.filter((e) => e.added).map((e) => e.threadId),
    ]);
}

/**
 * Packs `lines` into messages, splitting only between lines: each message
 * holds at most EMBED_TOTAL_CHARS_MAX characters (the first also carries
 * `title`) in embeds of at most EMBED_DESCRIPTION_MAX characters each.
 */
function paginateLines(title: string, lines: string[]): string[][] {
    const groups: string[][] = [];
    let current: string[] = [];
    let chars = title.length;
    for (const line of lines) {
        const cost = current.length === 0 ? line.length : line.length + 1;
        if (current.length > 0 && chars + cost > EMBED_TOTAL_CHARS_MAX) {
            groups.push(current);
            current = [line];
            chars = line.length;
        } else {
            current.push(line);
            chars += cost;
        }
    }
    if (current.length > 0) groups.push(current);

    // Splitting a message's lines into embeds only drops separators, so each
    // message stays within the total; ≤6000 chars never needs 10 embeds.
    return groups.map((group) =>
        chunkDescriptionLines(group, '\n', EMBED_DESCRIPTION_MAX)
            .map((chunk) => chunk.join('\n'))
            .slice(0, EMBEDS_PER_MESSAGE_MAX)
    );
}

/**
 * Renders a directory: visible threads of the channel and added entries,
 * oldest first, one line each, split cleanly over as many messages as
 * needed. Past DIRECTORY_MESSAGES_MAX messages, trailing lines are dropped
 * and replaced by `…and N more`.
 */
export function renderDirectory(
    title: string,
    threads: readonly DirectoryThread[],
    entries: readonly RenderEntry[]
): DirectoryRender {
    const byThread = new Map(entries.map((e) => [e.threadId, e]));
    const lines = sortDirectoryThreads(
        [...listedIds(threads, entries)].map((id) => ({ id }))
    )
        .filter((thread) => !byThread.get(thread.id)?.hidden)
        .map((thread) => {
            const entry = byThread.get(thread.id);
            return directoryLine(
                thread.id,
                entry?.description ?? null,
                entry?.roleId ?? null
            );
        });

    if (lines.length === 0) return { title, pages: [[EMPTY_DIRECTORY_LINE]] };

    const all = paginateLines(title, lines);
    if (all.length <= DIRECTORY_MESSAGES_MAX) return { title, pages: all };

    const attempt = (kept: number) => {
        const pages = paginateLines(title, [
            ...lines.slice(0, kept),
            `…and ${lines.length - kept} more`,
        ]);
        return pages.length <= DIRECTORY_MESSAGES_MAX ? pages : null;
    };

    // Fitting k lines implies fitting fewer, so binary search the most that fit.
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (attempt(mid)) low = mid;
        else high = mid - 1;
    }
    return {
        title,
        pages: attempt(low) ?? [[`…and ${lines.length} more`]],
    };
}

/** The messages of a render: title on the first, timestamp on the last. */
export function directoryPages(render: DirectoryRender): DirectoryPage[] {
    return render.pages.map((descriptions, i) => ({
        ...(i === 0 ? { title: render.title } : {}),
        descriptions,
        timestamp: i === render.pages.length - 1,
    }));
}

/** Lower-cased name for loose matching, without a leading `@` or `#`. */
function normalizeName(name: string): string {
    return name.trim().replace(/^[@#]/, '').trim().toLowerCase();
}

export interface ThreadDirectoryServiceOptions {
    /** Delay before a thread event refreshes the directory (ms). */
    refreshDebounceMs?: number;
}

/**
 * Threads directories (issue #37): bot messages listing a channel's threads
 * (plus channels/threads added from elsewhere) with optional descriptions
 * and linked roles, edited in place whenever the list or an entry changes,
 * and refreshed automatically (debounced) when a thread of the channel is
 * created or deleted. Long directories span several messages. Roles linked
 * to entries can be self-assigned with `lfg`.
 *
 * Operations on one (platform, channel) run one at a time, so a debounced
 * refresh and a command never race to edit or post the same messages.
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
     * directory messages of that channel. `title` defaults to the previous
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
            const messageIds = await this.sendPages(
                adapter,
                channelId,
                directoryPages(render)
            );
            if (previous) {
                await this.deleteMessages(
                    adapter,
                    previous.channelId,
                    previous.messageIds.filter((id) => !messageIds.includes(id))
                );
            }

            return this.repo.saveDirectory({
                platform,
                guildId,
                channelId,
                messageIds,
                title: finalTitle,
            });
        });
    }

    /** Re-renders and edits the existing directory messages. */
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
     * must be a thread of `channelId` or an added entry, then refreshes the
     * directory if one is posted.
     */
    async setDescription(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        threadId: string,
        description: string | null
    ): Promise<void> {
        const adapter = this.adapter(platform);
        const trimmed = validateDescription(description);
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

    /**
     * Links a role (ID, mention or case-insensitive exact name) to a listed
     * entry, or clears it with null/blank. Returns the role, or null when
     * cleared.
     */
    async setRole(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        threadId: string,
        role: string | null
    ): Promise<{ id: string; name: string } | null> {
        const adapter = this.adapter(platform);
        if (!role?.trim()) {
            await this.updateEntry(adapter, guildId, channelId, threadId, {
                roleId: null,
            });
            return null;
        }

        const roles = await adapter.listRoles(guildId);
        const id = parseRoleRef(role) ?? role.trim();
        const wanted = normalizeName(role);
        const found =
            roles.find((r) => r.id === id) ??
            roles.find((r) => normalizeName(r.name) === wanted);
        if (!found) {
            throw new ThreadDirectoryError(
                'unknown_role',
                'That role does not exist in this server.'
            );
        }
        if (isUnsafeRole(found, guildId)) {
            throw new ThreadDirectoryError(
                'unsafe_role',
                'That role cannot be self-assigned: it is @everyone, managed by an integration, or grants moderator permissions.'
            );
        }

        await this.updateEntry(adapter, guildId, channelId, threadId, {
            roleId: found.id,
        });
        return { id: found.id, name: found.name };
    }

    /**
     * Lists `targetId` (a channel or thread of `guildId` outside the
     * directory channel) in the directory of `channelId`, then refreshes it
     * if posted. `alreadyListed` when it is a native thread of `channelId`
     * or was already added; the description is still set when given.
     */
    async addEntry(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        targetId: string,
        description: string | null
    ): Promise<{ alreadyListed: boolean }> {
        const adapter = this.adapter(platform);
        const trimmed = validateDescription(description);
        if (targetId === channelId) {
            throw new ThreadDirectoryError(
                'unknown_channel',
                'A directory cannot list its own channel.'
            );
        }

        const [threads, entries] = await Promise.all([
            adapter.listThreads(guildId, channelId),
            this.repo.listEntries(platform, channelId),
        ]);
        const native = threads.some((thread) => thread.id === targetId);
        const alreadyAdded = entries.some(
            (e) => e.threadId === targetId && e.added
        );
        if (!native && !alreadyAdded) {
            const target = await adapter.resolveChannel(guildId, targetId);
            if (!target) {
                throw new ThreadDirectoryError(
                    'unknown_channel',
                    'That is not a channel or thread of this server.'
                );
            }
        }

        await this.exclusive(platform, channelId, async () => {
            await this.repo.saveEntry({
                platform,
                guildId,
                channelId,
                threadId: targetId,
                ...(trimmed ? { description: trimmed } : {}),
                ...(native ? {} : { added: true }),
            });
            await this.refreshIfPosted(adapter, channelId);
        });
        return { alreadyListed: native || alreadyAdded };
    }

    /** Removes an added entry; false when `targetId` is not an added entry of `channelId`. */
    async unlistEntry(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        targetId: string
    ): Promise<boolean> {
        const adapter = this.adapter(platform);
        return this.exclusive(platform, channelId, async () => {
            const entries = await this.repo.listEntries(platform, channelId);
            if (!entries.some((e) => e.threadId === targetId && e.added)) {
                return false;
            }
            await this.repo.deleteEntry(platform, channelId, targetId);
            await this.refreshIfPosted(adapter, channelId);
            return true;
        });
    }

    /**
     * Applies parsed import lines. Each line matches by its channel ID (a
     * native thread or added entry is updated; another channel/thread of the
     * guild is added), else by name among the channel's threads
     * (case-insensitive). Sets the description (when non-null) and role
     * (when non-null, found in the guild and safe), then refreshes the
     * directory once.
     */
    async importEntries(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        items: DirectoryImportItem[]
    ): Promise<DirectoryImportResult> {
        const adapter = this.adapter(platform);
        const [threads, entries, roles] = await Promise.all([
            adapter.listThreads(guildId, channelId),
            this.repo.listEntries(platform, channelId),
            items.some((item) => item.roleId)
                ? adapter.listRoles(guildId)
                : Promise.resolve([]),
        ]);
        const nativeIds = new Set(threads.map((thread) => thread.id));
        const addedIds = new Set(
            entries.filter((e) => e.added).map((e) => e.threadId)
        );
        const safeRoleIds = new Set(
            roles.filter((r) => !isUnsafeRole(r, guildId)).map((r) => r.id)
        );

        const changes = new Map<
            string,
            { add: boolean; description?: string; roleId?: string }
        >();
        const skipped: string[] = [];
        for (const item of items) {
            const target = await this.matchImportItem(
                adapter,
                guildId,
                channelId,
                threads,
                nativeIds,
                addedIds,
                item
            );
            if (!target) {
                skipped.push(item.name ?? item.channelId ?? '?');
                continue;
            }
            const change = changes.get(target.id) ?? { add: target.add };
            const description = item.description
                ? collapseNewlines(item.description)
                : '';
            if (description) {
                change.description =
                    description.length > DIRECTORY_DESCRIPTION_MAX
                        ? `${description.slice(0, DIRECTORY_DESCRIPTION_MAX - 1)}…`
                        : description;
            }
            if (item.roleId && safeRoleIds.has(item.roleId)) {
                change.roleId = item.roleId;
            }
            changes.set(target.id, change);
        }

        await this.exclusive(platform, channelId, async () => {
            for (const [threadId, change] of changes) {
                await this.repo.saveEntry({
                    platform,
                    guildId,
                    channelId,
                    threadId,
                    ...(change.add ? { added: true } : {}),
                    ...(change.description !== undefined
                        ? { description: change.description }
                        : {}),
                    ...(change.roleId !== undefined
                        ? { roleId: change.roleId }
                        : {}),
                });
            }
            if (changes.size > 0)
                await this.refreshIfPosted(adapter, channelId);
        });

        const result: DirectoryImportResult = {
            updated: [],
            added: [],
            skipped,
        };
        for (const [threadId, change] of changes) {
            (change.add ? result.added : result.updated).push(threadId);
        }
        return result;
    }

    /**
     * Text of a message (content plus embed titles/descriptions) in a channel
     * of `guildId`; throws 'message_not_found' when it cannot be fetched or
     * the channel belongs to another server.
     */
    async fetchMessageText(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        channelId: string,
        messageId: string
    ): Promise<string> {
        const adapter = this.adapter(platform);
        const channel = await adapter.resolveChannel(guildId, channelId);
        const text = channel
            ? await adapter.fetchMessageText(channelId, messageId)
            : null;
        if (text === null) {
            throw new ThreadDirectoryError(
                'message_not_found',
                'I could not fetch that message.'
            );
        }
        return text;
    }

    /**
     * Every role linked to an entry of any directory of the guild that
     * still exists and is safe, deduped by role, sorted by name.
     */
    async listLfgRoles(
        platform: ThreadDirectoryPlatform,
        guildId: string
    ): Promise<LfgRole[]> {
        const adapter = this.adapter(platform);
        const [entries, roles] = await Promise.all([
            this.repo.listRoleEntries(platform, guildId),
            adapter.listRoles(guildId),
        ]);
        const byId = new Map(roles.map((role) => [role.id, role]));
        const lfg = new Map<string, LfgRole>();
        for (const entry of entries) {
            const role = entry.roleId ? byId.get(entry.roleId) : undefined;
            if (!role || lfg.has(role.id) || isUnsafeRole(role, guildId)) {
                continue;
            }
            lfg.set(role.id, {
                roleId: role.id,
                roleName: role.name,
                channelId: entry.channelId,
                threadId: entry.threadId,
                description: entry.description,
            });
        }
        return [...lfg.values()].sort((a, b) =>
            a.roleName.localeCompare(b.roleName, undefined, {
                sensitivity: 'base',
            })
        );
    }

    /** Roles of `listLfgRoles` the member currently has. */
    async memberLfgRoleIds(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        userId: string
    ): Promise<string[]> {
        const adapter = this.adapter(platform);
        const [lfg, memberRoles] = await Promise.all([
            this.listLfgRoles(platform, guildId),
            adapter.memberRoleIds(guildId, userId),
        ]);
        const has = new Set(memberRoles);
        return lfg.filter((r) => has.has(r.roleId)).map((r) => r.roleId);
    }

    /**
     * Toggles an LFG role on the member. `target` is a role ID or mention, a
     * channel/thread ID, mention or link (the role linked to that entry), or
     * a role name, entry name or entry description (case-insensitive).
     */
    async toggleLfgRole(
        platform: ThreadDirectoryPlatform,
        guildId: string,
        userId: string,
        target: string
    ): Promise<{ role: { id: string; name: string }; added: boolean }> {
        const adapter = this.adapter(platform);
        const lfg = await this.listLfgRoles(platform, guildId);
        const match = await this.matchLfgRole(adapter, guildId, lfg, target);
        if (!match) {
            throw new ThreadDirectoryError(
                'not_lfg_role',
                'That is not a role linked to a directory thread.'
            );
        }

        const role = { id: match.roleId, name: match.roleName };
        const memberRoles = await adapter.memberRoleIds(guildId, userId);
        if (memberRoles.includes(match.roleId)) {
            await adapter.removeMemberRole(guildId, userId, match.roleId);
            return { role, added: false };
        }
        await adapter.addMemberRole(guildId, userId, match.roleId);
        return { role, added: true };
    }

    /** The directory of `channelId` and its listed entries with their settings. */
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
        const nativeIds = new Set(threads.map((thread) => thread.id));
        const added = await Promise.all(
            entries
                .filter((e) => e.added && !nativeIds.has(e.threadId))
                .map(async (e) => ({
                    id: e.threadId,
                    name:
                        (
                            await adapter
                                .resolveChannel(guildId, e.threadId)
                                .catch(() => null)
                        )?.name ?? e.threadId,
                }))
        );

        return {
            directory,
            threads: sortDirectoryThreads([...threads, ...added]).map(
                (thread) => {
                    const entry = byThread.get(thread.id);
                    return {
                        id: thread.id,
                        name: thread.name,
                        description: entry?.description ?? null,
                        hidden: entry?.hidden ?? false,
                        roleId: entry?.roleId ?? null,
                        added: !nativeIds.has(thread.id),
                    };
                }
            ),
        };
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
                messageIds: directory.messageIds,
                title: finalTitle,
            });
            return this.refreshDirectory(adapter, saved);
        });
    }

    /** Deletes the directory messages and stops tracking them; entries are kept. False when there was none. */
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

            await this.deleteMessages(
                adapter,
                directory.channelId,
                directory.messageIds
            );
            return this.repo.deleteDirectory(platform, channelId);
        });
    }

    /** Link to the first directory message. */
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
     * A thread was deleted: forget its entries in every directory and
     * refresh the parent's directory and every directory that listed it,
     * after a short debounce. Never throws.
     */
    handleThreadDeleted(
        platform: ThreadDirectoryPlatform,
        parentChannelId: string | null | undefined,
        threadId: string
    ): void {
        const failed = (err: unknown) =>
            logger.error(
                `❌ Could not forget the threads directory entries of deleted ${platform} thread ${threadId}:`,
                err
            );
        try {
            this.repo
                .deleteEntriesForThread(platform, threadId)
                .then((channelIds) => {
                    for (const channelId of channelIds) {
                        if (channelId !== parentChannelId) {
                            this.scheduleRefresh(platform, channelId);
                        }
                    }
                })
                .catch(failed);
        } catch (err) {
            failed(err);
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

    /** Sends `pages` in order; on failure deletes the ones already sent. */
    private async sendPages(
        adapter: ThreadDirectoryPlatformAdapter,
        channelId: string,
        pages: DirectoryPage[]
    ): Promise<string[]> {
        const messageIds: string[] = [];
        try {
            for (const page of pages) {
                messageIds.push(
                    await adapter.sendDirectoryMessage(channelId, page)
                );
            }
        } catch (err) {
            await this.deleteMessages(adapter, channelId, messageIds);
            throw err;
        }
        return messageIds;
    }

    /** Deletes directory messages, logging (not throwing) failures. */
    private async deleteMessages(
        adapter: ThreadDirectoryPlatformAdapter,
        channelId: string,
        messageIds: string[]
    ): Promise<void> {
        for (const messageId of messageIds) {
            await adapter
                .deleteDirectoryMessage(channelId, messageId)
                .catch((err) =>
                    logger.warn(
                        `⚠️ Could not delete threads directory message ${messageId} in ${adapter.platform} channel ${channelId}:`,
                        err
                    )
                );
        }
    }

    /**
     * Brings `directory`'s messages up to date; must run inside the
     * channel's queue. Edits in place when the existing messages suffice
     * (deleting surplus trailing ones); re-posts the whole directory when it
     * needs more messages or a later one is gone, so the messages stay
     * contiguous. A missing first message means the directory was deleted.
     */
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
        const pages = directoryPages(render);
        const existing = directory.messageIds;

        const firstEdited = await adapter.editDirectoryMessage(
            directory.channelId,
            existing[0],
            pages[0]
        );
        if (!firstEdited) {
            throw new ThreadDirectoryError(
                'message_missing',
                'The threads directory message was deleted; post it again.'
            );
        }

        let inPlace = pages.length <= existing.length;
        for (let i = 1; inPlace && i < pages.length; i++) {
            inPlace = await adapter.editDirectoryMessage(
                directory.channelId,
                existing[i],
                pages[i]
            );
        }

        if (inPlace) {
            const surplus = existing.slice(pages.length);
            if (surplus.length === 0) return directory;
            await this.deleteMessages(adapter, directory.channelId, surplus);
            return this.saveMessages(
                directory,
                existing.slice(0, pages.length)
            );
        }

        const messageIds = await this.sendPages(
            adapter,
            directory.channelId,
            pages
        );
        await this.deleteMessages(adapter, directory.channelId, existing);
        return this.saveMessages(directory, messageIds);
    }

    private saveMessages(
        directory: ThreadDirectory,
        messageIds: string[]
    ): Promise<ThreadDirectory> {
        return this.repo.saveDirectory({
            platform: directory.platform,
            guildId: directory.guildId,
            channelId: directory.channelId,
            messageIds,
            title: directory.title,
        });
    }

    /** Refreshes the directory of `channelId` if one is posted; must run inside its queue. */
    private async refreshIfPosted(
        adapter: ThreadDirectoryPlatformAdapter,
        channelId: string
    ): Promise<void> {
        const directory = await this.repo.findDirectory(
            adapter.platform,
            channelId
        );
        if (directory) await this.refreshDirectory(adapter, directory);
    }

    private async updateEntry(
        adapter: ThreadDirectoryPlatformAdapter,
        guildId: string,
        channelId: string,
        threadId: string,
        change: {
            description?: string | null;
            hidden?: boolean;
            roleId?: string | null;
        }
    ): Promise<void> {
        const platform = adapter.platform;
        const [threads, entries] = await Promise.all([
            adapter.listThreads(guildId, channelId),
            this.repo.listEntries(platform, channelId),
        ]);
        if (!listedIds(threads, entries).has(threadId)) {
            throw new ThreadDirectoryError(
                'unknown_thread',
                'That is not a thread of this channel nor an added entry.'
            );
        }

        await this.exclusive(platform, channelId, async () => {
            await this.repo.saveEntry({
                platform,
                guildId,
                channelId,
                threadId,
                ...change,
            });
            await this.refreshIfPosted(adapter, channelId);
        });
    }

    /** The entry an import line refers to, and whether it must be added; null when unmatched. */
    private async matchImportItem(
        adapter: ThreadDirectoryPlatformAdapter,
        guildId: string,
        channelId: string,
        threads: readonly DirectoryThread[],
        nativeIds: ReadonlySet<string>,
        addedIds: ReadonlySet<string>,
        item: DirectoryImportItem
    ): Promise<{ id: string; add: boolean } | null> {
        const id = item.channelId;
        if (id && id !== channelId) {
            if (nativeIds.has(id) || addedIds.has(id))
                return { id, add: false };
            const resolved = await adapter
                .resolveChannel(guildId, id)
                .catch(() => null);
            if (resolved) return { id, add: true };
        }
        // Unknown or foreign ID (e.g. a directory copied from elsewhere): try the name.
        if (!item.name) return null;
        const wanted = normalizeName(item.name);
        const byName = threads.find(
            (thread) => normalizeName(thread.name) === wanted
        );
        return byName ? { id: byName.id, add: false } : null;
    }

    /** The LFG role `target` designates, or null. */
    private async matchLfgRole(
        adapter: ThreadDirectoryPlatformAdapter,
        guildId: string,
        lfg: LfgRole[],
        target: string
    ): Promise<LfgRole | null> {
        if (lfg.length === 0 || !target.trim()) return null;

        const roleId = parseRoleRef(target) ?? target.trim();
        const byRoleId = lfg.find((r) => r.roleId === roleId);
        if (byRoleId) return byRoleId;
        const entryId = parseChannelRef(target) ?? target.trim();
        const byEntryId = lfg.find((r) => r.threadId === entryId);
        if (byEntryId) return byEntryId;

        const wanted = normalizeName(target);
        const byName =
            lfg.find((r) => normalizeName(r.roleName) === wanted) ??
            lfg.find(
                (r) =>
                    r.description !== null &&
                    normalizeName(r.description) === wanted
            );
        if (byName) return byName;

        for (const role of lfg) {
            const entry = await adapter
                .resolveChannel(guildId, role.threadId)
                .catch(() => null);
            if (entry && normalizeName(entry.name) === wanted) return role;
        }
        return null;
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
            await this.exclusive(platform, channelId, () =>
                this.refreshIfPosted(adapter, channelId)
            );
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

/** The trimmed description, null when blank; 'too_long' past the limit. */
function validateDescription(description: string | null): string | null {
    const trimmed = description?.trim() || null;
    if (trimmed && trimmed.length > DIRECTORY_DESCRIPTION_MAX) {
        throw new ThreadDirectoryError(
            'too_long',
            `Descriptions can be at most ${DIRECTORY_DESCRIPTION_MAX} characters.`
        );
    }
    return trimmed;
}
