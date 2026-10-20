import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import RemindMeDiscordCommandHandler, {
    INVALID_DURATION_MESSAGE,
} from '../../../src/commands/discord/handlers/RemindMeDiscordCommandHandler';
import ReminderDiscordCommandHandler from '../../../src/commands/discord/handlers/ReminderDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import ReminderService from '../../../src/services/reminders/ReminderService';
import { Reminder } from '../../../src/db/entities/Reminder';

const TRIGGERS = ['?', '!'];
const NOW = new Date('2026-10-20T12:00:00Z');

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
    return {
        id: 5,
        platform: 'discord',
        userId: 'author',
        guildId: 'guild-1',
        channelId: 'chan-1',
        message: 'water the plants',
        dueAt: new Date(NOW.getTime() + 90 * 60 * 1000),
        attempts: 0,
        createdAt: NOW,
        ...overrides,
    };
}

function makeService() {
    return {
        create: vi.fn(),
        getById: vi.fn(),
        listForUser: vi.fn().mockResolvedValue([]),
        listForChannel: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
        deleteAllForUser: vi.fn().mockResolvedValue(0),
    };
}

function makeMember(permissions: bigint[], username = 'someone') {
    const bits = new PermissionsBitField(permissions);
    return {
        user: { username },
        permissions: bits,
        permissionsIn: vi.fn().mockReturnValue(bits),
    };
}

function makeChannel(
    id: string,
    overrides: Partial<Record<string, unknown>> = {}
) {
    return {
        id,
        isTextBased: () => true,
        isVoiceBased: () => false,
        isSendable: () => true,
        ...overrides,
    };
}

interface FakeMessageOptions {
    content: string;
    inGuild?: boolean;
    bot?: boolean;
    member?: ReturnType<typeof makeMember> | null;
    /** Other members by id; the author is `member`. */
    members?: Record<string, ReturnType<typeof makeMember>>;
    channels?: Record<string, ReturnType<typeof makeChannel>>;
}

function makeMessage({
    content,
    inGuild = true,
    bot = false,
    member = makeMember([]),
    members = {},
    channels = {},
}: FakeMessageOptions) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        content,
        channelId: 'chan-1',
        guildId: inGuild ? 'guild-1' : null,
        inGuild: () => inGuild,
        author: {
            id: 'author',
            bot,
            username: 'author',
            displayAvatarURL: () => 'https://example.invalid/a.png',
        },
        channel: { isSendable: () => true, send: vi.fn() },
        guild: inGuild
            ? {
                  members: {
                      fetch: vi.fn(async (id: string) => {
                          const found = id === 'author' ? member : members[id];
                          if (!found) throw new Error('Unknown Member');
                          return found;
                      }),
                  },
                  channels: {
                      fetch: vi.fn(async (id: string) => {
                          const channel = channels[id];
                          if (!channel) throw new Error('Unknown Channel');
                          return channel;
                      }),
                  },
              }
            : null,
        reply,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
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

const client = {
    users: { fetch: vi.fn().mockRejectedValue(new Error('Unknown User')) },
} as unknown as Client;

describe('RemindMeDiscordCommandHandler', () => {
    let service: ReturnType<typeof makeService>;
    let handler: RemindMeDiscordCommandHandler;

    beforeEach(() => {
        service = makeService();
        handler = new RemindMeDiscordCommandHandler(
            client,
            service as unknown as ReminderService,
            TRIGGERS
        );
    });

    it('refuses outside servers', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme 1h hi',
            inGuild: false,
        });
        await handler.handleCommand(message, 'remindme', '1h', 'hi');
        expect(replied(reply)).toEqual([
            'This command must be used in a server.',
        ]);
        expect(service.create).not.toHaveBeenCalled();
    });

    it('refuses bots', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme 1h hi',
            bot: true,
        });
        await handler.handleCommand(message, 'remindme', '1h', 'hi');
        expect(replied(reply)).toEqual(['Cannot create reminders for bots.']);
    });

    it('shows the usage when the time or message is missing', async () => {
        const { message, reply } = makeMessage({ content: '?remindme' });
        await handler.handleCommand(message, 'remindme');
        expect(titles(reply)).toEqual(['Command Usage']);
        expect(service.create).not.toHaveBeenCalled();
    });

    it('explains invalid durations and shows the usage', async () => {
        const { message, reply } = makeMessage({
            content: '!b remindme soon do the thing',
        });
        await handler.handleCommand(
            message,
            'remindme',
            'soon',
            'do',
            'the',
            'thing'
        );
        expect(replied(reply)[0]).toBe(INVALID_DURATION_MESSAGE);
        expect(titles(reply)[1]).toBe('Command Usage');
    });

    it('creates a reminder in the current channel', async () => {
        const reminder = makeReminder({ id: 7 });
        service.create.mockResolvedValue({ ok: true, reminder });
        const { message, reply } = makeMessage({
            content: '?remindme 1h30m water  the\nplants',
        });
        await handler.handleCommand(
            message,
            'remindme',
            '1h30m',
            'water',
            'the',
            'plants'
        );
        expect(service.create).toHaveBeenCalledWith({
            platform: 'discord',
            userId: 'author',
            guildId: 'guild-1',
            channelId: 'chan-1',
            message: 'water  the\nplants',
            delayMs: 90 * 60 * 1000,
        });
        const text = replied(reply)[0];
        expect(text).toContain('Set reminder **#7** in 1 hour and 30 minutes');
        expect(text).toContain(
            `(<t:${Math.floor(reminder.dueAt.getTime() / 1000)}:f>)`
        );
        expect(text).not.toContain(' in <#');
        expect(text).toContain('`?reminders`');
    });

    it('reports the reminder limit', async () => {
        service.create.mockResolvedValue({ ok: false, reason: 'too_many' });
        const { message, reply } = makeMessage({ content: '?remindme 5 x' });
        await handler.handleCommand(message, 'remindme', '5', 'x');
        expect(replied(reply)[0]).toBe(
            'You can have at most 25 reminders at a time. Delete some with `?reminder delete <id>`.'
        );
    });

    it('requires View Channel and Send Messages in the target channel', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme -channel <#200> 10m hi',
            member: makeMember([PermissionFlagsBits.ViewChannel]),
            channels: { '200': makeChannel('200') },
        });
        await handler.handleCommand(
            message,
            'remindme',
            '-channel',
            '<#200>',
            '10m',
            'hi'
        );
        expect(replied(reply)).toEqual([
            'You need View Channel and Send Messages in <#200> to set a reminder there.',
        ]);
        expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects unknown target channels', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme 10m hi -channel 999',
        });
        await handler.handleCommand(
            message,
            'remindme',
            '10m',
            'hi',
            '-channel',
            '999'
        );
        expect(replied(reply)).toEqual(['Channel not found in this server.']);
    });

    it('creates a reminder in another channel', async () => {
        const reminder = makeReminder({ id: 8, channelId: '200' });
        service.create.mockResolvedValue({ ok: true, reminder });
        const { message, reply } = makeMessage({
            content: '?remindme 10m hi -channel <#200>',
            member: makeMember([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
            ]),
            channels: { '200': makeChannel('200') },
        });
        await handler.handleCommand(
            message,
            'remindme',
            '10m',
            'hi',
            '-channel',
            '<#200>'
        );
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({ channelId: '200', message: 'hi' })
        );
        expect(replied(reply)[0]).toContain(' in <#200>');
    });
});

describe('ReminderDiscordCommandHandler', () => {
    let service: ReturnType<typeof makeService>;
    let handler: ReminderDiscordCommandHandler;

    beforeEach(() => {
        service = makeService();
        handler = new ReminderDiscordCommandHandler(
            client,
            service as unknown as ReminderService,
            TRIGGERS
        );
    });

    it('shows the usage for an unknown subcommand', async () => {
        const { message, reply } = makeMessage({ content: '?reminder foo' });
        await handler.handleCommand(message, 'reminder', 'foo');
        expect(titles(reply)).toEqual(['Command Usage']);
    });

    it('lists nothing when the user has no reminders', async () => {
        const { message, reply } = makeMessage({ content: '?reminders' });
        await handler.handleCommand(message, 'reminders');
        expect(service.listForUser).toHaveBeenCalledWith(
            'discord',
            'author',
            'guild-1'
        );
        expect(replied(reply)).toEqual([
            'You have no reminders in this server. Create reminders with `?remindme`.',
        ]);
    });

    it('lists the user reminders with a delete hint', async () => {
        service.listForUser.mockResolvedValue([makeReminder()]);
        const { message, reply } = makeMessage({
            content: '!b reminder list',
        });
        await handler.handleCommand(message, 'reminder', 'list');
        expect(titles(reply)).toEqual(['Your reminders']);
        const text = replied(reply)[0];
        expect(text).toContain("**5**: <#chan-1>: 'water the plants'");
        expect(text).toContain(
            'Delete reminders with `?reminder delete <id>`.'
        );
    });

    it('requires Manage Channels for the channel listing', async () => {
        const { message, reply } = makeMessage({ content: '?creminders' });
        await handler.handleCommand(message, 'creminders');
        expect(replied(reply)).toEqual([
            'You need the `Manage Channels` permission to use this command.',
        ]);
        expect(service.listForChannel).not.toHaveBeenCalled();
    });

    it('lists channel reminders with usernames', async () => {
        service.listForChannel.mockResolvedValue([
            makeReminder({ id: 1, userId: 'author' }),
            makeReminder({ id: 2, userId: 'ghost' }),
        ]);
        const member = makeMember(
            [PermissionFlagsBits.ManageChannels],
            'author'
        );
        // Only the author resolves; `ghost` is unknown to guild and client.
        const { message, reply } = makeMessage({
            content: '?reminder channel',
            member,
        });
        await handler.handleCommand(message, 'reminder', 'channel');
        const text = replied(reply)[0];
        expect(text).toContain("**1**: author: 'water the plants'");
        expect(text).toContain("**2**: Unknown user: 'water the plants'");
    });

    it('needs a reminder id to delete', async () => {
        const { message, reply } = makeMessage({ content: '?delreminder' });
        await handler.handleCommand(message, 'delreminder');
        expect(replied(reply)).toEqual(['No reminder ID provided']);
    });

    it('rejects non-numeric ids', async () => {
        const { message, reply } = makeMessage({
            content: '?reminder delete abc',
        });
        await handler.handleCommand(message, 'reminder', 'delete', 'abc');
        expect(replied(reply)).toEqual(['Reminder IDs are whole numbers.']);
    });

    it.each([
        ['unknown', null],
        ['on the other platform', makeReminder({ platform: 'fluxer' })],
    ])('reports a missing reminder (%s)', async (_label, reminder) => {
        service.getById.mockResolvedValue(reminder);
        const { message, reply } = makeMessage({
            content: '?rmreminder 5',
        });
        await handler.handleCommand(message, 'rmreminder', '5');
        expect(replied(reply)).toEqual(['No reminder by that ID found']);
        expect(service.delete).not.toHaveBeenCalled();
    });

    it('deletes the caller’s own reminder', async () => {
        service.getById.mockResolvedValue(
            makeReminder({ message: 'a'.repeat(60) })
        );
        const { message, reply } = makeMessage({
            content: '?reminder delete 5',
        });
        await handler.handleCommand(message, 'reminder', 'delete', '5');
        expect(service.delete).toHaveBeenCalledWith(5);
        expect(replied(reply)).toEqual([
            `Deleted reminder **#5**: '${'a'.repeat(50)}...'`,
        ]);
    });

    it('refuses to delete someone else’s reminder without Manage Channels', async () => {
        service.getById.mockResolvedValue(makeReminder({ userId: 'other' }));
        const { message, reply } = makeMessage({
            content: '?reminder delete 5',
            channels: { 'chan-1': makeChannel('chan-1') },
        });
        await handler.handleCommand(message, 'reminder', 'delete', '5');
        expect(service.delete).not.toHaveBeenCalled();
        expect(replied(reply)[0]).toContain(
            'You can only delete your own reminders'
        );
    });

    it('refuses to delete reminders from another server', async () => {
        service.getById.mockResolvedValue(
            makeReminder({ userId: 'other', guildId: 'guild-2' })
        );
        const { message, reply } = makeMessage({
            content: '?reminder delete 5',
            member: makeMember([PermissionFlagsBits.Administrator]),
        });
        await handler.handleCommand(message, 'reminder', 'delete', '5');
        expect(service.delete).not.toHaveBeenCalled();
        expect(replied(reply)[0]).toContain(
            'You can only delete your own reminders'
        );
    });

    it('lets Manage Channels in the reminder channel delete others’ reminders', async () => {
        service.getById.mockResolvedValue(makeReminder({ userId: 'other' }));
        const member = makeMember([PermissionFlagsBits.ManageChannels]);
        const channel = makeChannel('chan-1');
        const { message, reply } = makeMessage({
            content: '?reminder delete 5',
            member,
            channels: { 'chan-1': channel },
        });
        await handler.handleCommand(message, 'reminder', 'delete', '5');
        expect(member.permissionsIn).toHaveBeenCalledWith(channel);
        expect(service.delete).toHaveBeenCalledWith(5);
        expect(replied(reply)[0]).toContain('Deleted reminder **#5**');
    });

    it('falls back to guild permissions when the channel is gone', async () => {
        service.getById.mockResolvedValue(
            makeReminder({ userId: 'other', channelId: 'gone' })
        );
        const member = makeMember([PermissionFlagsBits.ManageChannels]);
        const { message } = makeMessage({
            content: '?reminder delete 5',
            member,
        });
        await handler.handleCommand(message, 'reminder', 'delete', '5');
        expect(member.permissionsIn).not.toHaveBeenCalled();
        expect(service.delete).toHaveBeenCalledWith(5);
    });

    it('clears all reminders with -a', async () => {
        service.deleteAllForUser.mockResolvedValue(3);
        const { message, reply } = makeMessage({
            content: '?reminder delete -a',
        });
        await handler.handleCommand(message, 'reminder', 'delete', '-a');
        expect(service.deleteAllForUser).toHaveBeenCalledWith(
            'discord',
            'author'
        );
        expect(replied(reply)).toEqual(['Cleared 3 reminders']);
    });

    it('reports nothing to clear', async () => {
        const { message, reply } = makeMessage({
            content: '?reminder delete -a',
        });
        await handler.handleCommand(message, 'reminder', 'delete', '-a');
        expect(replied(reply)).toEqual(['No reminders to clear']);
    });
});
