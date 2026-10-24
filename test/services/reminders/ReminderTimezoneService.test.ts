import { describe, expect, it, vi } from 'vitest';
import ReminderTimezoneService, {
    formatLocalDateTime,
    PENDING_REMINDER_TTL_MS,
} from '../../../src/services/reminders/ReminderTimezoneService';
import ReminderService from '../../../src/services/reminders/ReminderService';
import { ReminderDateSpec } from '../../../src/services/reminders/reminderDate';
import { UserTimezoneRepository } from '../../../src/db/repositories/UserTimezoneRepository';
import { Reminder } from '../../../src/db/entities/Reminder';

// A Tuesday, 12:00 UTC.
const NOW = Date.parse('2026-10-20T12:00:00Z');

const TOMORROW: ReminderDateSpec = {
    kind: 'relativeDay',
    dayOffset: 1,
    hour: 9,
    minute: 0,
    hasTime: false,
};

function setup() {
    let now = NOW;
    const zones = new Map<string, string>();
    const repo: UserTimezoneRepository = {
        get: vi.fn(async (p, u) => zones.get(`${p}:${u}`) ?? null),
        set: vi.fn(async (p, u, z) => {
            zones.set(`${p}:${u}`, z);
        }),
        delete: vi.fn(async (p, u) => zones.delete(`${p}:${u}`)),
    };
    const reminders = {
        create: vi.fn(async (input: { delayMs: number }) => ({
            ok: true as const,
            reminder: {
                id: 1,
                dueAt: new Date(now + input.delayMs),
            } as Reminder,
        })),
    };
    const service = new ReminderTimezoneService(
        repo,
        reminders as unknown as ReminderService,
        { now: () => now }
    );
    return {
        service,
        repo,
        reminders,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

const pendingInput = (message = 'bins') => ({
    guildId: 'g',
    channelId: 'c',
    originChannelId: 'c',
    spec: TOMORROW,
    message,
});

describe('ReminderTimezoneService', () => {
    it('stores, reads and clears zones per platform and user', async () => {
        const { service } = setup();
        await service.setTimeZone('discord', 'u', 'Europe/London');
        expect(await service.getTimeZone('discord', 'u')).toBe('Europe/London');
        expect(await service.getTimeZone('fluxer', 'u')).toBeNull();
        expect(await service.clearTimeZone('discord', 'u')).toBe(true);
        expect(await service.clearTimeZone('discord', 'u')).toBe(false);
    });

    it('keeps one pending reminder per user, latest wins', () => {
        const { service } = setup();
        service.setPending('discord', 'u', pendingInput('first'));
        service.setPending('discord', 'u', pendingInput('second'));
        service.setPending('fluxer', 'u', pendingInput('other platform'));
        expect(service.peekPending('discord', 'u')?.message).toBe('second');
        expect(service.takePending('discord', 'u')?.message).toBe('second');
        expect(service.takePending('discord', 'u')).toBeNull();
        expect(service.peekPending('fluxer', 'u')?.message).toBe(
            'other platform'
        );
    });

    it('drops pending reminders after the TTL', () => {
        const { service, advance } = setup();
        service.setPending('discord', 'u', pendingInput());
        advance(PENDING_REMINDER_TTL_MS - 1);
        expect(service.peekPending('discord', 'u')).not.toBeNull();
        advance(1);
        expect(service.takePending('discord', 'u')).toBeNull();
    });

    it('resolves the date in the zone and creates the reminder', async () => {
        const { service, reminders } = setup();
        const result = await service.createDateReminder(
            'fluxer',
            'u',
            { guildId: 'g', channelId: 'c', spec: TOMORROW, message: 'x' },
            'America/New_York'
        );
        // Oct 21 09:00 EDT is 13:00 UTC.
        const delayMs = Date.parse('2026-10-21T13:00:00Z') - NOW;
        expect(reminders.create).toHaveBeenCalledWith({
            platform: 'fluxer',
            userId: 'u',
            guildId: 'g',
            channelId: 'c',
            message: 'x',
            delayMs,
        });
        expect(result).toMatchObject({
            ok: true,
            delayMs,
            timeZone: 'America/New_York',
        });
    });

    it('refuses dates that do not exist or are already past', async () => {
        const { service, reminders } = setup();
        const input = { guildId: 'g', channelId: 'c', message: 'x' };
        expect(
            await service.createDateReminder(
                'discord',
                'u',
                {
                    ...input,
                    spec: {
                        kind: 'date',
                        year: 2027,
                        month: 2,
                        day: 29,
                        hour: 9,
                        minute: 0,
                        hasTime: false,
                    },
                },
                'UTC'
            )
        ).toEqual({ ok: false, reason: 'invalid_date' });
        expect(
            await service.createDateReminder(
                'discord',
                'u',
                {
                    ...input,
                    spec: {
                        kind: 'date',
                        year: 2020,
                        month: 10,
                        day: 26,
                        hour: 9,
                        minute: 0,
                        hasTime: false,
                    },
                },
                'UTC'
            )
        ).toEqual({ ok: false, reason: 'in_past' });
        expect(reminders.create).not.toHaveBeenCalled();
    });

    it('passes reminder service failures through', async () => {
        const { service, reminders } = setup();
        reminders.create.mockResolvedValueOnce({
            ok: false,
            reason: 'too_many',
        } as never);
        expect(
            await service.createDateReminder(
                'discord',
                'u',
                { guildId: 'g', channelId: 'c', spec: TOMORROW, message: 'x' },
                'UTC'
            )
        ).toEqual({ ok: false, reason: 'too_many' });
    });
});

describe('formatLocalDateTime', () => {
    const ms = Date.parse('2026-10-27T00:15:00Z');

    it('formats IANA zones', () => {
        expect(formatLocalDateTime(ms, 'America/New_York')).toBe(
            'Mon, Oct 26, 2026, 20:15'
        );
    });

    it('applies fixed offsets by hand', () => {
        expect(formatLocalDateTime(ms, 'UTC+05:30')).toBe(
            'Tue, Oct 27, 2026, 05:45'
        );
        expect(formatLocalDateTime(ms, 'UTC-03:00')).toBe(
            'Mon, Oct 26, 2026, 21:15'
        );
        expect(formatLocalDateTime(ms, 'UTC')).toBe('Tue, Oct 27, 2026, 00:15');
    });

    it('falls back to UTC for unknown zones', () => {
        expect(formatLocalDateTime(ms, 'Mars/Olympus')).toBe(
            'Tue, Oct 27, 2026, 00:15'
        );
    });
});
