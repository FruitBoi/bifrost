import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import RemindMeDiscordCommandHandler, {
    INVALID_DURATION_MESSAGE,
} from '../../../src/commands/discord/handlers/RemindMeDiscordCommandHandler';
import ReminderDiscordCommandHandler from '../../../src/commands/discord/handlers/ReminderDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import ReminderService from '../../../src/services/reminders/ReminderService';
import ReminderTimezoneService from '../../../src/services/reminders/ReminderTimezoneService';
import TimezoneDiscordCommandHandler from '../../../src/commands/discord/handlers/TimezoneDiscordCommandHandler';
import { UserTimezoneRepository } from '../../../src/db/repositories/UserTimezoneRepository';
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

/** In-memory time zone store keyed by `platform:userId`. */
function makeZoneRepo(initial: Record<string, string> = {}) {
    const zones = new Map(Object.entries(initial));
    const repo: UserTimezoneRepository = {
        get: vi.fn(
            async (platform, userId) =>
                zones.get(`${platform}:${userId}`) ?? null
        ),
        set: vi.fn(async (platform, userId, zone) => {
            zones.set(`${platform}:${userId}`, zone);
        }),
        delete: vi.fn(async (platform, userId) =>
            zones.delete(`${platform}:${userId}`)
        ),
    };
    return { repo, zones };
}

function makeTimezoneService(
    service: ReturnType<typeof makeService>,
    zones: Record<string, string> = {}
) {
    const { repo } = makeZoneRepo(zones);
    return new ReminderTimezoneService(
        repo,
        service as unknown as ReminderService,
        { now: () => NOW.getTime() }
    );
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
    let timezones: ReminderTimezoneService;
    let handler: RemindMeDiscordCommandHandler;

    beforeEach(() => {
        service = makeService();
        timezones = makeTimezoneService(service);
        handler = new RemindMeDiscordCommandHandler(
            client,
            service as unknown as ReminderService,
            timezones,
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
        expect(INVALID_DURATION_MESSAGE).toContain('Monday 7pm');
        expect(titles(reply)[1]).toBe('Command Usage');
    });

    it('asks for a time zone before the first date reminder and keeps it pending', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme Monday 7pm stand-up',
        });
        await handler.handleCommand(
            message,
            'remindme',
            'Monday',
            '7pm',
            'stand-up'
        );
        expect(service.create).not.toHaveBeenCalled();
        const text = replied(reply)[0];
        expect(text).toContain('I need your time zone');
        expect(text).toContain('`?timezone America/New_York`');
        expect(timezones.peekPending('discord', 'author')).toMatchObject({
            guildId: 'guild-1',
            channelId: 'chan-1',
            message: 'stand-up',
        });
    });

    it('creates a date reminder in the stored time zone', async () => {
        timezones = makeTimezoneService(service, {
            'discord:author': 'America/New_York',
        });
        handler = new RemindMeDiscordCommandHandler(
            client,
            service as unknown as ReminderService,
            timezones,
            TRIGGERS
        );
        // Oct 26 20:15 in New York (EDT, UTC-4) is Oct 27 00:15 UTC.
        const dueAt = new Date('2026-10-27T00:15:00Z');
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 12, dueAt }),
        });
        const { message, reply } = makeMessage({
            content: '?remindme Oct 26 20:15 carve the pumpkin',
        });
        await handler.handleCommand(
            message,
            'remindme',
            'Oct',
            '26',
            '20:15',
            'carve',
            'the',
            'pumpkin'
        );
        expect(service.create).toHaveBeenCalledWith({
            platform: 'discord',
            userId: 'author',
            guildId: 'guild-1',
            channelId: 'chan-1',
            message: 'carve the pumpkin',
            delayMs: dueAt.getTime() - NOW.getTime(),
        });
        const text = replied(reply)[0];
        expect(text).toContain('Reminder **#12** set for');
        expect(text).toContain('20:15 (America/New_York)');
        expect(text).toContain(`<t:${dueAt.getTime() / 1000}:f>`);
    });

    it('checks the -channel permissions before keeping a date reminder pending', async () => {
        const { message, reply } = makeMessage({
            content: '?remindme -channel <#200> tomorrow hi',
            member: makeMember([PermissionFlagsBits.ViewChannel]),
            channels: { '200': makeChannel('200') },
        });
        await handler.handleCommand(
            message,
            'remindme',
            '-channel',
            '<#200>',
            'tomorrow',
            'hi'
        );
        expect(replied(reply)[0]).toContain('You need View Channel');
        expect(timezones.peekPending('discord', 'author')).toBeNull();
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

describe('TimezoneDiscordCommandHandler', () => {
    let service: ReturnType<typeof makeService>;
    let timezones: ReminderTimezoneService;
    let remindMe: RemindMeDiscordCommandHandler;
    let handler: TimezoneDiscordCommandHandler;

    beforeEach(() => {
        service = makeService();
        timezones = makeTimezoneService(service);
        remindMe = new RemindMeDiscordCommandHandler(
            client,
            service as unknown as ReminderService,
            timezones,
            TRIGGERS
        );
        handler = new TimezoneDiscordCommandHandler(
            client,
            timezones,
            TRIGGERS
        );
    });

    it('says when no zone is set', async () => {
        const { message, reply } = makeMessage({ content: '?timezone' });
        await handler.handleCommand(message, 'timezone');
        expect(replied(reply)[0]).toContain('You have not set a time zone');
    });

    it('rejects unknown zones', async () => {
        const { message, reply } = makeMessage({
            content: '?tz Mars/Olympus',
        });
        await handler.handleCommand(message, 'tz', 'Mars/Olympus');
        expect(replied(reply)[0]).toContain(
            '`Mars/Olympus` is not a time zone I know'
        );
        expect(await timezones.getTimeZone('discord', 'author')).toBeNull();
    });

    it('stores the zone, shows it and clears it', async () => {
        const set = makeMessage({ content: '?timezone europe/london' });
        await handler.handleCommand(set.message, 'timezone', 'europe/london');
        expect(replied(set.reply)[0]).toContain(
            'Time zone set to **Europe/London**'
        );
        expect(await timezones.getTimeZone('discord', 'author')).toBe(
            'Europe/London'
        );

        const show = makeMessage({ content: '?timezone' });
        await handler.handleCommand(show.message, 'timezone');
        // 12:00 UTC on Oct 20 is 13:00 BST in London.
        expect(replied(show.reply)[0]).toContain('13:00');

        const clear = makeMessage({ content: '?timezone clear' });
        await handler.handleCommand(clear.message, 'timezone', 'clear');
        expect(replied(clear.reply)[0]).toContain('has been removed');
        expect(await timezones.getTimeZone('discord', 'author')).toBeNull();
    });

    it('sets the pending reminder once the zone is given', async () => {
        const first = makeMessage({ content: '?remindme tomorrow 7pm bins' });
        await remindMe.handleCommand(
            first.message,
            'remindme',
            'tomorrow',
            '7pm',
            'bins'
        );
        expect(service.create).not.toHaveBeenCalled();

        // Tomorrow (Oct 21) 19:00 at UTC+2 is 17:00 UTC.
        const dueAt = new Date('2026-10-21T17:00:00Z');
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 3, dueAt }),
        });
        const { message, reply } = makeMessage({ content: '?timezone UTC+2' });
        await handler.handleCommand(message, 'timezone', 'UTC+2');
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                channelId: 'chan-1',
                message: 'bins',
                delayMs: dueAt.getTime() - NOW.getTime(),
            })
        );
        const texts = replied(reply);
        expect(texts[0]).toContain('Time zone set to **UTC+02:00**');
        expect(texts[1]).toContain('Reminder **#3** set for');
        expect(timezones.peekPending('discord', 'author')).toBeNull();
    });
});
