import { describe, expect, it, vi } from 'vitest';
import {
    CLEAN_DELETE_BATCH_SIZE,
    MAX_CLEAN_DELETE_RETRIES,
    cleanDeleteFailureMessage,
    deleteInBatches,
} from '../../../src/services/clean/cleanDelete';

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(n - i));
const rateLimit = (retryAfter = 1) =>
    Object.assign(new Error('Too Many Requests'), {
        name: 'RateLimitError',
        statusCode: 429,
        retryAfter,
    });

describe('deleteInBatches', () => {
    it('uses batches of 100', () => {
        expect(CLEAN_DELETE_BATCH_SIZE).toBe(100);
    });

    it('sends up to 100 IDs in one batch', async () => {
        const deleteBatch = vi.fn(async (batch: string[]) => batch.length);
        const all = ids(100);
        expect(await deleteInBatches(all, deleteBatch)).toEqual({
            deleted: 100,
            error: null,
        });
        expect(deleteBatch.mock.calls).toEqual([[all]]);
    });

    it('splits 1000 IDs into ten batches of 100 in order', async () => {
        const deleteBatch = vi.fn(async (batch: string[]) => batch.length);
        const all = ids(1000);
        const result = await deleteInBatches(all, deleteBatch);
        expect(result).toEqual({ deleted: 1000, error: null });
        expect(deleteBatch).toHaveBeenCalledTimes(10);
        expect(deleteBatch.mock.calls.flatMap(([batch]) => batch)).toEqual(all);
        for (const [batch] of deleteBatch.mock.calls) {
            expect(batch).toHaveLength(100);
        }
    });

    it('sends a short last batch (even a single ID)', async () => {
        const deleteBatch = vi.fn(async (batch: string[]) => batch.length);
        const all = ids(201);
        await deleteInBatches(all, deleteBatch);
        expect(deleteBatch.mock.calls.map(([b]) => b.length)).toEqual([
            100, 100, 1,
        ]);
    });

    it('does nothing for no IDs', async () => {
        const deleteBatch = vi.fn(async (batch: string[]) => batch.length);
        expect(await deleteInBatches([], deleteBatch)).toEqual({
            deleted: 0,
            error: null,
        });
        expect(deleteBatch).not.toHaveBeenCalled();
    });

    it('counts what deleteBatch reports', async () => {
        const deleteBatch = vi.fn(async (batch: string[]) => batch.length - 1);
        const result = await deleteInBatches(ids(150), deleteBatch);
        expect(result.deleted).toBe(148);
    });

    it('stops at the first failing batch and reports the progress', async () => {
        const error = new Error('Missing Access');
        const deleteBatch = vi
            .fn(async (batch: string[]) => batch.length)
            .mockImplementationOnce(async (batch: string[]) => batch.length)
            .mockRejectedValueOnce(error);
        const sleep = vi.fn(async () => {});
        const result = await deleteInBatches(ids(300), deleteBatch, { sleep });
        expect(result).toEqual({ deleted: 100, error });
        expect(deleteBatch).toHaveBeenCalledTimes(2);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries a rate-limited batch after the requested wait', async () => {
        const deleteBatch = vi
            .fn(async (batch: string[]) => batch.length)
            .mockRejectedValueOnce(rateLimit(3));
        const sleep = vi.fn(async () => {});
        const all = ids(120);
        const result = await deleteInBatches(all, deleteBatch, { sleep });
        expect(result).toEqual({ deleted: 120, error: null });
        expect(sleep).toHaveBeenCalledWith(3000);
        expect(deleteBatch.mock.calls.map(([b]) => b)).toEqual([
            all.slice(0, 100),
            all.slice(0, 100),
            all.slice(100),
        ]);
    });

    it('gives up after too many rate limits on one batch', async () => {
        const error = rateLimit();
        const deleteBatch = vi.fn(async (): Promise<number> => {
            throw error;
        });
        const sleep = vi.fn(async () => {});
        const result = await deleteInBatches(ids(10), deleteBatch, { sleep });
        expect(result).toEqual({ deleted: 0, error });
        expect(deleteBatch).toHaveBeenCalledTimes(MAX_CLEAN_DELETE_RETRIES + 1);
        expect(sleep).toHaveBeenCalledTimes(MAX_CLEAN_DELETE_RETRIES);
    });
});

describe('cleanDeleteFailureMessage', () => {
    it('reports a failure before anything was deleted', () => {
        expect(
            cleanDeleteFailureMessage({
                deleted: 0,
                error: new Error('Missing Access'),
            })
        ).toBe('Failed to delete messages: Missing Access');
    });

    it('reports partial progress', () => {
        expect(
            cleanDeleteFailureMessage({
                deleted: 200,
                error: new Error('boom'),
            })
        ).toBe('Deleted 200 message(s), then failed to delete the rest: boom');
    });

    it('handles non-Error values', () => {
        expect(cleanDeleteFailureMessage({ deleted: 0, error: 'nope' })).toBe(
            'Failed to delete messages: nope'
        );
    });
});
