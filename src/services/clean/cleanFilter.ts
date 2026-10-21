/**
 * Platform-independent half of the `clean` command (issue #12): which of the
 * channel's recent messages an invocation deletes. The handlers adapt their
 * platform's messages to {@link CleanCandidate}, page through the channel
 * history via a {@link CleanSource} and bulk-delete the IDs this module
 * selects. Mirrors YAGPDB's `AdvancedDeleteMessages`.
 */

import { CleanOptions } from './cleanArgs';

/** The parts of a message the filters look at. */
export interface CleanCandidate {
    id: string;
    authorId: string;
    authorIsBot: boolean;
    content: string;
    createdAt: Date;
    pinned: boolean;
    hasAttachments: boolean;
}

/**
 * Pages through a channel's history, newest first. `fetchBefore` returns up
 * to `limit` messages older than `beforeId` (never the message itself); an
 * empty page ends the search. Pages may be shorter than `limit` without
 * being the last one (Fluxer drops messages outside the caller's history
 * cutoff from a page).
 */
export interface CleanSource {
    fetchBefore(beforeId: string, limit: number): Promise<CleanCandidate[]>;
}

/** Most messages ever fetched for one invocation. */
export const MAX_CLEAN_FETCH = 1000;
/** With filters, `count * CLEAN_FETCH_MULTIPLIER` messages are searched (capped). */
export const CLEAN_FETCH_MULTIPLIER = 50;
/** Largest page the message-list routes allow on both platforms. */
export const CLEAN_PAGE_SIZE = 100;
/** Discord refuses to bulk-delete messages older than this. */
export const DISCORD_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Compares two snowflake IDs numerically: negative when `a` is older. */
export function compareSnowflakes(a: string, b: string): number {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether any filter beyond the count is active. */
export function hasCleanFilters(options: CleanOptions): boolean {
    return (
        options.userId !== null ||
        options.regex !== null ||
        options.maxAgeMs !== null ||
        options.minAgeMs !== null ||
        options.ignorePinned ||
        options.attachmentsOnly ||
        options.botsOnly ||
        options.fromId !== null ||
        options.toId !== null
    );
}

/**
 * How many messages to look through: exactly `count` without filters, with
 * filters 50 per wanted message, at most {@link MAX_CLEAN_FETCH}.
 */
export function cleanFetchLimit(options: CleanOptions): number {
    if (!hasCleanFilters(options)) return options.count;
    return Math.min(options.count * CLEAN_FETCH_MULTIPLIER, MAX_CLEAN_FETCH);
}

/** Whether `message` passes every filter in `options` (`count` aside). */
export function matchesCleanFilters(
    message: CleanCandidate,
    options: CleanOptions,
    now: number = Date.now()
): boolean {
    if (options.userId !== null && message.authorId !== options.userId) {
        return false;
    }
    if (options.regex !== null) {
        const matched = options.regex.test(message.content);
        if (options.invertRegex ? matched : !matched) return false;
    }
    const age = now - message.createdAt.getTime();
    if (options.maxAgeMs !== null && age > options.maxAgeMs) return false;
    if (options.minAgeMs !== null && age < options.minAgeMs) return false;
    if (options.ignorePinned && message.pinned) return false;
    if (options.attachmentsOnly && !message.hasAttachments) return false;
    if (options.botsOnly && !message.authorIsBot) return false;
    if (
        options.fromId !== null &&
        compareSnowflakes(message.id, options.fromId) > 0
    ) {
        return false;
    }
    if (
        options.toId !== null &&
        compareSnowflakes(message.id, options.toId) < 0
    ) {
        return false;
    }
    return true;
}

export interface CollectCleanOptions {
    /** Reference time for the age filters; defaults to the wall clock. */
    now?: number;
    /**
     * Messages older than this cannot be deleted on the platform (Discord's
     * two-week bulk-delete limit); they and everything older are skipped.
     * Null or undefined means no limit (Fluxer).
     */
    maxDeletableAgeMs?: number | null;
}

/**
 * Walks the channel history before `triggerMessageId` (the invoking message,
 * which is never selected) newest first and returns, newest first, the IDs
 * of the first `options.count` messages that pass the filters. Stops after
 * {@link cleanFetchLimit} messages have been looked at, at the end of the
 * history, or at the first message too old to delete.
 */
export async function collectMessagesToClean(
    source: CleanSource,
    options: CleanOptions,
    triggerMessageId: string,
    { now = Date.now(), maxDeletableAgeMs = null }: CollectCleanOptions = {}
): Promise<string[]> {
    const fetchLimit = cleanFetchLimit(options);
    const ids: string[] = [];
    let before = triggerMessageId;
    let fetched = 0;

    while (fetched < fetchLimit && ids.length < options.count) {
        const pageSize = Math.min(CLEAN_PAGE_SIZE, fetchLimit - fetched);
        const page = [...(await source.fetchBefore(before, pageSize))].sort(
            (a, b) => compareSnowflakes(b.id, a.id)
        );
        if (page.length === 0) break;
        fetched += page.length;

        for (const message of page) {
            if (
                maxDeletableAgeMs !== null &&
                now - message.createdAt.getTime() > maxDeletableAgeMs
            ) {
                // Everything after this one is older still.
                return ids;
            }
            if (!matchesCleanFilters(message, options, now)) continue;
            ids.push(message.id);
            if (ids.length >= options.count) break;
        }
        before = page[page.length - 1].id;
    }

    return ids;
}
