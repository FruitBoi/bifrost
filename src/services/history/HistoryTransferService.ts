/**
 * Background runner of the `history` command (issue #16). A job copies one
 * linked location's history to its counterpart on the other platform through
 * a {@link HistorySource}, oldest first, skipping anything already bridged.
 * Jobs run one at a time (FIFO) with a pause between destination posts, so a
 * large backfill never floods either platform.
 *
 * A job runs in two phases:
 *
 * 1. Backward scan (`fetchBefore`) from the newest message in scope to find
 *    where "the last N eligible messages" start, honouring `-ma`, `-after`
 *    and `-before`. Skipped for `all` without a max age, which starts at
 *    `-after` or the beginning of the channel.
 * 2. Forward pass (`fetchAfter`) from that start: every eligible message that
 *    is not yet bridged (message link, earlier transfer, our own webhook's
 *    copy) is copied, as one post each (`messages` mode) or packed into
 *    transcript posts (`digest` mode).
 */

import { randomUUID } from 'crypto';
import type { HistoryMessageRepository } from '../../db/repositories/HistoryMessageRepository';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import logger from '../../utils/logging/logger';
import { compareSnowflakes } from '../clean/cleanFilter';
import { WebhookMessageData } from '../WebhookService';
import {
    DigestEntry,
    DigestPost,
    packDigest,
    timestampTag,
    truncateText,
} from './historyDigest';
import {
    HistoryItem,
    HistoryJob,
    HistoryJobStatus,
    HistoryOptions,
    HistorySource,
} from './HistorySource';

/** Largest page the message-list routes allow on both platforms. */
export const DEFAULT_HISTORY_PAGE_SIZE = 100;
/** Longest message content on both platforms. */
export const HISTORY_MESSAGE_MAX_CHARS = 2000;
/** Times one post is retried after a rate limit before it counts as failed. */
export const MAX_RATE_LIMIT_RETRIES = 5;
/** Consecutive failed posts after which the job gives up. */
export const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** The job error when Fluxer blocks the bot mid-transfer (or before it starts). */
export const FLUXER_BLOCKED_MESSAGE =
    'Fluxer API blocked the bot; run the command again later — transferred messages are skipped automatically';

export class HistoryTransferError extends Error {
    constructor(
        public readonly reason: 'already_running' | 'fluxer_blocked',
        message: string
    ) {
        super(message);
        this.name = 'HistoryTransferError';
    }
}

/** Ends the running job as `failed` with a user-facing message. */
class JobFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JobFailure';
    }
}

/** Ends the running job as `stopped`. */
class JobStopped extends Error {
    constructor() {
        super('History transfer stopped');
        this.name = 'JobStopped';
    }
}

export interface HistoryTransferSettings {
    /** Pause between destination posts. */
    delayMs: number;
    /** Page size for history fetches (default 100). */
    pageSize?: number;
    /** Injected for tests; defaults to setTimeout. */
    sleep?: (ms: number) => Promise<void>;
    /** Injected for tests; defaults to Date.now. */
    now?: () => number;
}

interface ActiveJob {
    job: HistoryJob;
    source: HistorySource<unknown>;
    onProgress: ((job: HistoryJob) => void) | null;
    stopRequested: boolean;
}

/** Bookkeeping of one forward pass. */
interface RunState {
    /** Eligible messages seen so far, compared against `options.count`. */
    eligibleCounted: number;
    consecutiveFailures: number;
    /** A post (or attempt) happened: pause before the next one. */
    needsDelay: boolean;
    /** Digest entries not yet posted (a partially filled last post). */
    digestBuffer: DigestEntry[];
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isFinished(status: HistoryJobStatus): boolean {
    return status === 'done' || status === 'stopped' || status === 'failed';
}

/**
 * Whether the message is one the bridge would relay at all: not a system
 * message, not empty, not a bot command and not written by the bot itself.
 * Already-bridged messages and our own webhook's copies *are* eligible; they
 * are what "the last N messages" counts, even though they are then skipped.
 */
export function isHistoryEligible(
    item: HistoryItem<unknown>,
    botUserId: string | null
): boolean {
    return (
        !item.isSystem &&
        !item.isEmpty &&
        !item.isCommand &&
        (botUserId === null || item.authorId !== botUserId)
    );
}

/**
 * `content` with the original time as a leading subtext line
 * (`-# <t:unix:f>`); the content is cut with `…` when the result would
 * exceed `maxChars`. Empty content yields the time line alone.
 */
export function withTimestampPrefix(
    content: string,
    createdAt: Date,
    maxChars = HISTORY_MESSAGE_MAX_CHARS
): string {
    const prefix = `-# ${timestampTag(createdAt)}`;
    if (content === '') return prefix;
    const available = maxChars - prefix.length - '\n'.length;
    return `${prefix}\n${truncateText(content, available)}`;
}

/**
 * How long to wait before retrying a send that failed with a rate limit, or
 * null when `err` is not a rate limit. Recognises `statusCode`/`status` 429,
 * a numeric `retryAfter`/`retry_after` (seconds, as both REST clients report
 * it) and `@fluxerjs/rest`'s `RateLimitError`; the wait defaults to 5 s and
 * is capped at a minute.
 */
export function rateLimitWaitMs(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const e = err as Record<string, unknown>;
    const retryAfter =
        typeof e.retryAfter === 'number'
            ? e.retryAfter
            : typeof e.retry_after === 'number'
              ? e.retry_after
              : null;
    const rateLimited =
        e.statusCode === 429 ||
        e.status === 429 ||
        retryAfter !== null ||
        e.name === 'RateLimitError';
    if (!rateLimited) return null;
    const wait =
        retryAfter !== null && retryAfter > 0
            ? retryAfter * 1000
            : DEFAULT_RATE_LIMIT_WAIT_MS;
    return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS);
}

function sortNewestFirst<M>(items: HistoryItem<M>[]): HistoryItem<M>[] {
    return [...items].sort((a, b) => compareSnowflakes(b.id, a.id));
}

function sortOldestFirst<M>(items: HistoryItem<M>[]): HistoryItem<M>[] {
    return [...items].sort((a, b) => compareSnowflakes(a.id, b.id));
}

export default class HistoryTransferService {
    private readonly queue: ActiveJob[] = [];
    private running: ActiveJob | null = null;
    /** Queued and running jobs by channel link id. */
    private readonly byLink = new Map<string, ActiveJob>();
    private readonly pageSize: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;

    constructor(
        private readonly repo: HistoryMessageRepository,
        private readonly settings: HistoryTransferSettings
    ) {
        this.pageSize = settings.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
        this.sleep = settings.sleep ?? defaultSleep;
        this.now = settings.now ?? (() => Date.now());
    }

    /**
     * Queues a job for `source`'s link and returns it immediately, still
     * `queued`; it starts on the next tick when no other job is running.
     * One job per channel link: throws `HistoryTransferError('already_running')`
     * when one is queued or running for `source.link.id`, and
     * `'fluxer_blocked'` when a Discord→Fluxer job is started while Fluxer is
     * blocking the bot. Jobs run one at a time, FIFO. `onProgress` is called
     * on every status change and after every page and every post.
     */
    start<M>(
        source: HistorySource<M>,
        options: HistoryOptions,
        requestedBy: string,
        onProgress?: (job: HistoryJob) => void
    ): HistoryJob {
        const linkId = source.link.id;
        const existing = this.byLink.get(linkId);
        if (existing) {
            throw new HistoryTransferError(
                'already_running',
                `A history transfer is already ${existing.job.progress.status} for this link`
            );
        }
        if (source.platform === 'discord' && isFluxerApiBlocked()) {
            throw new HistoryTransferError(
                'fluxer_blocked',
                FLUXER_BLOCKED_MESSAGE
            );
        }

        const job: HistoryJob = {
            id: randomUUID(),
            channelLinkId: linkId,
            sourcePlatform: source.platform,
            options: { ...options },
            requestedBy,
            progress: {
                status: 'queued',
                scanned: 0,
                eligible: 0,
                transferred: 0,
                posts: 0,
                skippedBridged: 0,
                skippedOther: 0,
                failed: 0,
                lastMessageId: null,
                error: null,
                queuedAt: new Date(this.now()),
                startedAt: null,
                finishedAt: null,
            },
        };
        const active: ActiveJob = {
            job,
            source: source as HistorySource<unknown>,
            onProgress: onProgress ?? null,
            stopRequested: false,
        };
        this.byLink.set(linkId, active);
        this.queue.push(active);
        void Promise.resolve().then(() => this.runNext());
        return job;
    }

    /**
     * Requests a stop; returns false when no job is queued or running for
     * the link. A queued job becomes `stopped` at once; a running one stops
     * after the current post.
     */
    stop(channelLinkId: string): boolean {
        const active = this.byLink.get(channelLinkId);
        if (!active) return false;
        if (active.job.progress.status === 'queued') {
            const index = this.queue.indexOf(active);
            if (index >= 0) this.queue.splice(index, 1);
            this.byLink.delete(channelLinkId);
            this.finish(active, 'stopped', null);
            return true;
        }
        active.stopRequested = true;
        return true;
    }

    /** The queued or running job for the link, else null. */
    getJob(channelLinkId: string): HistoryJob | null {
        return this.byLink.get(channelLinkId)?.job ?? null;
    }

    /**
     * 0-based position of a queued job among the queued jobs (the running
     * job excluded); 0 when it is running or absent.
     */
    queuePosition(channelLinkId: string): number {
        const active = this.byLink.get(channelLinkId);
        if (!active) return 0;
        const index = this.queue.indexOf(active);
        return index < 0 ? 0 : index;
    }

    /** Number of queued + running jobs. */
    get activeCount(): number {
        return this.queue.length + (this.running ? 1 : 0);
    }

    private async runNext(): Promise<void> {
        if (this.running) return;
        const next = this.queue.shift();
        if (!next) return;
        this.running = next;
        try {
            await this.runJob(next);
        } catch (err) {
            logger.error(
                '❌ History transfer runner failed unexpectedly:',
                err
            );
            if (!isFinished(next.job.progress.status)) {
                this.finish(next, 'failed', errorMessage(err));
            }
        } finally {
            this.byLink.delete(next.job.channelLinkId);
            this.running = null;
        }
        void this.runNext();
    }

    private async runJob(active: ActiveJob): Promise<void> {
        const { job } = active;
        job.progress.status = 'running';
        job.progress.startedAt = new Date(this.now());
        this.notify(active);
        logger.info(
            `📜 History transfer ${job.id} started for link ${job.channelLinkId} (${job.sourcePlatform} → other side, ${job.options.mode} mode, count=${job.options.count ?? 'all'})`
        );

        try {
            await this.transfer(active);
            this.finish(active, 'done', null);
        } catch (err) {
            if (err instanceof JobStopped) {
                this.finish(active, 'stopped', null);
            } else if (err instanceof JobFailure) {
                logger.warn(
                    `⚠️ History transfer ${job.id} failed: ${err.message}`
                );
                this.finish(active, 'failed', err.message);
            } else {
                logger.error(`❌ History transfer ${job.id} crashed:`, err);
                this.finish(active, 'failed', errorMessage(err));
            }
        }
        const p = job.progress;
        logger.info(
            `📜 History transfer ${job.id} ${p.status}: scanned=${p.scanned} transferred=${p.transferred} posts=${p.posts} skippedBridged=${p.skippedBridged} skippedOther=${p.skippedOther} failed=${p.failed}`
        );
    }

    private finish(
        active: ActiveJob,
        status: 'done' | 'stopped' | 'failed',
        error: string | null
    ): void {
        active.job.progress.status = status;
        active.job.progress.error = error;
        active.job.progress.finishedAt = new Date(this.now());
        this.notify(active);
    }

    private notify(active: ActiveJob): void {
        try {
            active.onProgress?.(active.job);
        } catch (err) {
            logger.warn(
                `⚠️ History transfer ${active.job.id}: progress callback threw: ${errorMessage(err)}`
            );
        }
    }

    private checkStop(active: ActiveJob): void {
        if (active.stopRequested) throw new JobStopped();
    }

    private ageOf(item: HistoryItem<unknown>): number {
        return this.now() - item.createdAt.getTime();
    }

    private async transfer(active: ActiveJob): Promise<void> {
        const cursor = await this.findStartCursor(active);
        if (cursor === null) return;
        await this.forwardPass(active, cursor);
    }

    /**
     * Phase A: the id to `fetchAfter` from so that the forward pass covers
     * exactly the messages in scope (one less than the oldest in-scope id),
     * or null when nothing is in scope.
     */
    private async findStartCursor(active: ActiveJob): Promise<string | null> {
        const { source, job } = active;
        const { count, maxAgeMs, afterId, beforeId } = job.options;
        if (count === null && maxAgeMs === null) return afterId ?? '0';

        let before: string | undefined = beforeId ?? undefined;
        let eligibleSeen = 0;
        let oldestInScope: string | null = null;

        pages: for (;;) {
            this.checkStop(active);
            const page = sortNewestFirst(
                await source.fetchBefore(before, this.pageSize)
            );
            if (page.length === 0) break;
            for (const item of page) {
                if (
                    afterId !== null &&
                    compareSnowflakes(item.id, afterId) <= 0
                ) {
                    break pages;
                }
                if (maxAgeMs !== null && this.ageOf(item) > maxAgeMs) {
                    break pages;
                }
                oldestInScope = item.id;
                if (isHistoryEligible(item, source.botUserId)) {
                    eligibleSeen++;
                    if (count !== null && eligibleSeen >= count) break pages;
                }
            }
            before = page[page.length - 1].id;
        }

        if (oldestInScope === null) return null;
        return (BigInt(oldestInScope) - BigInt(1)).toString();
    }

    /** Phase B: walks forward from `cursor` and copies what is not bridged yet. */
    private async forwardPass(
        active: ActiveJob,
        cursor: string
    ): Promise<void> {
        const { source, job } = active;
        const { options } = job;
        const p = job.progress;
        const ownWebhookId =
            source.platform === 'discord'
                ? source.link.discordWebhookId
                : source.link.fluxerWebhookId;
        const state: RunState = {
            eligibleCounted: 0,
            consecutiveFailures: 0,
            needsDelay: false,
            digestBuffer: [],
        };

        let after = cursor;
        for (;;) {
            this.checkStop(active);
            const page = sortOldestFirst(
                await source.fetchAfter(after, this.pageSize)
            );
            if (page.length === 0) break;

            let finished = false;
            const candidates: HistoryItem<unknown>[] = [];
            for (const item of page) {
                if (
                    options.beforeId !== null &&
                    compareSnowflakes(item.id, options.beforeId) >= 0
                ) {
                    finished = true;
                    break;
                }
                p.scanned++;
                p.lastMessageId = item.id;
                if (
                    options.maxAgeMs !== null &&
                    this.ageOf(item) > options.maxAgeMs
                ) {
                    p.skippedOther++;
                    continue;
                }
                if (!isHistoryEligible(item, source.botUserId)) {
                    p.skippedOther++;
                    continue;
                }
                p.eligible++;
                state.eligibleCounted++;
                if (
                    item.webhookId !== null &&
                    item.webhookId === ownWebhookId
                ) {
                    p.skippedBridged++;
                } else {
                    candidates.push(item);
                }
                if (
                    options.count !== null &&
                    state.eligibleCounted >= options.count
                ) {
                    finished = true;
                    break;
                }
            }

            const toTransfer = await this.withoutTransferred(
                source,
                candidates
            );
            p.skippedBridged += candidates.length - toTransfer.length;

            for (const item of toTransfer) {
                if (options.mode === 'messages') {
                    await this.transferMessage(active, item, state);
                } else {
                    await this.collectDigest(active, item, state);
                }
            }
            this.notify(active);

            if (finished) break;
            after = page[page.length - 1].id;
        }

        if (options.mode === 'digest') await this.flushDigest(active, state);
    }

    /** `items` minus those already transferred or bridged, in order. */
    private async withoutTransferred(
        source: HistorySource<unknown>,
        items: HistoryItem<unknown>[]
    ): Promise<HistoryItem<unknown>[]> {
        if (items.length === 0) return [];
        const transferred = await this.repo.findTransferredIds(
            source.platform,
            items.map((item) => item.id)
        );
        const result: HistoryItem<unknown>[] = [];
        for (const item of items) {
            if (transferred.has(item.id)) continue;
            if (await source.isBridged(item.id)) continue;
            result.push(item);
        }
        return result;
    }

    private row(
        source: HistorySource<unknown>,
        sourceMessageId: string,
        targetMessageId: string
    ) {
        return {
            guildLinkId: source.link.guildLinkId,
            channelLinkId: source.link.id,
            sourcePlatform: source.platform,
            sourceMessageId,
            targetMessageId,
        };
    }

    /** Messages mode: one bridged-style copy per source message. */
    private async transferMessage(
        active: ActiveJob,
        item: HistoryItem<unknown>,
        state: RunState
    ): Promise<void> {
        const { source, job } = active;
        try {
            const payload = await source.buildPayload(item);
            payload.suppressMentions = true;
            if (job.options.timestamps) {
                payload.content = withTimestampPrefix(
                    payload.content,
                    item.createdAt
                );
            }
            const { messageId } = await this.post(active, state, payload);
            job.progress.posts++;
            await source.createMessageLink(item, messageId);
            await this.repo.createMany([this.row(source, item.id, messageId)]);
            job.progress.transferred++;
            state.consecutiveFailures = 0;
            this.notify(active);
        } catch (err) {
            this.handleItemFailure(active, state, err, `message ${item.id}`);
        }
    }

    /**
     * Digest mode: buffers the item and posts every digest that is full. The
     * last (possibly unfilled) post stays buffered so it can be topped up by
     * the next page; {@link flushDigest} posts it at the end.
     */
    private async collectDigest(
        active: ActiveJob,
        item: HistoryItem<unknown>,
        state: RunState
    ): Promise<void> {
        const { source, job } = active;
        let payload: WebhookMessageData;
        try {
            payload = await source.buildPayload(item);
        } catch (err) {
            this.handleItemFailure(active, state, err, `message ${item.id}`);
            return;
        }
        state.digestBuffer.push({
            sourceId: item.id,
            authorName: item.authorName,
            createdAt: item.createdAt,
            payload,
        });

        const posts = packDigest(
            state.digestBuffer,
            source.digestIdentity(),
            job.options.timestamps
        );
        if (posts.length < 2) return;
        const keep = new Set(posts[posts.length - 1].sourceIds);
        const full = posts.slice(0, -1);
        // Drop the posted entries first so a failure never re-posts them.
        state.digestBuffer = state.digestBuffer.filter((entry) =>
            keep.has(entry.sourceId)
        );
        for (const post of full) await this.sendDigestPost(active, state, post);
    }

    private async flushDigest(
        active: ActiveJob,
        state: RunState
    ): Promise<void> {
        if (state.digestBuffer.length === 0) return;
        const posts = packDigest(
            state.digestBuffer,
            active.source.digestIdentity(),
            active.job.options.timestamps
        );
        state.digestBuffer = [];
        for (const post of posts)
            await this.sendDigestPost(active, state, post);
    }

    private async sendDigestPost(
        active: ActiveJob,
        state: RunState,
        post: DigestPost
    ): Promise<void> {
        const { source, job } = active;
        try {
            const { messageId } = await this.post(active, state, post.payload);
            job.progress.posts++;
            await this.repo.createMany(
                post.sourceIds.map((id) => this.row(source, id, messageId))
            );
            job.progress.transferred += post.sourceIds.length;
            state.consecutiveFailures = 0;
            this.notify(active);
        } catch (err) {
            this.handleItemFailure(
                active,
                state,
                err,
                `digest of ${post.sourceIds.length} messages`
            );
        }
    }

    /**
     * Posts `payload` on the other platform: pauses `delayMs` after the
     * previous post, refuses to post into a blocked Fluxer, retries rate
     * limits up to {@link MAX_RATE_LIMIT_RETRIES} times and honours stop
     * requests. Throws {@link JobFailure} / {@link JobStopped} to end the
     * job, or the send error for the caller to count.
     */
    private async post(
        active: ActiveJob,
        state: RunState,
        payload: WebhookMessageData
    ): Promise<{ messageId: string }> {
        const { source } = active;
        for (let attempt = 0; ; attempt++) {
            this.checkStop(active);
            if (state.needsDelay && this.settings.delayMs > 0) {
                await this.sleep(this.settings.delayMs);
                this.checkStop(active);
            }
            if (source.platform === 'discord' && isFluxerApiBlocked()) {
                throw new JobFailure(FLUXER_BLOCKED_MESSAGE);
            }
            state.needsDelay = true;
            try {
                return await source.send(payload);
            } catch (err) {
                if (isFluxerApiBlockError(err)) {
                    markFluxerApiBlocked();
                    throw new JobFailure(FLUXER_BLOCKED_MESSAGE);
                }
                const wait = rateLimitWaitMs(err);
                if (wait === null || attempt >= MAX_RATE_LIMIT_RETRIES) {
                    throw err;
                }
                logger.debug(
                    `📜 History transfer ${active.job.id}: rate limited, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
                );
                await this.sleep(wait);
                // The wait already spaced this post out.
                state.needsDelay = false;
            }
        }
    }

    /**
     * Counts a failed copy and carries on, unless the failure ends the job
     * (a {@link JobFailure} or {@link JobStopped}, rethrown) or it is the
     * {@link MAX_CONSECUTIVE_FAILURES}th in a row.
     */
    private handleItemFailure(
        active: ActiveJob,
        state: RunState,
        err: unknown,
        what: string
    ): void {
        if (err instanceof JobFailure || err instanceof JobStopped) throw err;
        const { job } = active;
        job.progress.failed++;
        state.consecutiveFailures++;
        logger.warn(
            `⚠️ History transfer ${job.id}: failed to copy ${what}: ${errorMessage(err)}`
        );
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new JobFailure(
                `${MAX_CONSECUTIVE_FAILURES} consecutive failures, last one: ${errorMessage(err)}`
            );
        }
        this.notify(active);
    }
}
