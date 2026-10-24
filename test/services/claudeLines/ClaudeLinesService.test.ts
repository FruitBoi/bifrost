import { describe, expect, it, vi } from 'vitest';
import ClaudeLinesService, {
    isClaudeCommit,
} from '../../../src/services/claudeLines/ClaudeLinesService';

const TOKEN = 'ghp_supersecret';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

function node(
    n: number,
    additions: number,
    deletions: number,
    claude: boolean
) {
    return {
        oid: `sha${n}`,
        messageHeadline: `commit ${n}`,
        message: `commit ${n}\n\nbody\n\n${claude ? TRAILER : ''}`,
        additions,
        deletions,
        committedDate: `2026-01-0${n}T00:00:00Z`,
        url: `https://github.com/FruitBoi/bifrost/commit/sha${n}`,
    };
}

function page(nodes: unknown[], next: string | null) {
    return jsonResponse(200, {
        data: {
            repository: {
                defaultBranchRef: {
                    target: {
                        history: {
                            pageInfo: {
                                hasNextPage: next !== null,
                                endCursor: next,
                            },
                            nodes,
                        },
                    },
                },
            },
        },
    });
}

function makeService(
    fetchImpl: ReturnType<typeof vi.fn>,
    extra: {
        token?: string;
        now?: () => number;
        cacheMs?: number;
        maxPages?: number;
    } = {}
) {
    return new ClaudeLinesService({
        token: extra.token ?? TOKEN,
        repo: 'FruitBoi/bifrost',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: extra.now,
        cacheMs: extra.cacheMs,
        maxPages: extra.maxPages,
    });
}

describe('isClaudeCommit', () => {
    it('matches a Claude trailer', () => {
        expect(isClaudeCommit(`Subject\n\n${TRAILER}`)).toBe(true);
    });
    it('is case-insensitive', () => {
        expect(
            isClaudeCommit('Subject\n\nco-authored-by: claude <a@b.c>')
        ).toBe(true);
    });
    it('rejects other co-authors', () => {
        expect(isClaudeCommit('Subject\n\nCo-Authored-By: Alice <a@b.c>')).toBe(
            false
        );
    });
    it('rejects Claude mentioned only in the body', () => {
        expect(
            isClaudeCommit(
                'Subject\n\nAsked Claude to help; co-authored-by: claude'
            )
        ).toBe(false);
        expect(isClaudeCommit('Claude fixed this')).toBe(false);
    });
});

describe('ClaudeLinesService', () => {
    it('aggregates across pages and passes the cursor', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                page([node(3, 100, 10, true), node(2, 50, 5, false)], 'CUR1')
            )
            .mockResolvedValueOnce(page([node(1, 300, 20, true)], null));
        const result = await makeService(fetchImpl, {
            now: () => 5,
        }).getStats();

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { stats } = result;
        expect(stats.repo).toBe('FruitBoi/bifrost');
        expect(stats.commits).toBe(2);
        expect(stats.additions).toBe(400);
        expect(stats.deletions).toBe(30);
        expect(stats.totalCommits).toBe(3);
        expect(stats.totalAdditions).toBe(450);
        expect(stats.firstCommitAt).toBe('2026-01-01T00:00:00Z');
        expect(stats.latest?.sha).toBe('sha3');
        expect(stats.biggest?.sha).toBe('sha1');
        expect(stats.truncated).toBe(false);
        expect(stats.fetchedAt).toBe(5);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://api.github.com/graphql');
        expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(init.body).variables).toEqual({
            owner: 'FruitBoi',
            name: 'bifrost',
            cursor: null,
        });
        expect(
            JSON.parse(fetchImpl.mock.calls[1][1].body).variables.cursor
        ).toBe('CUR1');
    });

    it('truncates at maxPages', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(page([node(1, 1, 0, true)], 'A'))
            .mockResolvedValueOnce(page([node(2, 1, 0, true)], 'B'))
            .mockResolvedValueOnce(page([node(3, 1, 0, true)], null));
        const result = await makeService(fetchImpl, { maxPages: 2 }).getStats();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.ok && result.stats.truncated).toBe(true);
        expect(result.ok && result.stats.totalCommits).toBe(2);
    });

    it('caches until cacheMs elapses', async () => {
        let time = 0;
        const fetchImpl = vi
            .fn()
            .mockImplementation(async () => page([node(1, 1, 0, true)], null));
        const service = makeService(fetchImpl, {
            now: () => time,
            cacheMs: 1000,
        });
        await service.getStats();
        time = 999;
        await service.getStats();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        time = 1000;
        await service.getStats();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('shares one fetch between concurrent calls', async () => {
        const fetchImpl = vi
            .fn()
            .mockImplementation(async () => page([node(1, 1, 0, true)], null));
        const service = makeService(fetchImpl);
        const [a, b] = await Promise.all([
            service.getStats(),
            service.getStats(),
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it('returns not_configured without fetching', async () => {
        const fetchImpl = vi.fn();
        const service = makeService(fetchImpl, { token: '' });
        expect(service.isConfigured()).toBe(false);
        expect(await service.getStats()).toEqual({
            ok: false,
            reason: 'not_configured',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports HTTP errors and does not cache them', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(401, { message: 'Bad credentials' })
            )
            .mockResolvedValueOnce(page([node(1, 1, 0, true)], null));
        const service = makeService(fetchImpl);
        expect(await service.getStats()).toEqual({
            ok: false,
            reason: 'github_error',
            detail: '401 Bad credentials',
        });
        expect((await service.getStats()).ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('reports GraphQL errors', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            jsonResponse(200, {
                errors: [{ message: 'Could not resolve' }],
            })
        );
        expect(await makeService(fetchImpl).getStats()).toEqual({
            ok: false,
            reason: 'github_error',
            detail: 'Could not resolve',
        });
    });

    it('reports a missing repository', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                jsonResponse(200, { data: { repository: null } })
            );
        const result = await makeService(fetchImpl).getStats();
        expect(result.ok).toBe(false);
    });

    it('redacts the token from thrown errors', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValue(new Error(`boom with ${TOKEN} inside`));
        const result = await makeService(fetchImpl).getStats();
        expect(result).toEqual({
            ok: false,
            reason: 'github_error',
            detail: 'boom with *** inside',
        });
    });
});
