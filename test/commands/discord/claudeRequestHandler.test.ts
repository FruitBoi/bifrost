import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import ClaudeRequestDiscordCommandHandler from '../../../src/commands/discord/handlers/ClaudeRequestDiscordCommandHandler';
import ClaudeRequestService, {
    ClaudeRequestResult,
    MAX_CLAUDE_REQUEST_LENGTH,
} from '../../../src/services/claudeRequest/ClaudeRequestService';
import { EmbedColors } from '../../../src/utils/embeds';

const ALLOWED_ROLE = '1561105750388908139';
const client = { user: { id: 'bot' } } as unknown as Client;

interface FakeMessageOptions {
    content?: string;
    roles?: string[];
    bot?: boolean;
    inGuild?: boolean;
}

function makeMessage({
    content = '!b clauderequest do the thing',
    roles = [ALLOWED_ROLE],
    bot = false,
    inGuild = true,
}: FakeMessageOptions = {}) {
    const member = {
        id: 'author',
        roles: {
            has: (id: string) => roles.includes(id),
            cache: { has: (id: string) => roles.includes(id) },
        },
    };
    const guild = {
        id: 'guild-1',
        name: 'Test Guild',
        fetchMember: vi.fn().mockResolvedValue(member),
        members: { fetch: vi.fn().mockResolvedValue(member) },
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '2000',
        content,
        url: 'https://example.test/msg/2000',
        channelId: 'chan-1',
        guildId: inGuild ? 'guild-1' : null,
        author: { id: 'author', bot, username: 'author' },
        channel: { name: 'general' },
        guild: inGuild ? guild : null,
        inGuild: () => inGuild,
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        reply,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
    };
}

function makeService(
    result: ClaudeRequestResult = {
        ok: true,
        number: 42,
        url: 'https://github.com/o/r/issues/42',
    },
    configured = true
) {
    const submit = vi.fn().mockResolvedValue(result);
    const service = {
        isConfigured: () => configured,
        submit,
    } as unknown as ClaudeRequestService;
    return { service, submit };
}

function description(reply: ReturnType<typeof vi.fn>) {
    expect(reply).toHaveBeenCalledTimes(1);
    const embeds = reply.mock.calls[0][0].embeds;
    return embeds[0].data as { description?: string; color?: number };
}

describe('ClaudeRequestDiscordCommandHandler', () => {
    let submitMock: ReturnType<typeof makeService>;

    beforeEach(() => {
        submitMock = makeService();
    });

    function handler(service = submitMock.service) {
        return new ClaudeRequestDiscordCommandHandler(client, service, [
            ALLOWED_ROLE,
        ]);
    }

    it('rejects authors without an allowed role', async () => {
        const { message, reply } = makeMessage({ roles: [] });
        await handler().handleCommand(message, 'clauderequest', 'x');
        expect(description(reply).color).toBe(EmbedColors.Error);
        expect(description(reply).description).toContain('allowed');
        expect(submitMock.submit).not.toHaveBeenCalled();
    });

    it('rejects bots', async () => {
        const { message, reply } = makeMessage({ bot: true });
        await handler().handleCommand(message, 'clauderequest', 'x');
        expect(description(reply).color).toBe(EmbedColors.Error);
        expect(submitMock.submit).not.toHaveBeenCalled();
    });

    it('reports a missing GitHub token', async () => {
        const { service, submit } = makeService(undefined, false);
        const { message, reply } = makeMessage();
        await handler(service).handleCommand(message, 'clauderequest', 'x');
        expect(description(reply).description).toBe(
            'Claude requests are not configured on this bot (BF_GITHUB_TOKEN is not set).'
        );
        expect(submit).not.toHaveBeenCalled();
    });

    it('replies with the usage when the request is empty', async () => {
        const { message, reply } = makeMessage({
            content: '!b clauderequest   ',
        });
        await handler().handleCommand(message, 'clauderequest');
        expect(reply).toHaveBeenCalledTimes(1);
        expect(submitMock.submit).not.toHaveBeenCalled();
    });

    it('submits the request and replies with the issue link', async () => {
        const { message, reply } = makeMessage();
        await handler().handleCommand(
            message,
            'clauderequest',
            'do',
            'the',
            'thing'
        );
        expect(submitMock.submit).toHaveBeenCalledWith(
            expect.objectContaining({
                text: 'do the thing',
                platform: 'discord',
                authorId: 'author',
                authorName: 'author',
                guildName: 'Test Guild',
                channelName: 'general',
            })
        );
        const embed = description(reply);
        expect(embed.color).toBe(EmbedColors.Success);
        expect(embed.description).toContain(
            '[#42](https://github.com/o/r/issues/42)'
        );
    });

    it('passes multiline text through intact', async () => {
        const content = '!b clauderequest first line\n\n  - second\nthird';
        const { message } = makeMessage({ content });
        await handler().handleCommand(message, 'clauderequest', 'first');
        const input = submitMock.submit.mock.calls[0][0];
        expect(input.text).toBe('first line\n\n  - second\nthird');
    });

    it.each([
        [
            { ok: false, reason: 'cooldown', retryAfterMs: 12_100 },
            'Please wait 13 seconds before submitting another request.',
        ],
        [
            { ok: false, reason: 'github_error', detail: 'Bad credentials' },
            'Could not create the GitHub issue: Bad credentials',
        ],
        [
            { ok: false, reason: 'too_long' },
            `Requests can be at most ${MAX_CLAUDE_REQUEST_LENGTH} characters.`,
        ],
    ] as [ClaudeRequestResult, string][])(
        'explains the failure %j',
        async (result, expected) => {
            const { service } = makeService(result);
            const { message, reply } = makeMessage();
            await handler(service).handleCommand(message, 'clauderequest', 'x');
            const embed = description(reply);
            expect(embed.color).toBe(EmbedColors.Error);
            expect(embed.description).toBe(expected);
        }
    );

    it('reports a throwing service', async () => {
        const { service, submit } = makeService();
        submit.mockRejectedValue(new Error('boom'));
        const { message, reply } = makeMessage();
        await handler(service).handleCommand(message, 'clauderequest', 'x');
        expect(description(reply).description).toContain('boom');
    });
});
