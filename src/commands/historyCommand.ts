/**
 * Platform-independent half of the `history` command (issue #16): the
 * pending-confirmation store, the wording of the status/confirmation embeds
 * and the throttled editing of the status reply. The Discord and Fluxer
 * handlers adapt their platform's message objects to these helpers.
 */
import type { ChannelLink } from '../db/entities/ChannelLink';
import {
    discordLocationId,
    fluxerLocationId,
} from '../db/entities/ChannelLink';
import type { MessagePlatform } from '../db/entities/MessageLink';
import type {
    HistoryJob,
    HistoryJobStatus,
    HistoryOptions,
} from '../services/history/HistorySource';
import { COMMAND_PREFIX } from '../utils/env';
import { EmbedColors } from '../utils/embeds';
import { formatDuration } from '../utils/duration';
import logger from '../utils/logging/logger';

/** How long `history all` waits for `history confirm`. */
export const HISTORY_CONFIRM_TTL_MS = 2 * 60 * 1000;

/** Shortest pause between two edits of the status reply (status changes bypass it). */
export const HISTORY_STATUS_EDIT_INTERVAL_MS = 5_000;

export interface PendingHistoryTransfer {
    options: HistoryOptions;
    /** The channel link the transfer was requested in. */
    channelLinkId: string;
}

/**
 * Transfers awaiting `history confirm`, one per user, forgotten after
 * {@link HISTORY_CONFIRM_TTL_MS} (same pattern as the unlink confirmation).
 */
export class PendingHistoryStore {
    private readonly pending = new Map<
        string,
        { transfer: PendingHistoryTransfer; timer: NodeJS.Timeout }
    >();

    constructor(private readonly ttlMs: number = HISTORY_CONFIRM_TTL_MS) {}

    set(userId: string, transfer: PendingHistoryTransfer): void {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(() => this.pending.delete(userId), this.ttlMs);
        timer.unref?.();
        this.pending.set(userId, { transfer, timer });
    }

    /** Removes and returns the user's pending transfer, if any. */
    take(userId: string): PendingHistoryTransfer | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.transfer;
    }
}

/** `Fluxer channel \`123\`` / `Discord thread \`456\``: where the copies go. */
export function historyTargetLabel(
    link: ChannelLink,
    sourcePlatform: MessagePlatform
): string {
    if (sourcePlatform === 'discord') {
        const kind = link.fluxerThreadId ? 'thread' : 'channel';
        return `Fluxer ${kind} \`${fluxerLocationId(link)}\``;
    }
    const kind = link.discordThreadId ? 'thread' : 'channel';
    return `Discord ${kind} \`${discordLocationId(link)}\``;
}

/** `last 100 messages`, `the whole history`, `messages younger than 7d after \`id\``. */
export function describeHistoryScope(options: HistoryOptions): string {
    const parts: string[] = [];
    if (options.count !== null) {
        parts.push(`the last ${options.count} message(s)`);
    } else {
        parts.push('the whole history');
    }
    if (options.maxAgeMs !== null) {
        parts.push(
            `younger than ${formatDuration(Math.floor(options.maxAgeMs / 1000))}`
        );
    }
    if (options.afterId) parts.push(`after \`${options.afterId}\``);
    if (options.beforeId) parts.push(`before \`${options.beforeId}\``);
    return parts.join(', ');
}

export function describeHistoryMode(options: HistoryOptions): string {
    const mode =
        options.mode === 'digest'
            ? 'digest (many messages per transcript post)'
            : 'messages (one post per message)';
    return options.timestamps ? mode : `${mode}, without timestamps`;
}

/** Rough duration of `posts` posts at `delayMs` between them, e.g. `17m`. */
export function estimateHistoryDuration(
    posts: number,
    delayMs: number
): string {
    return formatDuration(Math.ceil((posts * delayMs) / 1000));
}

export function historyStatusColor(status: HistoryJobStatus): number {
    switch (status) {
        case 'done':
            return EmbedColors.Success;
        case 'stopped':
            return EmbedColors.Warning;
        case 'failed':
            return EmbedColors.Error;
        default:
            return EmbedColors.Info;
    }
}

function statusLine(job: HistoryJob, queuePosition: number): string {
    const { status, error } = job.progress;
    switch (status) {
        case 'queued':
            return `⏳ Queued (position ${Math.max(1, queuePosition)}; one transfer runs at a time)`;
        case 'running':
            return '▶️ Running';
        case 'done':
            return '✅ Done';
        case 'stopped':
            return '⏹️ Stopped';
        case 'failed':
            return `❌ Failed${error ? `: ${error}` : ''}`;
    }
}

export interface HistoryJobContext {
    /** See {@link historyTargetLabel}. */
    target: string;
    /** 0 while running; the position in the queue otherwise. */
    queuePosition: number;
    delayMs: number;
    now: number;
}

/**
 * The description of the status embed: what is being transferred where,
 * how far it got and, once finished, how it ended.
 */
export function describeHistoryJob(
    job: HistoryJob,
    ctx: HistoryJobContext
): string {
    const p = job.progress;
    const lines = [
        `📜 **History transfer** → ${ctx.target}`,
        `**Status:** ${statusLine(job, ctx.queuePosition)}`,
        `**Scope:** ${describeHistoryScope(job.options)}`,
        `**Mode:** ${describeHistoryMode(job.options)}`,
        `**Transferred:** ${p.transferred} message(s) in ${p.posts} post(s)`,
        `**Skipped:** ${p.skippedBridged} already bridged, ${p.skippedOther} other`,
        `**Failed:** ${p.failed}`,
        `**Scanned:** ${p.scanned} (${p.eligible} eligible)`,
    ];
    if (p.lastMessageId) {
        lines.push(`**Last message:** \`${p.lastMessageId}\``);
    }
    if (p.startedAt) {
        const end = p.finishedAt ?? new Date(ctx.now);
        const elapsed = Math.max(
            0,
            Math.floor((end.getTime() - p.startedAt.getTime()) / 1000)
        );
        lines.push(`**Elapsed:** ${formatDuration(elapsed)}`);
    }
    if (p.status === 'queued' || p.status === 'running') {
        lines.push(
            `-# One post every ${ctx.delayMs / 1000}s. \`${COMMAND_PREFIX}history status\` shows this again, \`${COMMAND_PREFIX}history stop\` cancels.`
        );
    }
    return lines.join('\n');
}

/**
 * The warning shown for `history all` (or any transfer that needs a
 * confirmation) before anything is copied.
 */
export function describeHistoryConfirmation(
    options: HistoryOptions,
    target: string,
    delayMs: number
): string {
    const lines = [
        `⚠️ This will copy **${describeHistoryScope(options)}** of this channel to ${target}, oldest first, in the style of bridged messages (${describeHistoryMode(options)}).`,
        '',
        '- Messages that were already bridged or transferred are skipped, so re-running later is safe and continues where it left off.',
        `- Posts go out one every ${delayMs / 1000}s to stay inside the rate limits, so 1000 messages take about ${estimateHistoryDuration(1000, delayMs)}; a long history can take hours. The transfer runs in the background: \`${COMMAND_PREFIX}history status\` shows its progress and \`${COMMAND_PREFIX}history stop\` cancels it.`,
        '- Nobody is pinged by the copies.',
    ];
    if (options.mode !== 'digest') {
        lines.push(
            '- Tip: `-digest` packs many messages into a few transcript posts (much faster, but those copies get no per-message links, so later reactions, edits and deletions are not mirrored for them).'
        );
    }
    lines.push(
        '',
        `Run \`${COMMAND_PREFIX}history confirm\` within ${HISTORY_CONFIRM_TTL_MS / 60_000} minutes to start.`
    );
    return lines.join('\n');
}

/**
 * Edits the status reply as the job reports progress, at most once every
 * {@link HISTORY_STATUS_EDIT_INTERVAL_MS} except that a status change
 * (queued → running → done/stopped/failed) is shown at once. A pending
 * trailing edit guarantees that the last reported state always lands.
 * Edits are serialised and failures only logged.
 */
export class HistoryStatusEditor {
    private latest: HistoryJob | null = null;
    private lastStatus: HistoryJobStatus | null = null;
    private lastEditAt = Number.NEGATIVE_INFINITY;
    private timer: NodeJS.Timeout | null = null;
    private chain: Promise<void> = Promise.resolve();

    constructor(
        private readonly edit: (job: HistoryJob) => Promise<void>,
        private readonly intervalMs: number = HISTORY_STATUS_EDIT_INTERVAL_MS,
        private readonly now: () => number = Date.now
    ) {}

    /** Records the first state shown (the reply itself), for the throttle. */
    shown(job: HistoryJob): void {
        this.latest = job;
        this.lastStatus = job.progress.status;
        this.lastEditAt = this.now();
    }

    update(job: HistoryJob): void {
        this.latest = job;
        const statusChanged = job.progress.status !== this.lastStatus;
        const elapsed = this.now() - this.lastEditAt;
        if (statusChanged || elapsed >= this.intervalMs) {
            this.flush();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(
                () => this.flush(),
                this.intervalMs - elapsed
            );
            this.timer.unref?.();
        }
    }

    private flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const job = this.latest;
        if (!job) return;
        this.lastStatus = job.progress.status;
        this.lastEditAt = this.now();
        this.chain = this.chain
            .then(() => this.edit(job))
            .catch((err: unknown) => {
                logger.warn(
                    `⚠️ Could not update the history transfer status for link ${job.channelLinkId}:`,
                    err
                );
            });
    }
}
