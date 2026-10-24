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
    return { create: vi.fn() };
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
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        content,
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
    });

    it('reports reminder service failures for dates', async () => {
        build({ 'fluxer:author': 'UTC' });
        service.create.mockResolvedValue({ ok: false, reason: 'too_many' });
        const { message, reply } = makeMessage('?remindme tomorrow x');
        await handler.handleCommand(message, 'remindme', 'tomorrow', 'x');
        expect(replied(reply)[0]).toContain('at most 25 reminders');
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
