import { describe, expect, it, vi } from 'vitest';
import ClaudeRequestService, {
    ClaudeRequestInput,
    ClaudeRequestReplyInput,
    buildClaudeRequestReplyComment,
    describeClaudeRequestReplyResult,
    MAX_CLAUDE_REQUEST_LENGTH,
    MAX_CLAUDE_REQUEST_TITLE_LENGTH,
    buildClaudeRequestIssue,
    neutralizeGitHubMentions,
    stripClaudeRequestInvocation,
} from '../../../src/services/claudeRequest/ClaudeRequestService';

const TOKEN = 'ghp_supersecret';

const input: ClaudeRequestInput = {
    text: 'Add a dark mode\nwith sparkles',
    platform: 'discord',
    authorId: '123',
    authorName: 'alice',
};

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

function makeService(
    fetchImpl: ReturnType<typeof vi.fn>,
    extra: { token?: string; now?: () => number } = {}
) {
    return new ClaudeRequestService({
        token: extra.token ?? TOKEN,
        repo: 'FruitBoi/bifrost',
        label: 'claude',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: extra.now,
    });
}

const created = () =>
    jsonResponse(201, {
        number: 42,
        html_url: 'https://github.com/x/y/issues/42',
    });

describe('stripClaudeRequestInvocation', () => {
    it('strips the prefix and command', () => {
        expect(
            stripClaudeRequestInvocation('!b clauderequest do it', '!b ')
        ).toBe('do it');
    });
    it('is case-insensitive on the name', () => {
        expect(stripClaudeRequestInvocation('!b ClaudeRequest hi', '!b ')).toBe(
            'hi'
        );
    });
    it('keeps inner newlines and trims the ends', () => {
        expect(
            stripClaudeRequestInvocation(
                '!b clauderequest\n  a\n\n  b  \n',
                '!b '
            )
        ).toBe('a\n\n  b');
    });
    it('returns empty string for the bare command', () => {
        expect(stripClaudeRequestInvocation('!b clauderequest', '!b ')).toBe(
            ''
        );
    });
    it('returns null when not an invocation', () => {
        expect(
            stripClaudeRequestInvocation('!b clauderequestx', '!b ')
        ).toBeNull();
        expect(stripClaudeRequestInvocation('!b other', '!b ')).toBeNull();
        expect(
            stripClaudeRequestInvocation('clauderequest hi', '!b ')
        ).toBeNull();
    });
});

describe('neutralizeGitHubMentions', () => {
    it('breaks mentions but leaves emails alone', () => {
        expect(neutralizeGitHubMentions('hi @bob and a@b.com\n@carol')).toBe(
            'hi @​bob and a@b.com\n@​carol'
        );
    });
});

describe('buildClaudeRequestIssue', () => {
    it('uses the first non-empty line as the title', () => {
        const { title } = buildClaudeRequestIssue({
            ...input,
            text: '\n  \n  Make   it   fast \nmore',
        });
        expect(title).toBe('Make it fast');
    });
    it('truncates long titles with an ellipsis', () => {
        const { title } = buildClaudeRequestIssue({
            ...input,
            text: 'x'.repeat(200),
        });
        expect(title.length).toBe(MAX_CLAUDE_REQUEST_TITLE_LENGTH);
        expect(title.endsWith('…')).toBe(true);
    });
    it('does not truncate a title at the limit', () => {
        const text = 'y'.repeat(MAX_CLAUDE_REQUEST_TITLE_LENGTH);
        expect(buildClaudeRequestIssue({ ...input, text }).title).toBe(text);
    });
    it('builds the body with the full text and minimal context', () => {
        const { body } = buildClaudeRequestIssue(input);
        expect(body).toContain(
            '**Tell claude what you want**\nAdd a dark mode\nwith sparkles\n\n'
        );
        expect(body).toContain('**Additional context**');
        expect(body).toContain('Discord by alice (`123`)');
        expect(body).toContain('`clauderequest`');
        expect(body).not.toContain('#');
        expect(body).not.toContain('http');
    });
    it('includes guild, channel and message link when known', () => {
        const { body } = buildClaudeRequestIssue({
            ...input,
            platform: 'fluxer',
            guildName: 'Guild',
            channelName: 'general',
            messageUrl: 'https://example.com/m/1',
        });
        expect(body).toContain('Fluxer by alice');
        expect(body).toContain('in Guild #general');
        expect(body).toContain('https://example.com/m/1');
    });
    it('neutralizes mentions in title and body', () => {
        const { title, body } = buildClaudeRequestIssue({
            ...input,
            text: '@bob fix',
        });
        expect(title).toBe('@​bob fix');
        expect(body).toContain('@​bob fix');
    });
});

describe('ClaudeRequestService.submit', () => {
    it('reports not_configured without a token', async () => {
        const fetchImpl = vi.fn();
        const service = makeService(fetchImpl, { token: '' });
        expect(service.isConfigured()).toBe(false);
        expect(await service.submit(input)).toEqual({
            ok: false,
            reason: 'not_configured',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects empty and too long text', async () => {
        const fetchImpl = vi.fn();
        const service = makeService(fetchImpl);
        expect(await service.submit({ ...input, text: ' \n ' })).toMatchObject({
            reason: 'empty',
        });
        expect(
            await service.submit({
                ...input,
                text: 'a'.repeat(MAX_CLAUDE_REQUEST_LENGTH + 1),
            })
        ).toMatchObject({ reason: 'too_long' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('posts the issue and returns its number and url', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(created());
        const result = await makeService(fetchImpl).submit(input);
        expect(result).toEqual({
            ok: true,
            number: 42,
            url: 'https://github.com/x/y/issues/42',
            title: expect.any(String),
        });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(
            'https://api.github.com/repos/FruitBoi/bifrost/issues'
        );
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'bifrost-bot',
        });
        const payload = JSON.parse(init.body);
        expect(payload.labels).toEqual(['claude']);
        expect(payload.title).toBe('Add a dark mode');
        expect(payload.body).toContain('with sparkles');
    });

    it('applies a per-user cooldown that expires', async () => {
        let t = 1_000;
        const fetchImpl = vi.fn().mockImplementation(async () => created());
        const service = makeService(fetchImpl, { now: () => t });
        expect((await service.submit(input)).ok).toBe(true);

        t += 20_000;
        expect(await service.submit(input)).toEqual({
            ok: false,
            reason: 'cooldown',
            retryAfterMs: 40_000,
        });
        // Other user / platform unaffected.
        expect((await service.submit({ ...input, authorId: '999' })).ok).toBe(
            true
        );
        expect(
            (await service.submit({ ...input, platform: 'fluxer' })).ok
        ).toBe(true);

        t += 40_000;
        expect((await service.submit(input)).ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('returns github_error with status and message, without cooldown', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse(403, {
                    message: 'Resource not accessible by personal access token',
                })
            )
            .mockResolvedValueOnce(created());
        const service = makeService(fetchImpl);
        const result = await service.submit(input);
        expect(result).toEqual({
            ok: false,
            reason: 'github_error',
            detail: '403 Resource not accessible by personal access token',
        });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect((await service.submit(input)).ok).toBe(true);
    });

    it('handles non-JSON error bodies', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(new Response('<html>', { status: 502 }));
        expect(await makeService(fetchImpl).submit(input)).toEqual({
            ok: false,
            reason: 'github_error',
            detail: '502',
        });
    });

    it('handles thrown fetch errors and never leaks the token', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValue(new Error(`connect failed for ${TOKEN}`));
        const result = await makeService(fetchImpl).submit(input);
        expect(result).toMatchObject({ ok: false, reason: 'github_error' });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('lets only one of two simultaneous requests through', async () => {
        const fetchImpl = vi.fn().mockImplementation(async () => created());
        const service = makeService(fetchImpl, { now: () => 1_000 });

        const [first, second] = await Promise.all([
            service.submit(input),
            service.submit(input),
        ]);

        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, reason: 'cooldown' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('releases the cooldown when fetch throws', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(created());
        const service = makeService(fetchImpl, { now: () => 1_000 });

        expect((await service.submit(input)).ok).toBe(false);
        expect((await service.submit(input)).ok).toBe(true);
    });
});

const replyInput: ClaudeRequestReplyInput = {
    issueNumber: 42,
    text: '/swarm still broken, @bob\nsee logs',
    platform: 'discord',
    authorId: '123',
    authorName: 'alice',
    guildName: 'Guild',
    channelName: 'general',
    messageUrl: 'https://discord.com/channels/1/2/3',
};

const commented = () => jsonResponse(201, { id: 7 });
const reopenedIssue = () =>
    jsonResponse(200, {
        number: 42,
        state: 'open',
        title: 'Add a dark mode',
        html_url: 'https://github.com/x/y/issues/42',
    });

describe('buildClaudeRequestReplyComment', () => {
    it('opens with the attribution header, never the user text', () => {
        const body = buildClaudeRequestReplyComment(replyInput);
        const [first, blank, ...rest] = body.split('\n');
        expect(first).toBe(
            '**Reply from Discord by alice (`123`)** in Guild #general ([message](https://discord.com/channels/1/2/3))'
        );
        expect(blank).toBe('');
        expect(rest.join('\n')).toBe(
            '/swarm still broken, @\u200bbob\nsee logs\n'
        );
    });

    it('neutralizes mentions and newlines in the header', () => {
        const body = buildClaudeRequestReplyComment({
            ...replyInput,
            platform: 'fluxer',
            authorName: '@evil\n/swarm',
            guildName: null,
            channelName: null,
            messageUrl: null,
        });
        expect(body.split('\n')[0]).toBe(
            '**Reply from Fluxer by @\u200bevil /swarm (`123`)**'
        );
    });
});

describe('describeClaudeRequestReplyResult', () => {
    it('describes success, partial success and failures', () => {
        expect(
            describeClaudeRequestReplyResult({
                ok: true,
                number: 42,
                url: 'u',
                title: '',
                reopened: true,
            })
        ).toEqual({
            kind: 'success',
            description:
                "Posted your reply on [#42](u) and reopened it. I'll let you know here when it's done.",
        });
        expect(
            describeClaudeRequestReplyResult({
                ok: true,
                number: 42,
                url: 'u',
                title: '',
                reopened: false,
                detail: '403 nope',
            })
        ).toMatchObject({ kind: 'warning' });
        expect(
            describeClaudeRequestReplyResult({
                ok: false,
                reason: 'cooldown',
                retryAfterMs: 1_500,
            })
        ).toEqual({
            kind: 'error',
            description: 'Please wait 2 seconds before sending another reply.',
        });
        expect(
            describeClaudeRequestReplyResult({ ok: false, reason: 'empty' })
        ).toBeNull();
    });
});

describe('ClaudeRequestService.reopenWithReply', () => {
    it('comments, then reopens the issue', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(commented())
            .mockResolvedValueOnce(reopenedIssue());
        const result = await makeService(fetchImpl).reopenWithReply(replyInput);
        expect(result).toEqual({
            ok: true,
            number: 42,
            url: 'https://github.com/x/y/issues/42',
            title: 'Add a dark mode',
            reopened: true,
        });

        const [commentUrl, commentInit] = fetchImpl.mock.calls[0];
        expect(commentUrl).toBe(
            'https://api.github.com/repos/FruitBoi/bifrost/issues/42/comments'
        );
        expect(commentInit.method).toBe('POST');
        expect(commentInit.headers).toMatchObject({
            Authorization: `Bearer ${TOKEN}`,
            'User-Agent': 'bifrost-bot',
        });
        const { body } = JSON.parse(commentInit.body);
        expect(body).toBe(buildClaudeRequestReplyComment(replyInput));
        expect(body.startsWith('/swarm')).toBe(false);
        expect(body).not.toContain('@bob');

        const [patchUrl, patchInit] = fetchImpl.mock.calls[1];
        expect(patchUrl).toBe(
            'https://api.github.com/repos/FruitBoi/bifrost/issues/42'
        );
        expect(patchInit.method).toBe('PATCH');
        expect(JSON.parse(patchInit.body)).toEqual({
            state: 'open',
            state_reason: 'reopened',
        });
    });

    it('rejects unconfigured, empty and too long replies without fetching', async () => {
        const fetchImpl = vi.fn();
        expect(
            await makeService(fetchImpl, { token: '' }).reopenWithReply(
                replyInput
            )
        ).toEqual({ ok: false, reason: 'not_configured' });
        const service = makeService(fetchImpl);
        expect(
            await service.reopenWithReply({ ...replyInput, text: ' \n ' })
        ).toEqual({ ok: false, reason: 'empty' });
        expect(
            await service.reopenWithReply({
                ...replyInput,
                text: 'a'.repeat(MAX_CLAUDE_REQUEST_LENGTH + 1),
            })
        ).toEqual({ ok: false, reason: 'too_long' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does not reopen when the comment is rejected, and releases the cooldown', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
            .mockResolvedValueOnce(commented())
            .mockResolvedValueOnce(reopenedIssue());
        const service = makeService(fetchImpl, { now: () => 1_000 });
        expect(await service.reopenWithReply(replyInput)).toEqual({
            ok: false,
            reason: 'github_error',
            detail: '404 Not Found',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((await service.reopenWithReply(replyInput)).ok).toBe(true);
    });

    it('never leaks the token from a thrown fetch error', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValue(new Error(`connect failed for ${TOKEN}`));
        const result = await makeService(fetchImpl).reopenWithReply(replyInput);
        expect(result).toMatchObject({ ok: false, reason: 'github_error' });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('reports a posted comment whose reopen failed', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(commented())
            .mockResolvedValueOnce(
                jsonResponse(403, { message: 'Must have admin rights' })
            );
        expect(
            await makeService(fetchImpl).reopenWithReply(replyInput)
        ).toEqual({
            ok: true,
            number: 42,
            url: 'https://github.com/FruitBoi/bifrost/issues/42',
            title: '',
            reopened: false,
            detail: '403 Must have admin rights',
        });
    });

    it('shares the per-user cooldown with submit', async () => {
        let t = 1_000;
        const fetchImpl = vi
            .fn()
            .mockImplementation(async (_url: string, init: RequestInit) =>
                init.method === 'PATCH' ? reopenedIssue() : commented()
            );
        const service = makeService(fetchImpl, { now: () => t });
        expect((await service.reopenWithReply(replyInput)).ok).toBe(true);

        t += 10_000;
        expect(await service.reopenWithReply(replyInput)).toEqual({
            ok: false,
            reason: 'cooldown',
            retryAfterMs: 50_000,
        });
        expect(await service.submit(input)).toMatchObject({
            reason: 'cooldown',
        });
        expect(
            (await service.reopenWithReply({ ...replyInput, authorId: '9' })).ok
        ).toBe(true);

        t += 50_000;
        expect((await service.reopenWithReply(replyInput)).ok).toBe(true);
    });
});
