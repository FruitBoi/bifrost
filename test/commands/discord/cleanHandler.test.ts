import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import CleanDiscordCommandHandler, {
    CLEAN_CONFIRMATION_DELETE_DELAY_MS,
} from '../../../src/commands/discord/handlers/CleanDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import { DISCORD_BULK_DELETE_MAX_AGE_MS } from '../../../src/services/clean/cleanFilter';

const TRIGGERS = ['?', '!'];
const MOD_ROLE = '1561105750388908139';
const NOW = new Date('2026-10-20T12:00:00Z');
const TRIGGER_ID = '2000000000000000000';
const MINUTE = 60 * 1000;

interface FakeHistoryMessage {
    id: string;
    author: { id: string; bot: boolean };
    content: string;
    createdAt: Date;
    pinned: boolean;
    attachments: Map<string, unknown>;
}

interface HistoryMessageOptions {
    authorId?: string;
    bot?: boolean;
    content?: string;
    /** Age in minutes relative to NOW. */
    ageMinutes?: number;
    pinned?: boolean;
    attachments?: number;
}

/**
 * Builds a channel history, newest first: message `i` has a descending
 * snowflake-like ID and is `i + 1` minutes old unless overridden.
 */
function makeHistory(
    count: number,
    options: (index: number) => HistoryMessageOptions = () => ({})
): FakeHistoryMessage[] {
    const history: FakeHistoryMessage[] = [];
    for (let i = 0; i < count; i++) {
        const {
            authorId = 'someone',
            bot = false,
            content = `message ${i}`,
            ageMinutes = i + 1,
            pinned = false,
            attachments = 0,
        } = options(i);
        history.push({
            id: String(1_000_000_000_000_000_000n - BigInt(i)),
            author: { id: authorId, bot },
            content,
            createdAt: new Date(NOW.getTime() - ageMinutes * MINUTE),
            pinned,
            attachments: new Map(
                Array.from({ length: attachments }, (_, n) => [String(n), {}])
            ),
        });
    }
    return history;
}

function makeMember(roleIds: string[] = [MOD_ROLE]) {
    return { roles: { cache: new Set(roleIds) } };
}

function makeBotMember(
    permissions: bigint[] = [
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
    ]
) {
    const bits = new PermissionsBitField(permissions);
    return { permissionsIn: vi.fn().mockReturnValue(bits) };
}

function makeChannel(
    history: FakeHistoryMessage[] = [],
    overrides: Partial<Record<string, unknown>> = {}
) {
    const fetch = vi.fn(
        async ({ limit, before }: { limit: number; before: string }) => {
            const page = history
                .filter((m) => BigInt(m.id) < BigInt(before))
                .slice(0, limit);
            return new Map(page.map((m) => [m.id, m]));
        }
    );
    const bulkDelete = vi.fn(async (ids: string[]) => {
        return new Map(ids.map((id) => [id, { id }]));
    });
    const confirmationDelete = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ delete: confirmationDelete });
    return {
        id: 'chan-1',
        isTextBased: () => true,
        isVoiceBased: () => false,
        isSendable: () => true,
        messages: { fetch },
        bulkDelete,
        send,
        confirmationDelete,
        ...overrides,
    };
}

interface FakeMessageOptions {
    content: string;
    inGuild?: boolean;
    bot?: boolean;
    member?: ReturnType<typeof makeMember> | null;
    botMember?: ReturnType<typeof makeBotMember> | null;
    channel?: ReturnType<typeof makeChannel>;
}

function makeMessage({
    content,
    inGuild = true,
    bot = false,
    member = makeMember(),
    botMember = makeBotMember(),
    channel = makeChannel(),
}: FakeMessageOptions) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: TRIGGER_ID,
        content,
        channelId: channel.id,
        guildId: inGuild ? 'guild-1' : null,
        inGuild: () => inGuild,
        author: {
            id: 'author',
            bot,
            username: 'author',
            displayAvatarURL: () => 'https://example.invalid/a.png',
        },
        channel,
        guild: inGuild
            ? {
                  members: {
                      me: botMember,
                      fetchMe: vi.fn().mockResolvedValue(botMember),
                      fetch: vi.fn(async (id: string) => {
                          if (id !== 'author' || !member) {
                              throw new Error('Unknown Member');
                          }
                          return member;
                      }),
                  },
              }
            : null,
        reply,
        delete: del,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
        delete: del,
        channel,
    };
}

/** Descriptions of every embed sent in the first reply. */
function replied(reply: ReturnType<typeof vi.fn>): string[] {
    expect(reply).toHaveBeenCalled();
    const options = reply.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data: { description?: string } }) => embed.data.description
    );
}

function titles(reply: ReturnType<typeof vi.fn>): (string | undefined)[] {
    const options = reply.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data: { title?: string } }) => embed.data.title
    );
}

/** Descriptions of the embeds in the first message sent to the channel. */
function sent(send: ReturnType<typeof vi.fn>): string[] {
    expect(send).toHaveBeenCalled();
    const options = send.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data: { description?: string } }) => embed.data.description
    );
}

const client = {} as unknown as Client;

describe('CleanDiscordCommandHandler', () => {
    let handler: CleanDiscordCommandHandler;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        handler = new CleanDiscordCommandHandler(client, [MOD_ROLE], TRIGGERS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses outside servers', async () => {
        const { message, reply, channel } = makeMessage({
            content: '?clean 3',
            inGuild: false,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'This command must be used in a server.',
        ]);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it('refuses bots', async () => {
        const { message, reply, channel } = makeMessage({
            content: '?clean 3',
            bot: true,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual(['Bots cannot use this command.']);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it('rejects members without a moderator role', async () => {
        const { message, reply, channel } = makeMessage({
            content: '?clean 3',
            member: makeMember(['some-other-role']),
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'You do not have a role that is allowed to use this command.',
        ]);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(channel.bulkDelete).not.toHaveBeenCalled();
    });

    it('reports a member that cannot be fetched', async () => {
        const { message, reply } = makeMessage({
            content: '?clean 3',
            member: null,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'Could not fetch your member information.',
        ]);
    });

    it('shows the usage when the count is missing', async () => {
        const { message, reply, channel } = makeMessage({ content: '?clean' });
        await handler.handleCommand(message, 'clean');
        expect(titles(reply)).toEqual(['Command Usage']);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it('explains parse failures and shows the usage', async () => {
        const { message, reply } = makeMessage({ content: '!b clean lots' });
        await handler.handleCommand(message, 'clean', 'lots');
        expect(replied(reply)[0]).toBe(
            '`lots` is not a valid number of messages; give a whole number from 1 to 1000.'
        );
        expect(titles(reply)[1]).toBe('Command Usage');
    });

    it('explains unknown switches with backticks stripped', async () => {
        const { message, reply } = makeMessage({
            content: '?clean 3 -`bad`',
        });
        await handler.handleCommand(message, 'clean', '3', '-`bad`');
        expect(replied(reply)[0]).toBe('Unknown switch `-bad`.');
    });

    it('explains switches that need a value', async () => {
        const { message, reply } = makeMessage({ content: '?clean 3 -r' });
        await handler.handleCommand(message, 'clean', '3', '-r');
        expect(replied(reply)[0]).toBe('`-r` needs a value.');
    });

    it('explains invalid durations', async () => {
        const { message, reply } = makeMessage({
            content: '?clean 3 -ma soon',
        });
        await handler.handleCommand(message, 'clean', '3', '-ma', 'soon');
        expect(replied(reply)[0]).toBe(
            '`soon` is not a valid duration for `-ma`; use something like `1h30min`, `2d` or `30` (minutes).'
        );
    });

    it('only cleans text channels and threads', async () => {
        const { message, reply, channel } = makeMessage({
            content: '?clean 3',
            channel: makeChannel([], { isVoiceBased: () => true }),
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'Messages can only be cleaned in text channels and threads.',
        ]);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it('requires Manage Messages and Read Message History for the bot', async () => {
        const { message, reply, channel } = makeMessage({
            content: '?clean 3',
            botMember: makeBotMember([PermissionFlagsBits.ReadMessageHistory]),
            channel: makeChannel(makeHistory(5)),
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'I need the `Manage Messages` and `Read Message History` permissions in this channel to clean it.',
        ]);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
        expect(channel.bulkDelete).not.toHaveBeenCalled();
    });

    it('fetches the bot member when it is not cached', async () => {
        const history = makeHistory(5);
        const { message, channel } = makeMessage({
            content: '?clean 2',
            botMember: null,
            channel: makeChannel(history),
        });
        const botMember = makeBotMember();
        (
            message.guild!.members.fetchMe as unknown as ReturnType<
                typeof vi.fn
            >
        ).mockResolvedValue(botMember);
        await handler.handleCommand(message, 'clean', '2');
        expect(message.guild!.members.fetchMe).toHaveBeenCalled();
        expect(channel.bulkDelete).toHaveBeenCalledWith(
            [history[0].id, history[1].id],
            true
        );
    });

    it('deletes the newest messages before the invocation', async () => {
        const history = makeHistory(10);
        const {
            message,
            reply,
            delete: del,
            channel,
        } = makeMessage({
            content: '?clean 3',
            channel: makeChannel(history),
        });
        await handler.handleCommand(message, 'clean', '3');

        expect(channel.messages.fetch).toHaveBeenCalledTimes(1);
        expect(channel.messages.fetch).toHaveBeenCalledWith({
            limit: 3,
            before: TRIGGER_ID,
        });
        expect(channel.bulkDelete).toHaveBeenCalledWith(
            [history[0].id, history[1].id, history[2].id],
            true
        );
        expect(reply).not.toHaveBeenCalled();
        expect(sent(channel.send)).toEqual(["Deleted 3 message(s)! :')"]);

        // The confirmation is removed again after a short delay.
        expect(channel.confirmationDelete).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CLEAN_CONFIRMATION_DELETE_DELAY_MS);
        expect(channel.confirmationDelete).toHaveBeenCalledTimes(1);

        // With DELETE_INVOCATION unset the handler removes the invocation.
        expect(del).toHaveBeenCalledTimes(1);
    });

    it('reads the arguments as typed, not from the split args', async () => {
        const history = makeHistory(10, (i) => ({
            content: i % 2 === 0 ? 'foo bar' : 'other',
        }));
        const { message, channel } = makeMessage({
            content: '?clean 2 -r "foo bar"',
            channel: makeChannel(history),
        });
        await handler.handleCommand(
            message,
            'clean',
            '2',
            '-r',
            '"foo',
            'bar"'
        );
        expect(channel.bulkDelete).toHaveBeenCalledWith(
            [history[0].id, history[2].id],
            true
        );
    });

    it('selects only the given user and pages when a page has too few matches', async () => {
        // 100 messages on the first page with two by the target, three more
        // by the target on the second page.
        const targets = new Set([3, 40, 100, 101, 102]);
        const history = makeHistory(110, (i) => ({
            authorId: targets.has(i) ? '123456789012345678' : 'someone',
        }));
        const { message, channel } = makeMessage({
            content: '?clean 5 <@123456789012345678>',
            channel: makeChannel(history),
        });
        await handler.handleCommand(
            message,
            'clean',
            '5',
            '<@123456789012345678>'
        );

        expect(channel.messages.fetch).toHaveBeenCalledTimes(2);
        expect(channel.messages.fetch).toHaveBeenNthCalledWith(1, {
            limit: 100,
            before: TRIGGER_ID,
        });
        expect(channel.messages.fetch).toHaveBeenNthCalledWith(2, {
            limit: 100,
            before: history[99].id,
        });
        expect(channel.bulkDelete).toHaveBeenCalledWith(
            [3, 40, 100, 101, 102].map((i) => history[i].id),
            true
        );
        expect(sent(channel.send)).toEqual(["Deleted 5 message(s)! :')"]);
    });

    it('never passes messages older than two weeks to bulkDelete', async () => {
        const history = makeHistory(5, (i) => ({
            ageMinutes:
                i < 2 ? i + 1 : DISCORD_BULK_DELETE_MAX_AGE_MS / MINUTE + i + 1,
        }));
        const { message, channel } = makeMessage({
            content: '?clean 5',
            channel: makeChannel(history),
        });
        await handler.handleCommand(message, 'clean', '5');
        expect(channel.bulkDelete).toHaveBeenCalledWith(
            [history[0].id, history[1].id],
            true
        );
        expect(sent(channel.send)).toEqual(["Deleted 2 message(s)! :')"]);
    });

    it('reports when nothing matched', async () => {
        const history = makeHistory(10);
        const {
            message,
            reply,
            delete: del,
            channel,
        } = makeMessage({
            content: '?clean 5 -bots',
            channel: makeChannel(history),
        });
        await handler.handleCommand(message, 'clean', '5', '-bots');
        expect(channel.bulkDelete).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
        expect(sent(channel.send)).toEqual(['No messages matched.']);
        await vi.advanceTimersByTimeAsync(CLEAN_CONFIRMATION_DELETE_DELAY_MS);
        expect(channel.confirmationDelete).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledTimes(1);
    });

    it('reports API failures', async () => {
        const channel = makeChannel(makeHistory(3));
        channel.bulkDelete.mockRejectedValue(new Error('Missing Access'));
        const {
            message,
            reply,
            delete: del,
        } = makeMessage({
            content: '?clean 3',
            channel,
        });
        await handler.handleCommand(message, 'clean', '3');
        expect(replied(reply)).toEqual([
            'Failed to delete messages: Missing Access',
        ]);
        expect(channel.send).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
    });

    it('deletes more than 100 messages in batches of 100', async () => {
        const history = makeHistory(260);
        const { message, reply, channel } = makeMessage({
            content: '?clean 250',
            channel: makeChannel(history),
        });
        await handler.handleCommand(message, 'clean', '250');
        expect(reply).not.toHaveBeenCalled();
        const ids = history.slice(0, 250).map((m) => m.id);
        expect(channel.bulkDelete.mock.calls).toEqual([
            [ids.slice(0, 100), true],
            [ids.slice(100, 200), true],
            [ids.slice(200, 250), true],
        ]);
        expect(sent(channel.send)).toEqual(["Deleted 250 message(s)! :')"]);
    });

    it('accepts clean 1000 and deletes in ten batches', async () => {
        const history = makeHistory(1000);
        const { message, channel } = makeMessage({
            content: '?clean 1000',
            channel: makeChannel(history),
        });
        await handler.handleCommand(message, 'clean', '1000');
        expect(channel.bulkDelete).toHaveBeenCalledTimes(10);
        expect(sent(channel.send)).toEqual(["Deleted 1000 message(s)! :')"]);
    });

    it('reports how many were deleted when a later batch fails', async () => {
        const channel = makeChannel(makeHistory(150));
        channel.bulkDelete
            .mockImplementationOnce(
                async (ids: string[]) => new Map(ids.map((id) => [id, { id }]))
            )
            .mockRejectedValueOnce(new Error('Missing Access'));
        const {
            message,
            reply,
            delete: del,
        } = makeMessage({
            content: '?clean 150',
            channel,
        });
        await handler.handleCommand(message, 'clean', '150');
        expect(channel.bulkDelete).toHaveBeenCalledTimes(2);
        expect(replied(reply)).toEqual([
            'Deleted 100 message(s), then failed to delete the rest: Missing Access',
        ]);
        expect(channel.send).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
    });

    it('leaves the invocation to the dispatcher when DELETE_INVOCATION is set', async () => {
        vi.resetModules();
        vi.doMock('../../../src/utils/env', async (importOriginal) => ({
            ...(await importOriginal<
                typeof import('../../../src/utils/env')
            >()),
            DELETE_INVOCATION: true,
        }));
        try {
            const { default: Handler } =
                await import('../../../src/commands/discord/handlers/CleanDiscordCommandHandler');
            const freshHandler = new Handler(client, [MOD_ROLE], TRIGGERS);
            const history = makeHistory(3);
            const {
                message,
                delete: del,
                channel,
            } = makeMessage({
                content: '?clean 2',
                channel: makeChannel(history),
            });
            await freshHandler.handleCommand(message, 'clean', '2');
            expect(channel.bulkDelete).toHaveBeenCalledWith(
                [history[0].id, history[1].id],
                true
            );
            expect(sent(channel.send)).toEqual(["Deleted 2 message(s)! :')"]);
            expect(del).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('../../../src/utils/env');
            vi.resetModules();
        }
    });
});
