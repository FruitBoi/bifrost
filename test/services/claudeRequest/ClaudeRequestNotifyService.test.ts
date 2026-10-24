import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRequest } from '../../../src/db/entities/ClaudeRequest';
import {
    ClaudeRequestRepository,
    CreateClaudeRequestData,
} from '../../../src/db/repositories/ClaudeRequestRepository';
import {
    ClaudeRequestNotifier,
    ClaudeRequestNotifyError,
    ClaudeRequestOutcome,
} from '../../../src/services/claudeRequest/ClaudeRequestNotifier';
import ClaudeRequestNotifyService, {
    TrackClaudeRequestInput,
} from '../../../src/services/claudeRequest/ClaudeRequestNotifyService';
import logger from '../../../src/utils/logging/logger';

/** In-memory ClaudeRequestRepository, oldest first like the table. */
class MemoryClaudeRequestRepository implements ClaudeRequestRepository {
    rows: ClaudeRequest[] = [];
    private seq = 0;
    findAllCalls = 0;
    failCreate = false;

    async create(data: CreateClaudeRequestData): Promise<ClaudeRequest> {
        if (this.failCreate) throw new Error('db down');
        const row: ClaudeRequest = {
            id: ++this.seq,
            ...data,
            attempts: 0,
            createdAt: new Date(),
        };
        this.rows.push(row);
        return { ...row };
    }
    async findById(id: number) {
        const row = this.rows.find((r) => r.id === id);
        return row ? { ...row } : null;
    }
    async findAll(limit?: number) {
        this.findAllCalls++;
        const sorted = [...this.rows]
            .sort((a, b) => a.id - b.id)
            .map((r) => ({ ...r }));
        return limit === undefined ? sorted : sorted.slice(0, limit);
    }
    async incrementAttempts(id: number) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.attempts++;
    }
    async deleteById(id: number) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.id !== id);
        return this.rows.length < before;
    }
    async count() {
        return this.rows.length;
    }
}

/** A notifier that records calls and fails the way it is told to. */
class FakeNotifier implements ClaudeRequestNotifier {
    notified: { request: ClaudeRequest; outcome: ClaudeRequestOutcome }[] = [];
    failWith: unknown = null;
    /** When set, notify() awaits this before finishing. */
    gate: Promise<void> | null = null;

    async notify(
        request: ClaudeRequest,
        outcome: ClaudeRequestOutcome
    ): Promise<void> {
        if (this.gate) await this.gate;
        if (this.failWith) throw this.failWith;
        this.notified.push({ request, outcome });
    }
}

const TOKEN = 'ghp_secret';
const REPO = 'owner/bifrost';

/** GitHub issue states keyed by number; missing numbers answer 404. */
type IssueReply =
    | { state: 'open' | 'closed'; state_reason?: string | null }
    | { status: number; message?: string }
    | Error;

function makeFetch(issues: Record<number, IssueReply>) {
    return vi.fn(async (url: string | URL | Request) => {
        const issueNumber = Number(String(url).split('/').pop());
        const reply = issues[issueNumber];
        if (reply instanceof Error) throw reply;
        if (reply === undefined) {
            return new Response(JSON.stringify({ message: 'Not Found' }), {
                status: 404,
            });
        }
        if ('status' in reply) {
            return new Response(JSON.stringify({ message: reply.message }), {
                status: reply.status,
            });
        }
        return new Response(JSON.stringify(reply), { status: 200 });
    });
}

const input = (
    overrides: Partial<TrackClaudeRequestInput> = {}
): TrackClaudeRequestInput => ({
    platform: 'discord',
    issueNumber: 26,
    issueUrl: 'https://github.com/owner/bifrost/issues/26',
    title: 'Notify on completion',
    userId: 'u1',
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    ...overrides,
});

describe('ClaudeRequestNotifyService', () => {
    let repo: MemoryClaudeRequestRepository;
    let discord: FakeNotifier;
    let fluxer: FakeNotifier;
    let issues: Record<number, IssueReply>;
    let fetchImpl: ReturnType<typeof makeFetch>;
    let service: ClaudeRequestNotifyService;

    beforeEach(() => {
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        vi.spyOn(logger, 'error').mockImplementation(() => logger);
        repo = new MemoryClaudeRequestRepository();
        discord = new FakeNotifier();
        fluxer = new FakeNotifier();
        issues = {};
        fetchImpl = makeFetch(issues);
        service = new ClaudeRequestNotifyService(repo, {
            token: TOKEN,
            repo: REPO,
            fetchImpl: fetchImpl as unknown as typeof fetch,
            maxAttempts: 3,
        });
        service.setNotifier('discord', discord);
        service.setNotifier('fluxer', fluxer);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is configured only with a token', () => {
        expect(service.isConfigured()).toBe(true);
        expect(
            new ClaudeRequestNotifyService(repo, {
                token: '',
                repo: REPO,
            }).isConfigured()
        ).toBe(false);
    });

    describe('track', () => {
        it('stores the request', async () => {
            await service.track(input());
            expect(repo.rows).toHaveLength(1);
            expect(repo.rows[0]).toMatchObject({
                ...input(),
                attempts: 0,
            });
        });

        it('caps very long titles', async () => {
            await service.track(input({ title: 'x'.repeat(500) }));
            expect(repo.rows[0].title.length).toBeLessThanOrEqual(200);
        });

        it('never rejects when the repository fails', async () => {
            repo.failCreate = true;
            await expect(service.track(input())).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('checkClosed', () => {
        it('asks GitHub with the expected URL and headers', async () => {
            issues[26] = { state: 'open' };
            await service.track(input());
            await service.checkClosed();

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [url, init] = fetchImpl.mock.calls[0] as unknown as [
                string,
                RequestInit,
            ];
            expect(url).toBe(
                'https://api.github.com/repos/owner/bifrost/issues/26'
            );
            expect(init.headers).toMatchObject({
                Authorization: `Bearer ${TOKEN}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'bifrost-bot',
            });
        });

        it('leaves open issues alone', async () => {
            issues[26] = { state: 'open' };
            await service.track(input());
            await service.checkClosed();
            expect(discord.notified).toEqual([]);
            expect(repo.rows).toHaveLength(1);
            expect(repo.rows[0].attempts).toBe(0);
        });

        it.each([
            ['completed', 'completed'],
            [null, 'completed'],
            [undefined, 'completed'],
            ['not_planned', 'not_planned'],
            ['duplicate', 'not_planned'],
        ])(
            'notifies and deletes when closed with state_reason %s',
            async (reason, outcome) => {
                issues[26] =
                    reason === undefined
                        ? { state: 'closed' }
                        : { state: 'closed', state_reason: reason };
                await service.track(input());
                await service.checkClosed();
                expect(discord.notified).toHaveLength(1);
                expect(discord.notified[0].outcome).toBe(outcome);
                expect(discord.notified[0].request).toMatchObject({
                    issueNumber: 26,
                    userId: 'u1',
                    channelId: 'c1',
                    messageId: 'm1',
                });
                expect(repo.rows).toEqual([]);
            }
        );

        it.each([404, 410])('drops the row on HTTP %i', async (status) => {
            issues[26] = { status };
            await service.track(input());
            await service.checkClosed();
            expect(discord.notified).toEqual([]);
            expect(repo.rows).toEqual([]);
            expect(logger.warn).toHaveBeenCalled();
        });

        it('retries network errors without counting attempts or leaking the token', async () => {
            issues[26] = new Error(`connect failed for ${TOKEN}`);
            await service.track(input());
            await service.checkClosed();
            await service.checkClosed();
            expect(repo.rows).toHaveLength(1);
            expect(repo.rows[0].attempts).toBe(0);
            const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
            expect(logged).toContain('***');
            expect(logged).not.toContain(TOKEN);

            issues[26] = { state: 'closed', state_reason: 'completed' };
            await service.checkClosed();
            expect(discord.notified).toHaveLength(1);
            expect(repo.rows).toEqual([]);
        });

        it('retries other HTTP errors without counting attempts', async () => {
            issues[26] = { status: 502, message: 'Bad Gateway' };
            await service.track(input());
            await service.checkClosed();
            expect(repo.rows).toHaveLength(1);
            expect(repo.rows[0].attempts).toBe(0);
            expect(discord.notified).toEqual([]);
        });

        it('fetches each issue once per tick', async () => {
            issues[26] = { state: 'closed', state_reason: 'completed' };
            issues[27] = { state: 'open' };
            await service.track(input());
            await service.track(input({ platform: 'fluxer', userId: 'u2' }));
            await service.track(input({ issueNumber: 27 }));
            await service.checkClosed();

            expect(fetchImpl).toHaveBeenCalledTimes(2);
            expect(discord.notified).toHaveLength(1);
            expect(fluxer.notified).toHaveLength(1);
            expect(fluxer.notified[0].request.userId).toBe('u2');
            expect(repo.rows.map((r) => r.issueNumber)).toEqual([27]);
        });

        it('skips platforms without a notifier, without asking GitHub', async () => {
            service.setNotifier('fluxer', null);
            issues[26] = { state: 'closed', state_reason: 'completed' };
            await service.track(input({ platform: 'fluxer' }));
            await service.checkClosed();
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(repo.rows).toHaveLength(1);

            service.setNotifier('fluxer', fluxer);
            await service.checkClosed();
            expect(fluxer.notified).toHaveLength(1);
            expect(repo.rows).toEqual([]);
        });

        it('does nothing without a token', async () => {
            service = new ClaudeRequestNotifyService(repo, {
                token: '',
                repo: REPO,
                fetchImpl: fetchImpl as unknown as typeof fetch,
            });
            service.setNotifier('discord', discord);
            await service.track(input());
            await service.checkClosed();
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(repo.rows).toHaveLength(1);
        });

        it('drops the row on a permanent notifier error', async () => {
            issues[26] = { state: 'closed', state_reason: 'completed' };
            discord.failWith = new ClaudeRequestNotifyError('gone', true);
            await service.track(input());
            await service.checkClosed();
            expect(repo.rows).toEqual([]);
            expect(logger.warn).toHaveBeenCalled();
        });

        it('bumps attempts on transient notifier errors, then gives up', async () => {
            issues[26] = { state: 'closed', state_reason: 'completed' };
            discord.failWith = new Error('ECONNRESET');
            await service.track(input());

            await service.checkClosed();
            expect(repo.rows[0].attempts).toBe(1);
            await service.checkClosed();
            expect(repo.rows[0].attempts).toBe(2);
            await service.checkClosed();
            expect(repo.rows).toEqual([]);
            expect(logger.error).toHaveBeenCalled();
        });

        it('treats a non-permanent ClaudeRequestNotifyError as transient', async () => {
            issues[26] = { state: 'closed', state_reason: 'completed' };
            discord.failWith = new ClaudeRequestNotifyError('later', false);
            await service.track(input());
            await service.checkClosed();
            expect(repo.rows[0].attempts).toBe(1);
        });

        it('never rejects when the repository fails', async () => {
            vi.spyOn(repo, 'findAll').mockRejectedValue(new Error('db down'));
            await expect(service.checkClosed()).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalled();
        });

        it('does not run two ticks at once', async () => {
            issues[26] = { state: 'closed', state_reason: 'completed' };
            await service.track(input());
            let release!: () => void;
            discord.gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            const first = service.checkClosed();
            const second = service.checkClosed();
            await second;
            expect(repo.findAllCalls).toBe(1);
            expect(discord.notified).toEqual([]);

            release();
            await first;
            expect(discord.notified).toHaveLength(1);
            expect(repo.rows).toEqual([]);

            discord.gate = null;
            await service.checkClosed();
            expect(repo.findAllCalls).toBe(2);
        });
    });

    describe('start / stop', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            service.stop();
            vi.useRealTimers();
        });

        it('ticks immediately, then every interval, until stopped', async () => {
            service = new ClaudeRequestNotifyService(repo, {
                token: TOKEN,
                repo: REPO,
                fetchImpl: fetchImpl as unknown as typeof fetch,
                pollIntervalMs: 1000,
            });
            service.setNotifier('discord', discord);
            issues[26] = { state: 'open' };
            await service.track(input());

            service.start();
            service.start(); // idempotent
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchImpl).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1000);
            expect(fetchImpl).toHaveBeenCalledTimes(2);

            service.stop();
            await vi.advanceTimersByTimeAsync(5000);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    });
});
