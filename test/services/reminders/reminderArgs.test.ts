import { describe, expect, it } from 'vitest';
import {
    extractChannelId,
    parseDuration,
    parseReminderDeleteArgs,
    parseRemindMeArgs,
} from '../../../src/services/reminders/reminderArgs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('parseDuration', () => {
    it.each<[string, number]>([
        ['1h30min', 90 * MINUTE],
        ['1day3h', DAY + 3 * HOUR],
        ['2w', 14 * DAY],
        ['1mo', 30 * DAY],
        ['1mon', 30 * DAY],
        ['1month', 30 * DAY],
        ['1y', 365 * DAY],
        ['1year', 365 * DAY],
        ['10y', 3650 * DAY],
        ['90', 90 * MINUTE],
        ['0', 0],
        ['10s', 10 * SECOND],
        ['10sec', 10 * SECOND],
        ['1h30', HOUR + 30 * MINUTE],
        ['1 h 30 m', HOUR + 30 * MINUTE],
        ['1min', MINUTE],
        ['1m', MINUTE],
        ['1minute', MINUTE],
        ['3hours', 3 * HOUR],
        ['2days', 2 * DAY],
        ['1week', 7 * DAY],
        ['1H', HOUR],
        ['2dh', 2 * DAY],
        ['1h,30m', HOUR + 30 * MINUTE],
        ['2 Days', 2 * DAY],
        [
            '1y2mo3w4d5h6m7s',
            365 * DAY +
                60 * DAY +
                21 * DAY +
                4 * DAY +
                5 * HOUR +
                6 * MINUTE +
                7 * SECOND,
        ],
    ])('parses %j', (input, expected) => {
        expect(parseDuration(input)).toBe(expected);
    });

    it.each<string>([
        '',
        ' ',
        'abc',
        'h30m',
        'h',
        'm',
        '-1h',
        '+1h',
        '1x',
        '1h30x',
        '1.5h',
        '99999999999999999999h',
        '9007199254740991y',
    ])('rejects %j', (input) => {
        expect(parseDuration(input)).toBeNull();
    });
});

describe('parseRemindMeArgs', () => {
    it('parses time and message', () => {
        expect(parseRemindMeArgs('1h do the thing')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: HOUR },
            message: 'do the thing',
            channelRef: null,
        });
    });

    it('takes the time as a single token and keeps the rest as the message', () => {
        expect(parseRemindMeArgs('1h 30m text')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: HOUR },
            message: '30m text',
            channelRef: null,
        });
    });

    it('preserves inner whitespace and newlines of the message', () => {
        expect(
            parseRemindMeArgs('  10m  first line\n  second   line \n')
        ).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 10 * MINUTE },
            message: 'first line\n  second   line',
            channelRef: null,
        });
    });

    it('accepts a leading -channel switch', () => {
        expect(parseRemindMeArgs('-channel <#123> 2d buy milk')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 2 * DAY },
            message: 'buy milk',
            channelRef: '<#123>',
        });
        expect(parseRemindMeArgs('-CHANNEL general 2d buy milk')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 2 * DAY },
            message: 'buy milk',
            channelRef: 'general',
        });
    });

    it('accepts a trailing -channel switch', () => {
        expect(parseRemindMeArgs('2d buy milk -channel 456')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 2 * DAY },
            message: 'buy milk',
            channelRef: '456',
        });
        expect(parseRemindMeArgs('2d buy\nmilk   -Channel <#456>  ')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 2 * DAY },
            message: 'buy\nmilk',
            channelRef: '<#456>',
        });
    });

    it('does not treat -channel in the middle of the message as a switch', () => {
        expect(parseRemindMeArgs('1h set the -channel topic later')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: HOUR },
            message: 'set the -channel topic later',
            channelRef: null,
        });
        expect(parseRemindMeArgs('1h -channel foo bar baz')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: HOUR },
            message: '-channel foo bar baz',
            channelRef: null,
        });
    });

    it('reports a -channel switch without a reference', () => {
        expect(parseRemindMeArgs('-channel')).toEqual({
            ok: false,
            reason: 'missing_channel',
        });
        expect(parseRemindMeArgs('1h text -channel')).toEqual({
            ok: false,
            reason: 'missing_channel',
        });
    });

    it('reports a missing time', () => {
        expect(parseRemindMeArgs('')).toEqual({
            ok: false,
            reason: 'missing_time',
        });
        expect(parseRemindMeArgs('   ')).toEqual({
            ok: false,
            reason: 'missing_time',
        });
        expect(parseRemindMeArgs('-channel <#1>')).toEqual({
            ok: false,
            reason: 'missing_time',
        });
    });

    it('reports an invalid time', () => {
        expect(parseRemindMeArgs('soon text')).toEqual({
            ok: false,
            reason: 'invalid_time',
        });
        expect(parseRemindMeArgs('h30m text')).toEqual({
            ok: false,
            reason: 'invalid_time',
        });
        expect(parseRemindMeArgs('1x text')).toEqual({
            ok: false,
            reason: 'invalid_time',
        });
    });

    it('reports a missing message', () => {
        expect(parseRemindMeArgs('1h')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
        expect(parseRemindMeArgs('1h   ')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
        expect(parseRemindMeArgs('-channel <#1> 1h')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
        expect(parseRemindMeArgs('1h -channel <#1>')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
    });

    it('accepts a zero duration (the service rejects it later)', () => {
        expect(parseRemindMeArgs('0 text')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 0 },
            message: 'text',
            channelRef: null,
        });
    });
});

describe('parseRemindMeArgs with dates (issue #27)', () => {
    it('parses a month-day with a time', () => {
        expect(parseRemindMeArgs('Oct 26 20:15 dinner')).toEqual({
            ok: true,
            when: {
                kind: 'date',
                spec: {
                    kind: 'date',
                    month: 10,
                    day: 26,
                    hour: 20,
                    minute: 15,
                    hasTime: true,
                },
            },
            message: 'dinner',
            channelRef: null,
        });
    });

    it('parses a weekday with a time', () => {
        expect(parseRemindMeArgs('Monday 7pm call mom')).toEqual({
            ok: true,
            when: {
                kind: 'date',
                spec: {
                    kind: 'weekday',
                    weekday: 1,
                    hour: 19,
                    minute: 0,
                    hasTime: true,
                },
            },
            message: 'call mom',
            channelRef: null,
        });
    });

    it('parses tomorrow without a time', () => {
        expect(parseRemindMeArgs('tomorrow take out trash')).toEqual({
            ok: true,
            when: {
                kind: 'date',
                spec: {
                    kind: 'relativeDay',
                    dayOffset: 1,
                    hour: 9,
                    minute: 0,
                    hasTime: false,
                },
            },
            message: 'take out trash',
            channelRef: null,
        });
    });

    it('keeps the message whitespace after a multi-token date', () => {
        const parsed = parseRemindMeArgs(
            'next friday at 5:30 pm  line one\n  line two '
        );
        expect(parsed.ok && parsed.message).toBe('line one\n  line two');
    });

    it('combines dates with -channel', () => {
        const leading = parseRemindMeArgs('-channel <#9> tomorrow 8am standup');
        expect(leading.ok && leading.channelRef).toBe('<#9>');
        expect(leading.ok && leading.message).toBe('standup');
        const trailing = parseRemindMeArgs('Oct 26 party -channel general');
        expect(trailing.ok && trailing.channelRef).toBe('general');
        expect(trailing.ok && trailing.message).toBe('party');
    });

    it('reads a bare number with a meridiem or month as a date', () => {
        const pm = parseRemindMeArgs('7 pm call');
        expect(pm.ok && pm.when).toEqual({
            kind: 'date',
            spec: { kind: 'time', hour: 19, minute: 0, hasTime: true },
        });
        const dayMonth = parseRemindMeArgs('26 Oct party');
        expect(dayMonth.ok && dayMonth.when.kind).toBe('date');
        expect(dayMonth.ok && dayMonth.message).toBe('party');
        expect(parseRemindMeArgs('20 minutes left')).toEqual({
            ok: true,
            when: { kind: 'duration', delayMs: 20 * MINUTE },
            message: 'minutes left',
            channelRef: null,
        });
    });

    it('reports a date without a message', () => {
        expect(parseRemindMeArgs('tomorrow')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
        expect(parseRemindMeArgs('Oct 26 20:15 -channel <#1>')).toEqual({
            ok: false,
            reason: 'missing_message',
        });
    });

    it('reports invalid dates and times', () => {
        for (const raw of [
            'Feb 30 text',
            'Oct 32 text',
            'Oct 26 25:00 text',
            '13pm text',
            'may I ask',
            'next week text',
        ]) {
            expect(parseRemindMeArgs(raw)).toEqual({
                ok: false,
                reason: 'invalid_time',
            });
        }
    });
});

describe('extractChannelId', () => {
    const id = '123456789012345678';
    it.each<[string, string | null]>([
        [`<#${id}>`, id],
        [id, id],
        [` <#${id}> `, id],
        [`https://discord.com/channels/111111111111111111/${id}`, id],
        [`https://fluxer.app/channels/111111111111111111/${id}`, id],
        ['general', null],
        ['#general', null],
        [`<@${id}>`, null],
        ['<#>', null],
        ['<#12a>', null],
        ['', null],
    ])('%j -> %j', (ref, expected) => {
        expect(extractChannelId(ref)).toBe(expected);
    });
});

describe('parseReminderDeleteArgs', () => {
    it('parses a reminder id', () => {
        expect(parseReminderDeleteArgs('12')).toEqual({
            all: false,
            id: 12,
            invalidId: false,
        });
        expect(parseReminderDeleteArgs('  7  extra')).toEqual({
            all: false,
            id: 7,
            invalidId: false,
        });
    });

    it('reports when nothing was given', () => {
        expect(parseReminderDeleteArgs('')).toEqual({
            all: false,
            id: null,
            invalidId: false,
        });
        expect(parseReminderDeleteArgs('   ')).toEqual({
            all: false,
            id: null,
            invalidId: false,
        });
    });

    it('recognises -a anywhere, case-insensitively', () => {
        expect(parseReminderDeleteArgs('-a')).toEqual({
            all: true,
            id: null,
            invalidId: false,
        });
        expect(parseReminderDeleteArgs('-A')).toEqual({
            all: true,
            id: null,
            invalidId: false,
        });
        expect(parseReminderDeleteArgs('3 -a')).toEqual({
            all: true,
            id: 3,
            invalidId: false,
        });
        expect(parseReminderDeleteArgs('-a 3')).toEqual({
            all: true,
            id: 3,
            invalidId: false,
        });
    });

    it.each<string>(['abc', '0', '-1', '1.5', '#4', '99999999999999999999'])(
        'flags %j as an invalid id',
        (raw) => {
            expect(parseReminderDeleteArgs(raw)).toEqual({
                all: false,
                id: null,
                invalidId: true,
            });
        }
    );
});
