import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeployAnnounceService, {
    DEPLOY_ANNOUNCE_STATE_KEY,
    DEPLOY_MESSAGE_MAX_LENGTH,
    buildDeployMessage,
    issueRefs,
} from '../../../src/services/deployAnnounce/DeployAnnounceService';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const REPO = 'FruitBoi/bifrost';
const API = `https://api.github.com/repos/${REPO}`;
const PREV = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MID = 'c'.repeat(40);

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

/** Fake fetch answering by URL; unknown URLs get a 404. */
function fakeFetch(routes: Record<string, () => Response>) {
    return vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const route = routes[url];
        return route ? route() : jsonResponse(404, { message: 'Not Found' });
    });
}

function memoryState(initial: string | null = null) {
    const store = new Map<string, string>();
    if (initial !== null) store.set(DEPLOY_ANNOUNCE_STATE_KEY, initial);
    return {
        store,
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
    };
}

function ghCommit(sha: string, message: string) {
    return { sha, commit: { message } };
}

function issue(number: number, title: string, labels: string[], pr = false) {
    return {
        number,
        title,
        labels: labels.map((name) => ({ name })),
        ...(pr ? { pull_request: { url: 'x' } } : {}),
    };
}

function makeService(
    fetchImpl: ReturnType<typeof vi.fn>,
    state: ReturnType<typeof memoryState>,
    commit: string | null = HEAD,
    token: string | null = null
) {
    return new DeployAnnounceService({
        repo: REPO,
        token,
        commit,
        label: 'claude',
        state,
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });
}

/** A `send` mock whose calls record the posted content. */
function sender() {
    return vi.fn<(content: string) => Promise<void>>(async () => {});
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('issueRefs', () => {
    it('finds #n and same-repo refs, ignoring other repos', () => {
        expect(
            issueRefs(
                'Fix (#3)\n\nRefs #47, FruitBoi/bifrost#12 and other/repo#9',
                REPO
            )
        ).toEqual([3, 47, 12]);
    });
    it('matches the repo case-insensitively and skips anchors', () => {
        expect(issueRefs('fruitboi/BIFROST#5 see a.md#1 x#2', REPO)).toEqual([
            5,
        ]);
    });
});

describe('buildDeployMessage', () => {
    it('starts with "Claude wins again" and lists commits and issues', () => {
        const message = buildDeployMessage({
            repo: REPO,
            commit: HEAD,
            previous: PREV,
            commits: [ghCommit(HEAD, 'Second\n\nbody')].map((c) => ({
                sha: c.sha,
                message: c.commit.message,
            })),
            issues: [{ number: 47, title: 'Deploy message' }],
        });
        expect(message.startsWith('Claude wins again')).toBe(true);
        expect(message).toContain('`bbbbbbb`');
        expect(message).toContain(
            `<https://github.com/${REPO}/compare/aaaaaaa...bbbbbbb>`
        );
        expect(message).toContain('Second · `bbbbbbb`');
        expect(message).not.toContain('body');
        expect(message).toContain(
            `#47 Deploy message · <https://github.com/${REPO}/issues/47>`
        );
    });

    it('neutralises @ mentions in headlines and titles', () => {
        const message = buildDeployMessage({
            repo: REPO,
            commit: HEAD,
            commits: [{ sha: HEAD, message: 'Ping @everyone and <@123>' }],
            issues: [{ number: 1, title: 'Hi @here' }],
        });
        expect(message).not.toMatch(/@everyone|@here|<@123>/);
        expect(message).toContain('@​everyone');
        expect(message).toContain('@​here');
    });

    it('stays within 2000 characters with many long commits', () => {
        const commits = Array.from({ length: 80 }, (_, i) => ({
            sha: `${i}`.padStart(40, '0'),
            message: `Commit ${i} ${'x'.repeat(300)}`,
        }));
        const issues = Array.from({ length: 10 }, (_, i) => ({
            number: i + 1,
            title: 'y'.repeat(300),
        }));
        const message = buildDeployMessage({
            repo: REPO,
            commit: HEAD,
            previous: PREV,
            commits,
            totalCommits: 300,
            issues,
        });
        expect(message.length).toBeLessThanOrEqual(DEPLOY_MESSAGE_MAX_LENGTH);
        expect(message.startsWith('Claude wins again')).toBe(true);
        expect(message).toContain('Commits shipped (300)');
        expect(message).toMatch(/…and \d+ more/);
        expect(message).not.toContain('x'.repeat(200));
        // The closing emoji line survives.
        expect(message.trimEnd().endsWith('🧠')).toBe(true);
    });

    it('shows the total when GitHub listed only part of the range', () => {
        const message = buildDeployMessage({
            repo: REPO,
            commit: HEAD,
            previous: PREV,
            commits: [{ sha: HEAD, message: 'One' }],
            totalCommits: 3,
            issues: [],
        });
        expect(message).toContain('…and 2 more');
        expect(message).not.toContain('Claude requests fixed');
    });
});

describe('DeployAnnounceService', () => {
    it('does nothing without a commit', async () => {
        const fetchImpl = fakeFetch({});
        const state = memoryState();
        const send = vi.fn(async () => {});
        await makeService(fetchImpl, state, '').announce(send);
        await makeService(fetchImpl, state, null).announce(send);
        expect(send).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(state.get).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalled();
    });

    it('skips a plain restart of the same commit', async () => {
        const fetchImpl = fakeFetch({});
        const state = memoryState(HEAD.toUpperCase());
        const send = vi.fn(async () => {});
        await makeService(fetchImpl, state).announce(send);
        expect(send).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalled();
    });

    it('announces the head commit on the first deploy and stores it', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(
                    200,
                    ghCommit(HEAD, 'Add deploy message\n\nRefs #47')
                ),
            [`${API}/issues/47`]: () =>
                jsonResponse(200, issue(47, 'Deploy message', ['claude'])),
        });
        const state = memoryState();
        const send = sender();
        await makeService(fetchImpl, state).announce(send);

        expect(send).toHaveBeenCalledTimes(1);
        const content = send.mock.calls[0][0];
        expect(content.startsWith('Claude wins again')).toBe(true);
        expect(content).toContain('Add deploy message · `bbbbbbb`');
        expect(content).toContain(
            `<https://github.com/${REPO}/commit/${HEAD}>`
        );
        expect(content).toContain('#47 Deploy message');
        expect(state.store.get(DEPLOY_ANNOUNCE_STATE_KEY)).toBe(HEAD);
        expect(
            fetchImpl.mock.calls.some(([url]) =>
                String(url).includes('/compare/')
            )
        ).toBe(false);
    });

    it('lists the compared commits newest first with labelled issues only', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/compare/${PREV}...${HEAD}`]: () =>
                jsonResponse(200, {
                    status: 'ahead',
                    total_commits: 2,
                    commits: [
                        ghCommit(MID, 'Older change\n\nRefs #10\nRefs #11'),
                        ghCommit(
                            HEAD,
                            'Newer change\n\nRefs #47, other/repo#99 (#12)\nRefs #10'
                        ),
                    ],
                }),
            [`${API}/issues/47`]: () =>
                jsonResponse(
                    200,
                    issue(47, 'Deploy message', ['Claude', 'bug'])
                ),
            [`${API}/issues/10`]: () =>
                jsonResponse(200, issue(10, 'Open request', ['claude'])),
            [`${API}/issues/11`]: () =>
                jsonResponse(200, issue(11, 'Not a request', ['bug'])),
            [`${API}/issues/12`]: () =>
                jsonResponse(
                    200,
                    issue(12, 'A pull request', ['claude'], true)
                ),
        });
        const state = memoryState(PREV);
        const send = sender();
        await makeService(fetchImpl, state, HEAD, 'tok').announce(send);

        const content = send.mock.calls[0][0];
        expect(content).toContain('Commits shipped (2)');
        expect(content.indexOf('Newer change')).toBeLessThan(
            content.indexOf('Older change')
        );
        expect(content).toContain('#10 Open request');
        expect(content).toContain('#47 Deploy message');
        expect(content.indexOf('#10 Open request')).toBeLessThan(
            content.indexOf('#47 Deploy message')
        );
        expect(content).not.toContain('Not a request');
        expect(content).not.toContain('A pull request');
        expect(content).toContain('Claude requests fixed (2)');
        expect(
            fetchImpl.mock.calls.some(([url]) =>
                String(url).includes('/issues/99')
            )
        ).toBe(false);
        // Each issue is looked up once.
        expect(
            fetchImpl.mock.calls.filter(([url]) =>
                String(url).endsWith('/issues/10')
            )
        ).toHaveLength(1);

        const init = fetchImpl.mock.calls[0][1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok');
        expect(headers.Accept).toBe('application/vnd.github+json');
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(state.store.get(DEPLOY_ANNOUNCE_STATE_KEY)).toBe(HEAD);
    });

    it('falls back to the head commit when the compare is a 404', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(200, ghCommit(HEAD, 'Force-pushed')),
        });
        const state = memoryState(PREV);
        const send = sender();
        await makeService(fetchImpl, state).announce(send);

        const content = send.mock.calls[0][0];
        expect(content).toContain('Force-pushed · `bbbbbbb`');
        expect(content).toContain(`/commit/${HEAD}>`);
        expect(content).not.toContain('/compare/');
        expect(state.store.get(DEPLOY_ANNOUNCE_STATE_KEY)).toBe(HEAD);
    });

    it('falls back to the head commit on a rollback', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/compare/${PREV}...${HEAD}`]: () =>
                jsonResponse(200, {
                    status: 'behind',
                    total_commits: 0,
                    commits: [],
                }),
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(200, ghCommit(HEAD, 'Old commit')),
        });
        const send = sender();
        await makeService(fetchImpl, memoryState(PREV)).announce(send);
        expect(send.mock.calls[0][0]).toContain('Old commit');
    });

    it('still announces a minimal message when GitHub is down', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('fetch failed');
        });
        const state = memoryState(PREV);
        const send = sender();
        await makeService(fetchImpl, state).announce(send);

        expect(send).toHaveBeenCalledTimes(1);
        const content = send.mock.calls[0][0];
        expect(content.startsWith('Claude wins again')).toBe(true);
        expect(content).toContain('`bbbbbbb`');
        expect(content).toContain("Couldn't reach GitHub");
        expect(state.store.get(DEPLOY_ANNOUNCE_STATE_KEY)).toBe(HEAD);
    });

    it('leaves the state unchanged when sending fails', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(200, ghCommit(HEAD, 'Change')),
        });
        const state = memoryState(PREV);
        const send = vi.fn(async () => {
            throw new Error('Missing Access');
        });
        await expect(
            makeService(fetchImpl, state).announce(send)
        ).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledTimes(1);
        expect(state.set).not.toHaveBeenCalled();
        expect(state.store.get(DEPLOY_ANNOUNCE_STATE_KEY)).toBe(PREV);
        expect(logger.error).toHaveBeenCalled();
    });

    it('skips when the stored commit cannot be read', async () => {
        const fetchImpl = fakeFetch({});
        const state = memoryState();
        state.get.mockRejectedValueOnce(new Error('db down'));
        const send = vi.fn(async () => {});
        await makeService(fetchImpl, state).announce(send);
        expect(send).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });

    it('announces only once per process', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(200, ghCommit(HEAD, 'Change')),
        });
        const state = memoryState();
        const send = vi.fn(async () => {});
        const service = makeService(fetchImpl, state);
        await Promise.all([
            service.announce(send),
            service.announce(send),
            service.announce(send),
        ]);
        await service.announce(send);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('redacts the token from logged errors', async () => {
        const fetchImpl = fakeFetch({
            [`${API}/commits/${HEAD}`]: () =>
                jsonResponse(200, ghCommit(HEAD, 'Change')),
        });
        const send = vi.fn(async () => {
            throw new Error('bad secret-token');
        });
        await makeService(
            fetchImpl,
            memoryState(),
            HEAD,
            'secret-token'
        ).announce(send);
        expect(
            JSON.stringify(vi.mocked(logger.error).mock.calls)
        ).not.toContain('secret-token');
    });
});
