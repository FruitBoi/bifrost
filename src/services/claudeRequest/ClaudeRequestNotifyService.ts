/**
 * Claude request notifications (issue #26): tells the requester, in the
 * channel they ran `clauderequest` in, once their GitHub issue is closed.
 *
 * Every filed request is stored by {@link ClaudeRequestNotifyService.track}.
 * Every `pollIntervalMs` the service asks GitHub for the state of each
 * tracked issue (once per issue, however many rows point at it). A closed
 * issue is handed to the {@link ClaudeRequestNotifier} registered for the
 * row's platform and the row is deleted; an issue GitHub no longer knows
 * (404/410) is dropped. GitHub or network errors are retried on the next
 * tick without counting against the row. Notifier failures follow the
 * reminder rules: permanent ones drop the row, transient ones bump
 * `attempts` until `maxAttempts`. Ticks never overlap, and a platform whose
 * notifier is not registered (client not connected) is skipped until it is.
 *
 * Replies to notices (issue #35): each posted notice is stored in the
 * optional notices repository so {@link ClaudeRequestNotifyService.findNotice}
 * can tell a reply to it apart from any other message; such replies are
 * commented on the issue, which is reopened. Notices older than
 * {@link NOTICE_RETENTION_MS} are pruned at most once a day from the poll
 * tick.
 */
import {
    ClaudeRequest,
    ClaudeRequestPlatform,
} from '../../db/entities/ClaudeRequest';
import { ClaudeRequestNotice } from '../../db/entities/ClaudeRequestNotice';
import { ClaudeRequestNoticeRepository } from '../../db/repositories/ClaudeRequestNoticeRepository';
import { ClaudeRequestRepository } from '../../db/repositories/ClaudeRequestRepository';
import logger from '../../utils/logging/logger';
import {
    ClaudeRequestNotifier,
    ClaudeRequestNotifyError,
    ClaudeRequestOutcome,
} from './ClaudeRequestNotifier';

export type { ClaudeRequestPlatform };

/** Longest title stored; the column is a 255-character STRING. */
const MAX_STORED_TITLE_LENGTH = 200;
/** Rows looked at per tick, oldest first. */
const MAX_ROWS_PER_TICK = 500;
/** How long a posted notice can still be replied to: 180 days. */
export const NOTICE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** Minimum time between two prunes of old notices: 24 hours. */
const NOTICE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface TrackClaudeRequestInput {
    platform: ClaudeRequestPlatform;
    issueNumber: number;
    issueUrl: string;
    title: string;
    userId: string;
    guildId: string;
    channelId: string;
    /** The invoking message, replied to when it still exists. */
    messageId: string | null;
}

export interface ClaudeRequestNotifyServiceOptions {
    /** GitHub token; empty disables polling. */
    token: string;
    /** `owner/name` of the repository the issues are filed in. */
    repo: string;
    fetchImpl?: typeof fetch;
    /** Clock used to prune old notices. Default `Date.now`. */
    now?: () => number;
    /**
     * Where posted notices are remembered so replies to them can be
     * recognised (issue #35). Without it nothing is stored and
     * {@link ClaudeRequestNotifyService.findNotice} always resolves null.
     */
    notices?: ClaudeRequestNoticeRepository | null;
    /** How often GitHub is polled. Default 2 minutes. */
    pollIntervalMs?: number;
    /** Failed notifications after which a request is dropped. Default 5. */
    maxAttempts?: number;
}

/** What GitHub said about one issue during a tick. */
type IssueState =
    | { kind: 'open' }
    | { kind: 'closed'; outcome: ClaudeRequestOutcome }
    | { kind: 'gone'; status: number }
    | { kind: 'error'; detail: string };

export default class ClaudeRequestNotifyService {
    private readonly token: string;
    private readonly repo: string;
    private readonly fetchImpl: typeof fetch;
    private readonly pollIntervalMs: number;
    private readonly maxAttempts: number;
    private readonly now: () => number;
    private readonly notices: ClaudeRequestNoticeRepository | null;
    /** When old notices were last pruned; null before the first prune. */
    private lastPruneAt: number | null = null;
    private readonly notifiers = new Map<
        ClaudeRequestPlatform,
        ClaudeRequestNotifier
    >();
    private interval: ReturnType<typeof setInterval> | null = null;
    private ticking = false;

    constructor(
        private readonly requests: ClaudeRequestRepository,
        options: ClaudeRequestNotifyServiceOptions
    ) {
        this.token = options.token;
        this.repo = options.repo;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
        this.pollIntervalMs = options.pollIntervalMs ?? 120_000;
        this.maxAttempts = options.maxAttempts ?? 5;
        this.now = options.now ?? Date.now;
        this.notices = options.notices ?? null;
    }

    isConfigured(): boolean {
        return this.token.length > 0;
    }

    /** Registers (or, with null, removes) the notifier for a platform. */
    setNotifier(
        platform: ClaudeRequestPlatform,
        notifier: ClaudeRequestNotifier | null
    ): void {
        if (notifier) this.notifiers.set(platform, notifier);
        else this.notifiers.delete(platform);
    }

    /**
     * Remembers a filed request so its requester is notified when the issue
     * closes. Never rejects: a failure only costs the notification, the issue
     * itself was already filed.
     */
    async track(input: TrackClaudeRequestInput): Promise<void> {
        try {
            const request = await this.requests.create({
                ...input,
                title:
                    input.title.length > MAX_STORED_TITLE_LENGTH
                        ? `${input.title.slice(0, MAX_STORED_TITLE_LENGTH - 1)}…`
                        : input.title,
            });
            logger.info(
                `🤖 Tracking Claude request #${request.issueNumber} on ${request.platform} for user ${request.userId} in channel ${request.channelId}`
            );
        } catch (err) {
            logger.error(
                `❌ Failed to track Claude request #${input.issueNumber}; the requester will not be notified:`,
                err
            );
        }
    }

    /**
     * The stored notice posted as `noticeMessageId` on `platform`, or null
     * when the message is not a (still remembered) notice. Never rejects:
     * repository errors are logged and resolve null.
     */
    async findNotice(
        platform: ClaudeRequestPlatform,
        noticeMessageId: string
    ): Promise<ClaudeRequestNotice | null> {
        if (!this.notices) return null;
        try {
            return await this.notices.findByNoticeMessage(
                platform,
                noticeMessageId
            );
        } catch (err) {
            logger.error(
                `❌ Failed to look up Claude request notice ${noticeMessageId} on ${platform}:`,
                err
            );
            return null;
        }
    }

    /**
     * One poll tick: notifies the requesters of every tracked issue that has
     * been closed. Never rejects; problems are logged. A tick that starts
     * while another one is still running returns immediately so a slow
     * platform cannot cause double notifications.
     */
    async checkClosed(): Promise<void> {
        if (this.ticking || !this.isConfigured()) return;
        this.ticking = true;
        try {
            await this.pruneNotices();
            const rows = await this.requests.findAll(MAX_ROWS_PER_TICK);
            const byIssue = new Map<number, ClaudeRequest[]>();
            for (const row of rows) {
                if (!this.notifiers.has(row.platform)) continue;
                const group = byIssue.get(row.issueNumber);
                if (group) group.push(row);
                else byIssue.set(row.issueNumber, [row]);
            }

            for (const [issueNumber, group] of byIssue) {
                const state = await this.fetchIssueState(issueNumber);
                if (state.kind === 'open') continue;
                if (state.kind === 'error') {
                    logger.warn(
                        `⚠️ Could not check Claude request issue #${issueNumber}, will retry: ${state.detail}`
                    );
                    continue;
                }
                for (const request of group) {
                    if (state.kind === 'gone') {
                        await this.drop(
                            request,
                            `GitHub answered ${state.status} for the issue`
                        );
                        continue;
                    }
                    const notifier = this.notifiers.get(request.platform);
                    if (!notifier) continue;
                    await this.notifyOne(request, state.outcome, notifier);
                }
            }
        } catch (err) {
            logger.error('❌ Claude request poll tick failed:', err);
        } finally {
            this.ticking = false;
        }
    }

    /**
     * Deletes notices older than {@link NOTICE_RETENTION_MS}, at most once
     * per {@link NOTICE_PRUNE_INTERVAL_MS}. Never throws; a failed prune is
     * retried after the next interval.
     */
    private async pruneNotices(): Promise<void> {
        if (!this.notices) return;
        const now = this.now();
        if (
            this.lastPruneAt !== null &&
            now - this.lastPruneAt < NOTICE_PRUNE_INTERVAL_MS
        ) {
            return;
        }
        this.lastPruneAt = now;
        try {
            const removed = await this.notices.deleteOlderThan(
                new Date(now - NOTICE_RETENTION_MS)
            );
            if (removed > 0) {
                logger.info(
                    `🤖 Pruned ${removed} Claude request notice(s) older than 180 days`
                );
            }
        } catch (err) {
            logger.warn('⚠️ Failed to prune old Claude request notices:', err);
        }
    }

    /** Asks GitHub for the issue; never throws. */
    private async fetchIssueState(issueNumber: number): Promise<IssueState> {
        try {
            const response = await this.fetchImpl(
                `https://api.github.com/repos/${this.repo}/issues/${issueNumber}`,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        'User-Agent': 'bifrost-bot',
                    },
                }
            );
            if (response.status === 404 || response.status === 410) {
                return { kind: 'gone', status: response.status };
            }
            let data: {
                state?: string;
                state_reason?: string | null;
                message?: string;
            } = {};
            try {
                data = (await response.json()) as typeof data;
            } catch {
                // Non-JSON response; fall back to the status alone.
            }
            if (response.status !== 200) {
                const detail = [response.status, data.message]
                    .filter((part) => part !== undefined && part !== '')
                    .join(' ');
                return { kind: 'error', detail: this.scrub(detail) };
            }
            if (data.state === 'open') return { kind: 'open' };
            if (data.state === 'closed') {
                const reason = data.state_reason ?? null;
                return {
                    kind: 'closed',
                    outcome:
                        reason === 'not_planned' || reason === 'duplicate'
                            ? 'not_planned'
                            : 'completed',
                };
            }
            return {
                kind: 'error',
                detail: `unexpected issue state ${JSON.stringify(data.state)}`,
            };
        } catch (error) {
            return {
                kind: 'error',
                detail: this.scrub(
                    error instanceof Error ? error.message : 'unknown error'
                ),
            };
        }
    }

    /** Removes the token from text that is about to be logged. */
    private scrub(text: string): string {
        return this.token ? text.split(this.token).join('***') : text;
    }

    private async notifyOne(
        request: ClaudeRequest,
        outcome: ClaudeRequestOutcome,
        notifier: ClaudeRequestNotifier
    ): Promise<void> {
        let noticeMessageId: string | null;
        try {
            noticeMessageId = await notifier.notify(request, outcome);
        } catch (err) {
            await this.handleFailure(request, err);
            return;
        }
        if (noticeMessageId) await this.storeNotice(request, noticeMessageId);
        try {
            await this.requests.deleteById(request.id);
            logger.info(
                `🤖 Notified user ${request.userId} on ${request.platform} that Claude request #${request.issueNumber} was closed (${outcome})`
            );
        } catch (err) {
            logger.error(
                `❌ Claude request #${request.issueNumber} was reported but its row ${request.id} could not be deleted:`,
                err
            );
        }
    }

    /**
     * Remembers a posted notice so replies to it can be recognised. Never
     * throws: the notice was already posted, so a failure here only costs
     * the reply feature for that notice.
     */
    private async storeNotice(
        request: ClaudeRequest,
        noticeMessageId: string
    ): Promise<void> {
        if (!this.notices) return;
        try {
            await this.notices.create({
                platform: request.platform,
                issueNumber: request.issueNumber,
                issueUrl: request.issueUrl,
                title: request.title,
                userId: request.userId,
                guildId: request.guildId,
                channelId: request.channelId,
                noticeMessageId,
            });
        } catch (err) {
            logger.error(
                `❌ Failed to remember the notice ${noticeMessageId} of Claude request #${request.issueNumber}; replies to it will be ignored:`,
                err
            );
        }
    }

    private async drop(request: ClaudeRequest, why: string): Promise<void> {
        try {
            await this.requests.deleteById(request.id);
            logger.warn(
                `⚠️ Dropped Claude request #${request.issueNumber} on ${request.platform} (channel ${request.channelId}): ${why}`
            );
        } catch (err) {
            logger.error(
                `❌ Failed to drop Claude request #${request.issueNumber} (row ${request.id}):`,
                err
            );
        }
    }

    private async handleFailure(
        request: ClaudeRequest,
        err: unknown
    ): Promise<void> {
        const label = `#${request.issueNumber} on ${request.platform} (channel ${request.channelId})`;
        try {
            if (err instanceof ClaudeRequestNotifyError && err.permanent) {
                await this.requests.deleteById(request.id);
                logger.warn(
                    `⚠️ Dropped Claude request ${label}: ${err.message}`,
                    err.cause ?? ''
                );
                return;
            }
            const attempts = request.attempts + 1;
            if (attempts >= this.maxAttempts) {
                await this.requests.deleteById(request.id);
                logger.error(
                    `❌ Giving up on notifying Claude request ${label} after ${attempts} failed attempts:`,
                    err
                );
                return;
            }
            await this.requests.incrementAttempts(request.id);
            logger.warn(
                `⚠️ Claude request ${label} could not be reported (attempt ${attempts} of ${this.maxAttempts}), will retry:`,
                err
            );
        } catch (repoErr) {
            logger.error(
                `❌ Failed to record the notification failure of Claude request ${label}:`,
                repoErr
            );
        }
    }

    /**
     * Starts polling: one tick right away (so issues closed while the bot
     * was offline are reported immediately) and then one every
     * `pollIntervalMs`. Calling it again while running does nothing.
     */
    start(): void {
        if (this.interval) return;
        this.interval = setInterval(() => {
            void this.checkClosed();
        }, this.pollIntervalMs);
        void this.checkClosed();
        logger.info(
            `🤖 Claude request notifications started (every ${this.pollIntervalMs / 1000} s)`
        );
    }

    stop(): void {
        if (!this.interval) return;
        clearInterval(this.interval);
        this.interval = null;
    }
}
