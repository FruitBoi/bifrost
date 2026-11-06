import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, Message } from '@fluxerjs/core';
import RemindMeFluxerCommandHandler from '../../../src/commands/fluxer/handlers/RemindMeFluxerCommandHandler';
import TimezoneFluxerCommandHandler from '../../../src/commands/fluxer/handlers/TimezoneFluxerCommandHandler';
import { INVALID_TIME_MESSAGE } from '../../../src/commands/timezoneCommand';
import ReminderService from '../../../src/services/reminders/ReminderService';
import ReminderTimezoneService from '../../../src/services/reminders/ReminderTimezoneService';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import { UserTimezoneRepository } from '../../../src/db/repositories/UserTimezoneRepository';
import { Reminder } from '../../../src/db/entities/Reminder';
import { ReminderMessage } from '../../../src/db/entities/ReminderMessage';

const TRIGGERS = ['?', '!'];
// A Tuesday.
const NOW = new Date('2026-10-20T12:00:00Z');

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
    return {
        id: 5,
        platform: 'fluxer',
        userId: 'author',
        guildId: 'guild-1',
        channelId: 'chan-1',
        message: 'water the plants',
        dueAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        attempts: 0,
        createdAt: NOW,
        ...overrides,
    };
}

function makeService() {
    return {
        create: vi.fn(),
        recordMessage: vi.fn().mockResolvedValue(undefined),
        findMessage: vi.fn().mockResolvedValue(null),
        lastDelivered: vi.fn().mockResolvedValue(null),
    };
}

function makeReminderMessage(
    overrides: Partial<ReminderMessage> = {}
): ReminderMessage {
    return {
        platform: 'fluxer',
        messageId: 'msg-1',
        kind: 'delivered',
        userId: 'author',
        guildId: 'guild-1',
        channelId: 'chan-1',
        message: 'water the plants',
        createdAt: NOW,
        ...overrides,
    };
}

function makeTimezoneService(
    service: ReturnType<typeof makeService>,
    initial: Record<string, string> = {}
) {
    const zones = new Map(Object.entries(initial));
    const repo: UserTimezoneRepository = {
        get: async (platform, userId) =>
            zones.get(`${platform}:${userId}`) ?? null,
        set: async (platform, userId, zone) => {
            zones.set(`${platform}:${userId}`, zone);
        },
        delete: async (platform, userId) =>
            zones.delete(`${platform}:${userId}`),
    };
    return new ReminderTimezoneService(
        repo,
        service as unknown as ReminderService,
        { now: () => NOW.getTime() }
    );
}

function makeMessage(content: string, overrides: Record<string, unknown> = {}) {
    const reply = vi.fn().mockResolvedValue({ id: 'reply-1' });
    const message = {
        content,
        messageReference: null,
        channelId: 'chan-1',
        guildId: 'guild-1',
        guild: null,
        author: { id: 'author', bot: false, username: 'author' },
        reply,
        ...overrides,
    };
    return { message: message as unknown as Message, reply };
}

/** Descriptions of every embed sent in the first reply. */
function replied(reply: ReturnType<typeof vi.fn>): string[] {
    expect(reply).toHaveBeenCalled();
    const options = reply.mock.calls[0][0];
    return (options.embeds ?? []).map(
        (embed: { data?: { description?: string }; description?: string }) =>
            embed.data?.description ?? embed.description
    );
}

const client = {} as unknown as Client;
const resolver = {} as unknown as FluxerEntityResolver;

describe('RemindMeFluxerCommandHandler (issue #27)', () => {
    let service: ReturnType<typeof makeService>;
    let timezones: ReminderTimezoneService;
    let handler: RemindMeFluxerCommandHandler;

    const build = (zones: Record<string, string> = {}) => {
        timezones = makeTimezoneService(service, zones);
        handler = new RemindMeFluxerCommandHandler(
            client,
            service as unknown as ReminderService,
            timezones,
            resolver,
            TRIGGERS
        );
    };

    beforeEach(() => {
        service = makeService();
        build();
    });

    it('keeps durations working as before', async () => {
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 2 }),
        });
        const { message, reply } = makeMessage('?remindme 1h stretch');
        await handler.handleCommand(message, 'remindme', '1h', 'stretch');
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'fluxer',
                delayMs: 60 * 60 * 1000,
                message: 'stretch',
            })
        );
        expect(replied(reply)[0]).toContain(
            'Reminder **#2** set for 1 hour from now'
        );
        expect(service.recordMessage).toHaveBeenCalledWith({
            platform: 'fluxer',
            messageId: 'reply-1',
            kind: 'set',
            userId: 'author',
            guildId: 'guild-1',
            channelId: 'chan-1',
            message: 'water the plants',
        });
    });

    it('explains times it cannot read, mentioning date forms', async () => {
        const { message, reply } = makeMessage('?remindme soon x');
        await handler.handleCommand(message, 'remindme', 'soon', 'x');
        expect(replied(reply)[0]).toBe(INVALID_TIME_MESSAGE);
        expect(service.create).not.toHaveBeenCalled();
    });

    it('asks for a time zone the first time and keeps the reminder pending', async () => {
        const { message, reply } = makeMessage(
            '? Remindme Monday 7pm stand-up'
        );
        await handler.handleCommand(
            message,
            'remindme',
            'Monday',
            '7pm',
            'stand-up'
        );
        expect(service.create).not.toHaveBeenCalled();
        expect(service.recordMessage).not.toHaveBeenCalled();
        expect(replied(reply)[0]).toContain(
            'Reply with `?timezone <zone>`, e.g. `?timezone America/New_York`'
        );
        expect(timezones.peekPending('fluxer', 'author')).toMatchObject({
            channelId: 'chan-1',
            message: 'stand-up',
        });
    });

    it('creates a date reminder in the stored zone', async () => {
        build({ 'fluxer:author': 'Europe/Berlin' });
        // Next Monday is Oct 26; 19:00 in Berlin (CET after Oct 25) is 18:00 UTC.
        const dueAt = new Date('2026-10-26T18:00:00Z');
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 9, dueAt }),
        });
        const { message, reply } = makeMessage('?remindme Monday 7pm stand-up');
        await handler.handleCommand(
            message,
            'remindme',
            'Monday',
            '7pm',
            'stand-up'
        );
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                delayMs: dueAt.getTime() - NOW.getTime(),
            })
        );
        const text = replied(reply)[0];
        expect(text).toContain(
            'Reminder **#9** set for Mon, Oct 26, 2026, 19:00'
        );
        expect(text).toContain('(Europe/Berlin)');
        expect(text).toContain('(2026-10-26 18:00 UTC)');
        expect(service.recordMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'fluxer',
                messageId: 'reply-1',
                kind: 'set',
            })
        );
    });

    it('reports reminder service failures for dates', async () => {
        build({ 'fluxer:author': 'UTC' });
        service.create.mockResolvedValue({ ok: false, reason: 'too_many' });
        const { message, reply } = makeMessage('?remindme tomorrow x');
        await handler.handleCommand(message, 'remindme', 'tomorrow', 'x');
        expect(replied(reply)[0]).toContain('at most 25 reminders');
        expect(service.recordMessage).not.toHaveBeenCalled();
    });
});

describe('RemindMeFluxerCommandHandler snooze (issue #58)', () => {
    let service: ReturnType<typeof makeService>;
    let timezones: ReminderTimezoneService;
    let handler: RemindMeFluxerCommandHandler;

    const build = (zones: Record<string, string> = {}) => {
        timezones = makeTimezoneService(service, zones);
        handler = new RemindMeFluxerCommandHandler(
            client,
            service as unknown as ReminderService,
            timezones,
            resolver,
            TRIGGERS
        );
    };

    const run = async (
        content: string,
        replyTo?: string,
        authorId = 'author'
    ) => {
        const { message, reply } = makeMessage(content, {
            messageReference: replyTo
                ? { channel_id: 'chan-1', messageId: replyTo }
                : null,
            author: { id: authorId, bot: false, username: authorId },
        });
        const args = content.split(/\s+/).slice(1);
        await handler.handleCommand(message, 'remindme', ...args);
        return reply;
    };

    beforeEach(() => {
        service = makeService();
        build();
    });

    it.each(['delivered', 'set'] as const)(
        'snoozes the replied-to %s message in its channel',
        async (kind) => {
            service.findMessage.mockResolvedValue(
                makeReminderMessage({
                    kind,
                    messageId: 'bot-msg',
                    channelId: 'chan-2',
                    message: 'stretch',
                })
            );
            service.create.mockResolvedValue({
                ok: true,
                reminder: makeReminder({
                    id: 11,
                    channelId: 'chan-2',
                    message: 'stretch',
                }),
            });
            const reply = await run('?remindme snooze 10m', 'bot-msg');
            expect(service.findMessage).toHaveBeenCalledWith(
                'fluxer',
                'bot-msg'
            );
            expect(service.lastDelivered).not.toHaveBeenCalled();
            expect(service.create).toHaveBeenCalledWith({
                platform: 'fluxer',
                userId: 'author',
                guildId: 'guild-1',
                channelId: 'chan-2',
                message: 'stretch',
                delayMs: 10 * 60 * 1000,
            });
            const text = replied(reply)[0];
            expect(text).toContain('Reminder **#11** set for 10 minutes');
            expect(text).toContain(' in <#chan-2>');
            expect(service.recordMessage).toHaveBeenCalledWith({
                platform: 'fluxer',
                messageId: 'reply-1',
                kind: 'set',
                userId: 'author',
                guildId: 'guild-1',
                channelId: 'chan-2',
                message: 'stretch',
            });
        }
    );

    it('falls back to the last delivered reminder (again alias)', async () => {
        service.lastDelivered.mockResolvedValue(makeReminderMessage());
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 3 }),
        });
        const reply = await run('?remindme Again 1h');
        expect(service.findMessage).not.toHaveBeenCalled();
        expect(service.lastDelivered).toHaveBeenCalledWith(
            'fluxer',
            'author',
            'guild-1'
        );
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                channelId: 'chan-1',
                message: 'water the plants',
                delayMs: 60 * 60 * 1000,
            })
        );
        const text = replied(reply)[0];
        expect(text).toContain('Reminder **#3** set for 1 hour');
        expect(text).not.toContain(' in <#');
    });

    it('falls back to the last delivered reminder when the reply is not a reminder', async () => {
        service.lastDelivered.mockResolvedValue(makeReminderMessage());
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder(),
        });
        await run('?remindme snooze 5m', 'some-chat-message');
        expect(service.findMessage).toHaveBeenCalledWith(
            'fluxer',
            'some-chat-message'
        );
        expect(service.lastDelivered).toHaveBeenCalled();
        expect(service.create).toHaveBeenCalled();
    });

    it('says when there is nothing to snooze', async () => {
        const reply = await run('?remindme snooze 10m');
        expect(replied(reply)[0]).toContain('No reminder to snooze');
        expect(service.create).not.toHaveBeenCalled();
    });

    it("refuses to snooze someone else's reminder", async () => {
        service.findMessage.mockResolvedValue(makeReminderMessage());
        const reply = await run('?remindme snooze 10m', 'bot-msg', 'intruder');
        expect(replied(reply)).toEqual([
            'You can only snooze your own reminders.',
        ]);
        expect(service.create).not.toHaveBeenCalled();
    });

    it('explains text after the time', async () => {
        const reply = await run('?remindme snooze 10m stretch');
        expect(replied(reply)[0]).toContain('Snoozing only takes a time');
        expect(service.create).not.toHaveBeenCalled();
    });

    it('snoozes to a date in the stored time zone', async () => {
        build({ 'fluxer:author': 'UTC' });
        service.lastDelivered.mockResolvedValue(
            makeReminderMessage({ message: 'bins' })
        );
        const dueAt = new Date('2026-10-21T09:00:00Z');
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 4, dueAt, message: 'bins' }),
        });
        const reply = await run('?remindme snooze tomorrow 9am');
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'bins',
                delayMs: dueAt.getTime() - NOW.getTime(),
            })
        );
        expect(replied(reply)[0]).toContain('Reminder **#4** set for');
        expect(service.recordMessage).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'set', message: 'bins' })
        );
    });

    it('keeps a snoozed date reminder pending until the time zone is set', async () => {
        service.lastDelivered.mockResolvedValue(
            makeReminderMessage({ channelId: 'chan-2', message: 'bins' })
        );
        const reply = await run('?remindme snooze tomorrow');
        expect(service.create).not.toHaveBeenCalled();
        expect(replied(reply)[0]).toContain('Reply with `?timezone <zone>`');
        expect(timezones.peekPending('fluxer', 'author')).toMatchObject({
            channelId: 'chan-2',
            originChannelId: 'chan-1',
            message: 'bins',
        });
        expect(service.recordMessage).not.toHaveBeenCalled();
    });
});

describe('TimezoneFluxerCommandHandler', () => {
    let service: ReturnType<typeof makeService>;
    let timezones: ReminderTimezoneService;
    let handler: TimezoneFluxerCommandHandler;

    beforeEach(() => {
        service = makeService();
        timezones = makeTimezoneService(service);
        handler = new TimezoneFluxerCommandHandler(client, timezones, TRIGGERS);
    });

    it('stores abbreviations as their zone', async () => {
        const { message, reply } = makeMessage('?timezone est');
        await handler.handleCommand(message, 'timezone', 'est');
        expect(await timezones.getTimeZone('fluxer', 'author')).toBe(
            'America/New_York'
        );
        expect(replied(reply)[0]).toContain('America/New_York');
    });

    it('creates the pending reminder in its original channel', async () => {
        timezones.setPending('fluxer', 'author', {
            guildId: 'guild-1',
            channelId: 'chan-2',
            originChannelId: 'chan-1',
            spec: {
                kind: 'relativeDay',
                dayOffset: 1,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            message: 'bins',
        });
        const dueAt = new Date('2026-10-21T09:00:00Z');
        service.create.mockResolvedValue({
            ok: true,
            reminder: makeReminder({ id: 4, channelId: 'chan-2', dueAt }),
        });
        const { message, reply } = makeMessage('!b tz utc');
        await handler.handleCommand(message, 'tz', 'utc');
        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                channelId: 'chan-2',
                guildId: 'guild-1',
                delayMs: dueAt.getTime() - NOW.getTime(),
            })
        );
        const texts = replied(reply);
        expect(texts[0]).toContain('Time zone set to **UTC**');
        expect(texts[1]).toContain(' in <#chan-2>');
    });

    it('refuses bots', async () => {
        const { message, reply } = makeMessage('?tz utc', {
            author: { id: 'b', bot: true, username: 'bot' },
        });
        await handler.handleCommand(message, 'tz', 'utc');
        expect(replied(reply)).toEqual(['Bots cannot set a time zone.']);
    });
});
