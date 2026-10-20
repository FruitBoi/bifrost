import { describe, expect, it } from 'vitest';
import { Reminder } from '../../../src/db/entities/Reminder';
import {
    cutReminderShort,
    formatReminderDuration,
    formatReminderLine,
    formatReminderTime,
    REMINDER_PREVIEW_LENGTH,
} from '../../../src/services/reminders/reminderFormat';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatReminderDuration', () => {
    it.each<[number, string]>([
        [0, 'less than 1 minute'],
        [-5 * MINUTE, 'less than 1 minute'],
        [59 * 1000, 'less than 1 minute'],
        [MINUTE, '1 minute'],
        [MINUTE + 59 * 1000, '1 minute'],
        [2 * MINUTE, '2 minutes'],
        [HOUR, '1 hour'],
        [HOUR + 30 * MINUTE, '1 hour and 30 minutes'],
        [2 * DAY + 3 * HOUR + 5 * MINUTE, '2 days 3 hours and 5 minutes'],
        [7 * DAY, '1 week'],
        [8 * DAY, '1 week and 1 day'],
        [30 * DAY, '1 month'],
        [60 * DAY + 2 * HOUR, '2 months and 2 hours'],
        [365 * DAY, '1 year'],
        [365 * DAY + MINUTE, '1 year and 1 minute'],
        [3650 * DAY, '10 years'],
    ])('%d ms -> %j', (ms, expected) => {
        expect(formatReminderDuration(ms)).toBe(expected);
    });
});

describe('formatReminderTime', () => {
    const date = new Date(Date.UTC(2026, 9, 20, 7, 5, 9));

    it('uses a Discord timestamp on Discord', () => {
        expect(formatReminderTime(date, 'discord')).toBe(
            `<t:${Math.floor(date.getTime() / 1000)}:f>`
        );
        expect(formatReminderTime(new Date(1_700_000_000_500), 'discord')).toBe(
            '<t:1700000000:f>'
        );
    });

    it('uses a zero-padded UTC date on Fluxer', () => {
        expect(formatReminderTime(date, 'fluxer')).toBe('2026-10-20 07:05 UTC');
        expect(
            formatReminderTime(new Date(Date.UTC(2031, 0, 1, 23, 59)), 'fluxer')
        ).toBe('2031-01-01 23:59 UTC');
    });
});

describe('cutReminderShort', () => {
    it('leaves short messages and messages of exactly the limit alone', () => {
        expect(cutReminderShort('hello')).toBe('hello');
        const exact = 'a'.repeat(REMINDER_PREVIEW_LENGTH);
        expect(cutReminderShort(exact)).toBe(exact);
    });

    it('cuts longer messages and appends ...', () => {
        const long = 'a'.repeat(REMINDER_PREVIEW_LENGTH + 1);
        expect(cutReminderShort(long)).toBe(
            'a'.repeat(REMINDER_PREVIEW_LENGTH) + '...'
        );
        expect(cutReminderShort('abcdef', 3)).toBe('abc...');
    });

    it('collapses newlines and runs of whitespace', () => {
        expect(cutReminderShort('line one\nline  two\r\n\tthree')).toBe(
            'line one line two three'
        );
    });

    it('counts an emoji as one character', () => {
        const emoji = '🎉'.repeat(REMINDER_PREVIEW_LENGTH);
        expect(cutReminderShort(emoji)).toBe(emoji);
        expect(cutReminderShort(emoji + '🎉')).toBe(emoji + '...');
        expect(cutReminderShort('🎉🎉🎉🎉', 2)).toBe('🎉🎉...');
    });
});

describe('formatReminderLine', () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    const reminder: Reminder = {
        id: 7,
        platform: 'discord',
        userId: 'u1',
        guildId: 'g1',
        channelId: 'c1',
        message: 'buy milk',
        dueAt: new Date(now + HOUR + 30 * MINUTE),
        attempts: 0,
        createdAt: new Date(now),
    };

    it('formats a pending Discord reminder', () => {
        expect(formatReminderLine(reminder, '<#c1>', now)).toBe(
            `**7**: <#c1>: 'buy milk' - in 1 hour and 30 minutes (<t:${Math.floor(reminder.dueAt.getTime() / 1000)}:f>)`
        );
    });

    it('formats a pending Fluxer reminder with a UTC time', () => {
        expect(
            formatReminderLine(
                { ...reminder, platform: 'fluxer', message: 'x\ny' },
                'someone',
                now
            )
        ).toBe(
            "**7**: someone: 'x y' - in 1 hour and 30 minutes (2026-10-20 13:30 UTC)"
        );
    });

    it('cuts the message short', () => {
        const message = 'm'.repeat(80);
        expect(
            formatReminderLine({ ...reminder, message }, '<#c1>', now)
        ).toContain(`'${'m'.repeat(REMINDER_PREVIEW_LENGTH)}...'`);
    });

    it('says due now once overdue', () => {
        const overdue = { ...reminder, dueAt: new Date(now - MINUTE) };
        expect(formatReminderLine(overdue, '<#c1>', now)).toBe(
            `**7**: <#c1>: 'buy milk' - due now (<t:${Math.floor(overdue.dueAt.getTime() / 1000)}:f>)`
        );
        expect(
            formatReminderLine({ ...reminder, dueAt: new Date(now) }, 'x', now)
        ).toContain('- due now');
    });

    it('defaults to the current time', () => {
        const soon = {
            ...reminder,
            dueAt: new Date(Date.now() + 2 * DAY + 30 * MINUTE),
        };
        // The clock may tick over between here and the call.
        expect(formatReminderLine(soon, '<#c1>')).toMatch(
            /- in 2 days and (29|30) minutes \(/
        );
    });
});
