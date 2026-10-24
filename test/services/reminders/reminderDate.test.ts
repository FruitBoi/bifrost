import { describe, expect, it } from 'vitest';
import {
    formatTimeZone,
    parseReminderDate,
    parseTimeZone,
    resolveReminderDate,
    ReminderDateSpec,
} from '../../../src/services/reminders/reminderDate';

/** Saturday 2026-10-24 15:00 UTC: 11:00 EDT, 20:30 IST, Sunday 00:00 JST. */
const NOW = Date.parse('2026-10-24T15:00:00Z');

function parse(text: string): ReturnType<typeof parseReminderDate> {
    return parseReminderDate(text.split(/\s+/));
}

/** Parses and resolves `text`, returning the ISO instant (or null). */
function resolve(text: string, zone: string, now = NOW): string | null {
    const parsed = parse(text);
    if (parsed === null) throw new Error(`not a date: ${text}`);
    const ms = resolveReminderDate(parsed.spec, zone, now);
    return ms === null ? null : new Date(ms).toISOString();
}

describe('parseReminderDate', () => {
    it.each<[string, ReminderDateSpec, number]>([
        [
            'Oct 26 20:15 dinner',
            {
                kind: 'date',
                month: 10,
                day: 26,
                hour: 20,
                minute: 15,
                hasTime: true,
            },
            3,
        ],
        [
            'October 26th dinner',
            {
                kind: 'date',
                month: 10,
                day: 26,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            2,
        ],
        [
            'oct. 26th, 2027 at 8 pm party',
            {
                kind: 'date',
                year: 2027,
                month: 10,
                day: 26,
                hour: 20,
                minute: 0,
                hasTime: true,
            },
            6,
        ],
        [
            '26 Oct 7:30am x',
            {
                kind: 'date',
                month: 10,
                day: 26,
                hour: 7,
                minute: 30,
                hasTime: true,
            },
            3,
        ],
        [
            'on Monday at 7:30pm x',
            {
                kind: 'weekday',
                weekday: 1,
                hour: 19,
                minute: 30,
                hasTime: true,
            },
            4,
        ],
        [
            'next THURS noon x',
            {
                kind: 'weekday',
                weekday: 4,
                hour: 12,
                minute: 0,
                hasTime: true,
            },
            3,
        ],
        [
            'wed meeting',
            {
                kind: 'weekday',
                weekday: 3,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            1,
        ],
        [
            'monday oct 26 5pm x',
            {
                kind: 'date',
                month: 10,
                day: 26,
                hour: 17,
                minute: 0,
                hasTime: true,
            },
            4,
        ],
        [
            'sat 5 may x',
            {
                kind: 'date',
                month: 5,
                day: 5,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            3,
        ],
        [
            'tomorrow at the office',
            {
                kind: 'relativeDay',
                dayOffset: 1,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            1,
        ],
        [
            'tmrw 5 things to do',
            {
                kind: 'relativeDay',
                dayOffset: 1,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            1,
        ],
        [
            'tmr midnight x',
            {
                kind: 'relativeDay',
                dayOffset: 1,
                hour: 0,
                minute: 0,
                hasTime: true,
            },
            2,
        ],
        [
            'tonight movie',
            {
                kind: 'relativeDay',
                dayOffset: 0,
                hour: 20,
                minute: 0,
                hasTime: false,
            },
            1,
        ],
        [
            'Today 18:00 x',
            {
                kind: 'relativeDay',
                dayOffset: 0,
                hour: 18,
                minute: 0,
                hasTime: true,
            },
            2,
        ],
        [
            '2026-10-26 x',
            {
                kind: 'date',
                year: 2026,
                month: 10,
                day: 26,
                hour: 9,
                minute: 0,
                hasTime: false,
            },
            1,
        ],
        [
            '2026-10-26 at 20:15 x',
            {
                kind: 'date',
                year: 2026,
                month: 10,
                day: 26,
                hour: 20,
                minute: 15,
                hasTime: true,
            },
            3,
        ],
        [
            '2026-10-26T20:15 x',
            {
                kind: 'date',
                year: 2026,
                month: 10,
                day: 26,
                hour: 20,
                minute: 15,
                hasTime: true,
            },
            1,
        ],
        ['7pm x', { kind: 'time', hour: 19, minute: 0, hasTime: true }, 1],
        ['at 7 PM x', { kind: 'time', hour: 19, minute: 0, hasTime: true }, 3],
        ['12am x', { kind: 'time', hour: 0, minute: 0, hasTime: true }, 1],
        ['12pm x', { kind: 'time', hour: 12, minute: 0, hasTime: true }, 1],
        [
            '12:30 a.m. x',
            { kind: 'time', hour: 0, minute: 30, hasTime: true },
            2,
        ],
        ['0:05 x', { kind: 'time', hour: 0, minute: 5, hasTime: true }, 1],
    ])('parses %j', (text, spec, consumed) => {
        expect(parse(text)).toEqual({ spec, consumed });
    });

    it.each<string>([
        'Oct',
        'Oct dinner',
        'may I ask',
        'march on',
        'Feb 30',
        'Feb 29 2027',
        'Oct 32',
        'Oct 26 25:00',
        'tomorrow 7:60pm',
        '2026-13-01',
        '2026-02-30',
        '2026-10-26T24:00',
        '25:00',
        '13pm',
        '0am',
        '20',
        '20 dinner',
        'next week',
        'next oct 26',
        'on',
        'soon',
        '10/26',
    ])('rejects %j', (text) => {
        expect(parse(text)).toBeNull();
    });

    it('rejects no tokens', () => {
        expect(parseReminderDate([])).toBeNull();
    });
});

describe('resolveReminderDate', () => {
    describe('America/New_York (EDT until Nov 1)', () => {
        const zone = 'America/New_York';
        it.each<[string, string]>([
            ['Oct 26 20:15', '2026-10-27T00:15:00.000Z'],
            ['Oct 24 noon', '2026-10-24T16:00:00.000Z'],
            // Already past this year: next year.
            ['Oct 24 9am', '2027-10-24T13:00:00.000Z'],
            ['Jan 5', '2027-01-05T14:00:00.000Z'],
            ['Oct 26, 2027 8pm', '2027-10-27T00:00:00.000Z'],
            ['2026-11-02', '2026-11-02T14:00:00.000Z'],
            // DST ends 2026-11-01 02:00 EDT.
            ['Nov 1 12:30am', '2026-11-01T04:30:00.000Z'],
            ['Nov 1 3am', '2026-11-01T08:00:00.000Z'],
            // Inside the spring-forward gap: lands just after it.
            ['2027-03-14 02:30', '2027-03-14T07:30:00.000Z'],
            ['2027-03-14 03:30', '2027-03-14T07:30:00.000Z'],
            ['2027-03-14 01:30', '2027-03-14T06:30:00.000Z'],
            // Weekdays: today counts only while the time is ahead.
            ['saturday 5pm', '2026-10-24T21:00:00.000Z'],
            ['saturday 9am', '2026-10-31T13:00:00.000Z'],
            ['next saturday 9am', '2026-10-31T13:00:00.000Z'],
            ['monday', '2026-10-26T13:00:00.000Z'],
            ['sunday 9am', '2026-10-25T13:00:00.000Z'],
            ['friday', '2026-10-30T13:00:00.000Z'],
            ['tomorrow', '2026-10-25T13:00:00.000Z'],
            ['tonight', '2026-10-25T00:00:00.000Z'],
            ['today 8am', '2026-10-24T12:00:00.000Z'],
            // Bare times: today if ahead, otherwise tomorrow.
            ['7pm', '2026-10-24T23:00:00.000Z'],
            ['10am', '2026-10-25T14:00:00.000Z'],
            ['midnight', '2026-10-25T04:00:00.000Z'],
        ])('%j -> %s', (text, expected) => {
            expect(resolve(text, zone)).toBe(expected);
        });
    });

    it('keeps the wall-clock time across a DST change', () => {
        const monday = Date.parse('2026-10-26T15:00:00Z');
        const zone = 'America/New_York';
        expect(resolve('sunday 9am', zone, monday)).toBe(
            '2026-11-01T14:00:00.000Z'
        );
        expect(resolve('monday 9am', zone, monday)).toBe(
            '2026-11-02T14:00:00.000Z'
        );
    });

    it('does calendar arithmetic in the zone (Tokyo is already Sunday)', () => {
        const zone = 'Asia/Tokyo';
        expect(resolve('tomorrow', zone)).toBe('2026-10-26T00:00:00.000Z');
        expect(resolve('sunday 9am', zone)).toBe('2026-10-25T00:00:00.000Z');
        expect(resolve('saturday 9am', zone)).toBe('2026-10-31T00:00:00.000Z');
        expect(resolve('today 10:00', zone)).toBe('2026-10-25T01:00:00.000Z');
    });

    it('handles half-hour offsets', () => {
        // 20:30 IST now.
        expect(resolve('8pm', 'Asia/Kolkata')).toBe('2026-10-25T14:30:00.000Z');
        expect(resolve('9pm', 'Asia/Kolkata')).toBe('2026-10-24T15:30:00.000Z');
        // 11:30 local now.
        expect(resolve('tomorrow 7:30pm', 'UTC-03:30')).toBe(
            '2026-10-25T23:00:00.000Z'
        );
        expect(resolve('noon', 'UTC+05:30')).toBe('2026-10-25T06:30:00.000Z');
    });

    it('rolls over the year', () => {
        const now = Date.parse('2026-12-31T23:30:00Z');
        expect(resolve('tomorrow', 'UTC', now)).toBe(
            '2027-01-01T09:00:00.000Z'
        );
        expect(resolve('Jan 1 midnight', 'UTC', now)).toBe(
            '2027-01-01T00:00:00.000Z'
        );
        expect(resolve('Dec 31 11pm', 'UTC', now)).toBe(
            '2027-12-31T23:00:00.000Z'
        );
        expect(resolve('friday 9am', 'UTC', now)).toBe(
            '2027-01-01T09:00:00.000Z'
        );
        // Still Dec 31 in New York (18:30 EST).
        expect(resolve('tomorrow', 'America/New_York', now)).toBe(
            '2027-01-01T14:00:00.000Z'
        );
    });

    it('waits for a leap year for Feb 29', () => {
        expect(resolve('Feb 29', 'UTC')).toBe('2028-02-29T09:00:00.000Z');
        expect(resolve('Feb 29 2028', 'UTC')).toBe('2028-02-29T09:00:00.000Z');
    });

    it('returns null for impossible specs and unknown zones', () => {
        const base = { hour: 9, minute: 0, hasTime: false };
        expect(
            resolveReminderDate(
                { kind: 'date', year: 2027, month: 2, day: 29, ...base },
                'UTC',
                NOW
            )
        ).toBeNull();
        expect(
            resolveReminderDate(
                { kind: 'date', month: 2, day: 30, ...base },
                'UTC',
                NOW
            )
        ).toBeNull();
        expect(
            resolveReminderDate(
                { kind: 'date', month: 13, day: 1, ...base },
                'UTC',
                NOW
            )
        ).toBeNull();
        expect(
            resolveReminderDate(
                { kind: 'time', hour: 25, minute: 0, hasTime: true },
                'UTC',
                NOW
            )
        ).toBeNull();
        expect(
            resolveReminderDate(
                { kind: 'relativeDay', dayOffset: 1, ...base },
                'Mars/Olympus_Mons',
                NOW
            )
        ).toBeNull();
    });
});

describe('parseTimeZone', () => {
    it.each<[string, string]>([
        ['America/New_York', 'America/New_York'],
        ['america/new_york', 'America/New_York'],
        ['  EUROPE/LONDON ', 'Europe/London'],
        ['asia/kolkata', 'Asia/Kolkata'],
        ['UTC', 'UTC'],
        ['utc', 'UTC'],
        ['GMT', 'UTC'],
        ['Z', 'UTC'],
        ['UTC+2', 'UTC+02:00'],
        ['utc+2', 'UTC+02:00'],
        ['GMT-5', 'UTC-05:00'],
        ['+05:30', 'UTC+05:30'],
        ['+0530', 'UTC+05:30'],
        ['UTC-3:30', 'UTC-03:30'],
        ['UTC+14', 'UTC+14:00'],
        ['UTC+0', 'UTC'],
        ['EST', 'America/New_York'],
        ['edt', 'America/New_York'],
        ['ET', 'America/New_York'],
        ['CST', 'America/Chicago'],
        ['MT', 'America/Denver'],
        ['pst', 'America/Los_Angeles'],
        ['AKST', 'America/Anchorage'],
        ['HST', 'Pacific/Honolulu'],
        ['BST', 'Europe/London'],
        ['CEST', 'Europe/Berlin'],
        ['EET', 'Europe/Athens'],
        ['IST', 'Asia/Kolkata'],
        ['JST', 'Asia/Tokyo'],
        ['AEDT', 'Australia/Sydney'],
    ])('%j -> %j', (input, expected) => {
        expect(parseTimeZone(input)).toBe(expected);
    });

    it.each<string>([
        '',
        '   ',
        'Mars/Olympus_Mons',
        'nowhere',
        'UTC+15',
        'UTC+5:75',
        '+',
        'America/New York',
    ])('rejects %j', (input) => {
        expect(parseTimeZone(input)).toBeNull();
    });

    it('produces zones resolveReminderDate accepts', () => {
        for (const input of ['america/new_york', 'UTC-3:30', 'PST', 'Z']) {
            const zone = parseTimeZone(input);
            expect(zone).not.toBeNull();
            const spec = parse('tomorrow')?.spec;
            expect(spec).toBeDefined();
            expect(resolveReminderDate(spec!, zone!, NOW)).not.toBeNull();
        }
    });

    it('formats zones for display', () => {
        expect(formatTimeZone('America/New_York')).toBe('America/New_York');
        expect(formatTimeZone('UTC+05:30')).toBe('UTC+05:30');
    });
});
