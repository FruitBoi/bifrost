/**
 * Deleting the messages the `clean` command selected. Both platforms'
 * bulk-delete routes take at most {@link CLEAN_DELETE_BATCH_SIZE} IDs, so a
 * larger clean (up to `MAX_CLEAN_COUNT`) is split into batches, newest
 * first. A batch that fails with a rate limit is retried after the wait the
 * platform asks for (`@fluxerjs/rest` does not retry POSTs itself;
 * discord.js does, so on Discord this never triggers).
 */

import { rateLimitWaitMs } from '../history/HistoryTransferService';

/** Most IDs one bulk-delete request takes on Discord and on Fluxer. */
export const CLEAN_DELETE_BATCH_SIZE = 100;
/** How often one batch is retried after a rate limit before giving up. */
export const MAX_CLEAN_DELETE_RETRIES = 5;

export interface CleanDeleteResult {
    /** Messages deleted, as reported by `deleteBatch`. */
    deleted: number;
    /** Why deleting stopped early, or null when every batch went through. */
    error: unknown;
}

export interface DeleteInBatchesOptions {
    /** Waits between rate-limit retries; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Splits `ids` into batches of {@link CLEAN_DELETE_BATCH_SIZE} and deletes
 * them one after another with `deleteBatch`, which returns how many
 * messages it deleted. Stops at the first batch that fails with anything but
 * a rate limit (or keeps being rate-limited), reporting how many messages
 * were deleted before it.
 */
export async function deleteInBatches(
    ids: readonly string[],
    deleteBatch: (batch: string[]) => Promise<number>,
    { sleep = defaultSleep }: DeleteInBatchesOptions = {}
): Promise<CleanDeleteResult> {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += CLEAN_DELETE_BATCH_SIZE) {
        const batch = ids.slice(i, i + CLEAN_DELETE_BATCH_SIZE);
        for (let attempt = 0; ; attempt++) {
            try {
                deleted += await deleteBatch(batch);
                break;
            } catch (err) {
                const wait = rateLimitWaitMs(err);
                if (wait === null || attempt >= MAX_CLEAN_DELETE_RETRIES) {
                    return { deleted, error: err };
                }
                await sleep(wait);
            }
        }
    }
    return { deleted, error: null };
}

/** Error text for a clean that stopped partway, or failed outright. */
export function cleanDeleteFailureMessage(result: CleanDeleteResult): string {
    const reason =
        result.error instanceof Error
            ? result.error.message
            : String(result.error);
    return result.deleted > 0
        ? `Deleted ${result.deleted} message(s), then failed to delete the rest: ${reason}`
        : `Failed to delete messages: ${reason}`;
}
