import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Client,
    Message,
    PermissionFlags,
    PermissionsBitField,
} from '@fluxerjs/core';
import CleanFluxerCommandHandler, {
    CLEAN_CONFIRMATION_TTL_MS,
} from '../../../src/commands/fluxer/handlers/CleanFluxerCommandHandler';

const TRIGGERS = ['?', '!'];
const MODERATOR_ROLE = '1561105750388908139';
const NOW = new Date('2026-10-20T12:00:00Z');
const TRIGGER_ID = '2000';
const TARGET_USER = '123456789012345678';

const client = { user: { id: 'bot' } } as unknown as Client;

interface FakeMessageOptions {
    content: string;
    inGuild?: boolean;
    bot?: boolean;
    webhookId?: string | null;
    /** Role IDs of the author; a moderator by default. */
    roles?: string[];
    /** The bot's own permissions in the channel; enough to clean by default. */
    botPermissions?: bigint[];
    /** Whether the author member can be fetched. */
    memberFound?: boolean;
    /** Channel history (any order); `messages.fetch` pages through it. */
    history?: ReturnType<typeof makeHistoryMessage>[];
    /** Channel kind: a guild text channel by default. */
    channel?: Partial<Record<string, unknown>>;
}

/** A message of the channel history, as the Fluxer library exposes it. */
function makeHistoryMessage(
    id: string,
    overrides: {
        authorId?: string;
        bot?: boolean;
        webhookId?: string | null;
        content?: string;
        createdAt?: Date;
        pinned?: boolean;
        attachments?: number;
    } = {}
) {
    const attachments = new Map<string, unknown>();
    for (let i = 0; i < (overrides.attachments ?? 0); i++) {
        attachments.set(`att-${i}`, {});
    }
    return {
        id,
        author: {
            id: overrides.authorId ?? 'someone',
            bot: overrides.bot ?? false,
        },
        webhookId: overrides.webhookId ?? null,
        content: overrides.content ?? `message ${id}`,
        createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 60_000),
        pinned: overrides.pinned ?? false,
        attachments,
    };
}

/** `count` recent messages by `authorId`, newest first, with descending IDs. */
function makeHistory(
    count: number,
    authorId = 'someone',
    startId = 1000
): ReturnType<typeof makeHistoryMessage>[] {
    return Array.from({ length: count }, (_, i) =>
        makeHistoryMessage(String(startId - i), { authorId })
    );
}

function makeMessage({
    content,
    inGuild = true,
    bot = false,
    webhookId = null,
    roles = [MODERATOR_ROLE],
    botPermissions = [
        PermissionFlags.ManageMessages,
        PermissionFlags.ReadMessageHistory,
    ],
    memberFound = true,
    history = [],
    channel: channelOverrides = {},
}: FakeMessageOptions) {
    const sorted = [...history].sort((a, b) =>
        Number(BigInt(b.id) - BigInt(a.id))
    );
    const fetch = vi.fn(
        async ({ limit, before }: { limit: number; before: string }) => {
            const page = sorted
                .filter((m) => BigInt(m.id) < BigInt(before))
                .slice(0, limit);
            return new Map(page.map((m) => [m.id, m]));
        }
    );
    const bulkDelete = vi.fn(async (ids: string[]) => ids);
    const channel = {
        id: 'chan-1',
        isGuild: () => true,
        isText: () => true,
        isThread: () => false,
        messages: { fetch },
        bulkDelete,
        ...channelOverrides,
    };

    const botBits = new PermissionsBitField(botPermissions);
    const botMember = {
        id: 'bot',
        permissions: botBits,
        permissionsIn: vi.fn().mockReturnValue(botBits),
    };
    const author = {
        id: 'author',
        roles: { has: (id: string) => roles.includes(id) },
    };
    const guild = {
        id: 'guild-1',
        members: { me: botMember },
        fetchMember: vi.fn(async (id: string) => {
            if (id === 'author' && memberFound) return author;
            throw new Error('Unknown Member');
        }),
    };

    const sent = { delete: vi.fn().mockResolvedValue(undefined) };
    const reply = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(sent);
    const deleteInvocation = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: TRIGGER_ID,
        content,
        channelId: 'chan-1',
        guildId: inGuild ? 'guild-1' : null,
        author: { id: 'author', bot, username: 'author' },
        webhookId,
        channel,
        guild: inGuild ? guild : null,
        resolveChannel: vi.fn().mockResolvedValue(channel),
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        reply,
        send,
        delete: deleteInvocation,
    };
    return {
        message: message as unknown as Message,
        reply,
        send,
        sent,
        deleteInvocation,
        fetch,
        bulkDelete,
    };
}

/** Descriptions of every embed in the first call of `fn`. */
function embedDescriptions(fn: ReturnType<typeof vi.fn>): string[] {
    expect(fn).toHaveBeenCalled();
    const options = fn.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data: { description?: string } }) => embed.data.description
    );
}

function embedTitles(fn: ReturnType<typeof vi.fn>): (string | undefined)[] {
    const options = fn.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data: { title?: string } }) => embed.data.title
    );
}

describe('CleanFluxerCommandHandler', () => {
    let handler: CleanFluxerCommandHandler;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        handler = new CleanFluxerCommandHandler(
            client,
            [MODERATOR_ROLE],
            TRIGGERS
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses outside servers', async () => {
        const { message, reply, fetch } = makeMessage({
            content: '?clean 3',
            inGuild: false,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(embedDescriptions(reply)).toEqual([
            'This command must be used in a server.',
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses bots and webhooks', async () => {
        const asBot = makeMessage({ content: '?clean 3', bot: true });
        await handler.handleCommand(asBot.message, 'clean', '3');
        expect(embedDescriptions(asBot.reply)).toEqual([
            'Bots cannot use this command.',
        ]);

        const asWebhook = makeMessage({
            content: '?clean 3',
            webhookId: 'wh-1',
        });
        await handler.handleCommand(asWebhook.message, 'clean', '3');
        expect(embedDescriptions(asWebhook.reply)).toEqual([
            'Bots cannot use this command.',
        ]);
    });

    it('refuses members without a moderator role', async () => {
        const { message, reply, fetch, bulkDelete } = makeMessage({
            content: '?clean 3',
            roles: ['some-other-role'],
            history: makeHistory(3),
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(embedDescriptions(reply)).toEqual([
            'You do not have a role that is allowed to use this command.',
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(bulkDelete).not.toHaveBeenCalled();
    });

    it('reports when the author member cannot be fetched', async () => {
        const { message, reply, fetch } = makeMessage({
            content: '?clean 3',
            memberFound: false,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(embedDescriptions(reply)).toEqual([
            'Could not fetch your member information.',
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts members holding any of the moderator roles', async () => {
        handler = new CleanFluxerCommandHandler(
            client,
            ['role-a', MODERATOR_ROLE],
            TRIGGERS
        );
        const { message, reply, bulkDelete } = makeMessage({
            content: '?clean 1',
            history: makeHistory(1),
        });
        await handler.handleCommand(message, 'clean', '1');
        expect(reply).not.toHaveBeenCalled();
        expect(bulkDelete).toHaveBeenCalledWith(['1000']);
    });

    it('shows the usage when the count is missing', async () => {
        const { message, reply, fetch } = makeMessage({ content: '?clean' });
        await handler.handleCommand(message, 'clean');
        expect(embedTitles(reply)).toEqual(['Command Usage']);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('explains an invalid count and shows the usage', async () => {
        const { message, reply, fetch } = makeMessage({
            content: '!b clean lots',
        });
        await handler.handleCommand(message, 'clean', 'lots');
        expect(embedDescriptions(reply)[0]).toBe(
            '`lots` is not a valid number of messages; give a whole number from 1 to 1000.'
        );
        expect(embedTitles(reply)[1]).toBe('Command Usage');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('strips backticks from echoed arguments', async () => {
        const { message, reply } = makeMessage({
            content: '?clean 3 -`x`',
        });
        await handler.handleCommand(message, 'clean', '3', '-`x`');
        expect(embedDescriptions(reply)[0]).toBe('Unknown switch `-x`.');
    });

    it('reads quoted switch values from the raw content', async () => {
        const { message, bulkDelete } = makeMessage({
            content: '?clean 2 -r "foo bar"',
            history: [
                makeHistoryMessage('1000', { content: 'foo bar baz' }),
                makeHistoryMessage('999', { content: 'nothing' }),
                makeHistoryMessage('998', { content: 'a foo bar' }),
            ],
        });
        await handler.handleCommand(
            message,
            'clean',
            '2',
            '-r',
            '"foo',
            'bar"'
        );
        expect(bulkDelete).toHaveBeenCalledWith(['1000', '998']);
    });

    it('cleans the newest messages and confirms briefly', async () => {
        const {
            message,
            reply,
            send,
            sent,
            deleteInvocation,
            fetch,
            bulkDelete,
        } = makeMessage({
            content: '?clean 3',
            history: makeHistory(5),
        });
        await handler.handleCommand(message, 'clean', '3');

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith({ limit: 3, before: TRIGGER_ID });
        expect(bulkDelete).toHaveBeenCalledWith(['1000', '999', '998']);
        expect(reply).not.toHaveBeenCalled();
        expect(embedDescriptions(send)).toEqual(["Deleted 3 message(s)! :')"]);

        // The confirmation removes itself after a while, the trigger at once
        // (DELETE_INVOCATION is off in tests, so the handler deletes it).
        expect(deleteInvocation).toHaveBeenCalledTimes(1);
        expect(sent.delete).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CLEAN_CONFIRMATION_TTL_MS);
        expect(sent.delete).toHaveBeenCalledTimes(1);
    });

    it('leaves the trigger to the dispatcher when DELETE_INVOCATION is on', async () => {
        vi.resetModules();
        vi.doMock('../../../src/utils/env', async (importOriginal) => ({
            ...(await importOriginal<
                typeof import('../../../src/utils/env')
            >()),
            DELETE_INVOCATION: true,
        }));
        try {
            const { default: Handler } =
                await import('../../../src/commands/fluxer/handlers/CleanFluxerCommandHandler');
            const mocked = new Handler(client, [MODERATOR_ROLE], TRIGGERS);
            const { message, deleteInvocation, bulkDelete } = makeMessage({
                content: '?clean 1',
                history: makeHistory(1),
            });
            await mocked.handleCommand(message, 'clean', '1');
            expect(bulkDelete).toHaveBeenCalledWith(['1000']);
            expect(deleteInvocation).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('../../../src/utils/env');
            vi.resetModules();
        }
    });

    it('only selects the given user and pages when the first page is short', async () => {
        const history = [
            ...makeHistory(100, 'noise', 1000), // 1000..901
            makeHistoryMessage('900', { authorId: TARGET_USER }),
            makeHistoryMessage('899', { authorId: 'noise' }),
            makeHistoryMessage('898', { authorId: TARGET_USER }),
            makeHistoryMessage('897', { authorId: TARGET_USER }),
        ];
        const { message, send, fetch, bulkDelete } = makeMessage({
            content: `?clean 5 <@${TARGET_USER}>`,
            history,
        });
        await handler.handleCommand(message, 'clean', '5', `<@${TARGET_USER}>`);

        expect(fetch).toHaveBeenNthCalledWith(1, {
            limit: 100,
            before: TRIGGER_ID,
        });
        expect(fetch).toHaveBeenNthCalledWith(2, { limit: 100, before: '901' });
        expect(bulkDelete).toHaveBeenCalledWith(['900', '898', '897']);
        expect(embedDescriptions(send)).toEqual(["Deleted 3 message(s)! :')"]);
    });

    it('deletes messages older than two weeks (no age limit on Fluxer)', async () => {
        const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
        const { message, bulkDelete } = makeMessage({
            content: '?clean 2',
            history: [
                makeHistoryMessage('1000', { createdAt: old }),
                makeHistoryMessage('999', { createdAt: old }),
            ],
        });
        await handler.handleCommand(message, 'clean', '2');
        expect(bulkDelete).toHaveBeenCalledWith(['1000', '999']);
    });

    it('says so when nothing matches', async () => {
        const { message, reply, send, sent, bulkDelete, deleteInvocation } =
            makeMessage({
                content: '?clean 3 -bots',
                history: makeHistory(3),
            });
        await handler.handleCommand(message, 'clean', '3', '-bots');
        expect(bulkDelete).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
        expect(embedDescriptions(send)).toEqual(['No messages matched.']);
        expect(deleteInvocation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(CLEAN_CONFIRMATION_TTL_MS);
        expect(sent.delete).toHaveBeenCalledTimes(1);
    });

    it('requires Manage Messages and Read Message History for the bot', async () => {
        const { message, reply, fetch, bulkDelete } = makeMessage({
            content: '?clean 3',
            botPermissions: [PermissionFlags.ReadMessageHistory],
            history: makeHistory(3),
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(embedDescriptions(reply)).toEqual([
            'I need the `Manage Messages` and `Read Message History` permissions in this channel to clean it.',
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(bulkDelete).not.toHaveBeenCalled();
    });

    it('only cleans text channels and threads', async () => {
        const { message, reply, fetch } = makeMessage({
            content: '?clean 3',
            channel: { isText: () => false, isThread: () => false },
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(embedDescriptions(reply)).toEqual([
            'Messages can only be cleaned in text channels and threads.',
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('cleans threads too', async () => {
        const { message, bulkDelete } = makeMessage({
            content: '?clean 1',
            channel: { isText: () => false, isThread: () => true },
            history: makeHistory(1),
        });
        await handler.handleCommand(message, 'clean', '1');
        expect(bulkDelete).toHaveBeenCalledWith(['1000']);
    });

    it('reports API failures', async () => {
        const { message, reply, send, bulkDelete, deleteInvocation } =
            makeMessage({
                content: '?clean 2',
                history: makeHistory(2),
            });
        bulkDelete.mockRejectedValueOnce(new Error('Missing Permissions'));
        await handler.handleCommand(message, 'clean', '2');
        expect(embedDescriptions(reply)).toEqual([
            'Failed to delete messages: Missing Permissions',
        ]);
        expect(send).not.toHaveBeenCalled();
        expect(deleteInvocation).not.toHaveBeenCalled();
    });

    it('deletes more than 100 messages in batches of 100', async () => {
        const history = makeHistory(260);
        const { message, reply, send, bulkDelete } = makeMessage({
            content: '?clean 250',
            history,
        });
        await handler.handleCommand(message, 'clean', '250');
        expect(reply).not.toHaveBeenCalled();
        const ids = history.slice(0, 250).map((m) => m.id);
        expect(bulkDelete.mock.calls).toEqual([
            [ids.slice(0, 100)],
            [ids.slice(100, 200)],
            [ids.slice(200, 250)],
        ]);
        expect(embedDescriptions(send)).toEqual([
            "Deleted 250 message(s)! :')",
        ]);
    });

    it('retries a batch that Fluxer rate-limits', async () => {
        const { message, reply, send, bulkDelete } = makeMessage({
            content: '?clean 150',
            history: makeHistory(150),
        });
        bulkDelete
            .mockImplementationOnce(async (ids: string[]) => ids)
            .mockRejectedValueOnce(
                Object.assign(new Error('Too Many Requests'), {
                    name: 'RateLimitError',
                    statusCode: 429,
                    retryAfter: 2,
                })
            );
        const done = handler.handleCommand(message, 'clean', '150');
        await vi.advanceTimersByTimeAsync(2_000);
        await done;
        expect(bulkDelete).toHaveBeenCalledTimes(3);
        expect(bulkDelete.mock.calls[2][0]).toEqual(
            bulkDelete.mock.calls[1][0]
        );
        expect(reply).not.toHaveBeenCalled();
        expect(embedDescriptions(send)).toEqual([
            "Deleted 150 message(s)! :')",
        ]);
    });

    it('reports how many were deleted when a later batch fails', async () => {
        const { message, reply, send, bulkDelete, deleteInvocation } =
            makeMessage({
                content: '?clean 150',
                history: makeHistory(150),
            });
        bulkDelete
            .mockImplementationOnce(async (ids: string[]) => ids)
            .mockRejectedValueOnce(new Error('Missing Permissions'));
        await handler.handleCommand(message, 'clean', '150');
        expect(embedDescriptions(reply)).toEqual([
            'Deleted 100 message(s), then failed to delete the rest: Missing Permissions',
        ]);
        expect(send).not.toHaveBeenCalled();
        expect(deleteInvocation).not.toHaveBeenCalled();
    });
});
