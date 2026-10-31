import { describe, expect, it } from 'vitest';
import {
    parseReminderTrigger,
    REMINDER_COMMAND_NAMES,
    stripReminderInvocation,
} from '../../src/commands/reminderTrigger';

const prefixes = ['?', '!'];

describe('parseReminderTrigger', () => {
    it('recognises ?remindme with its arguments', () => {
        expect(parseReminderTrigger('?remindme 1h x', prefixes)).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
    });

    it('recognises !reminders without arguments', () => {
        expect(parseReminderTrigger('!reminders', prefixes)).toEqual({
            command: 'reminders',
            rawArgs: '',
        });
        expect(parseReminderTrigger('!reminders   ', prefixes)).toEqual({
            command: 'reminders',
            rawArgs: '',
        });
    });

    it('lower-cases the command word', () => {
        expect(parseReminderTrigger('?REMINDME 1h x', prefixes)).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
        expect(parseReminderTrigger('?Reminder delete 3', prefixes)).toEqual({
            command: 'reminder',
            rawArgs: 'delete 3',
        });
    });

    it('allows whitespace between the prefix and the command word', () => {
        // Phone keyboards add a space and a capital after punctuation.
        expect(parseReminderTrigger('? Remindme 1h x', prefixes)).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
        expect(parseReminderTrigger('! Reminders', prefixes)).toEqual({
            command: 'reminders',
            rawArgs: '',
        });
        expect(
            parseReminderTrigger('?  \treminder delete 3', prefixes)
        ).toEqual({ command: 'reminder', rawArgs: 'delete 3' });
        expect(parseReminderTrigger('?\nremindme 1h x', prefixes)).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
        expect(parseReminderTrigger('? ', prefixes)).toBeNull();
        expect(parseReminderTrigger('? remindmeow', prefixes)).toBeNull();
        expect(parseReminderTrigger('? ping', prefixes)).toBeNull();
        // The whitespace is not part of the prefix match: '?' must still be first.
        expect(parseReminderTrigger(' ? remindme 1h', prefixes)).toBeNull();
    });

    it.each([...REMINDER_COMMAND_NAMES])('recognises %s', (name) => {
        expect(parseReminderTrigger(`?${name}`, prefixes)?.command).toBe(name);
        expect(parseReminderTrigger(`!${name} a b`, prefixes)).toEqual({
            command: name,
            rawArgs: 'a b',
        });
    });

    it('recognises the remindmr typo alias (issue #49)', () => {
        expect(parseReminderTrigger('?remindmr 1h x', prefixes)).toEqual({
            command: 'remindmr',
            rawArgs: '1h x',
        });
        expect(parseReminderTrigger('? Remindmr 1h', prefixes)?.command).toBe(
            'remindmr'
        );
    });

    it('recognises the timezone command and its alias (issue #27)', () => {
        expect(
            parseReminderTrigger('? Timezone Europe/London', prefixes)
        ).toEqual({ command: 'timezone', rawArgs: 'Europe/London' });
        expect(parseReminderTrigger('?tz', prefixes)).toEqual({
            command: 'tz',
            rawArgs: '',
        });
        expect(parseReminderTrigger('?tzz', prefixes)).toBeNull();
    });

    it('requires the command word to end at whitespace or the end', () => {
        expect(parseReminderTrigger('?remindmeow', prefixes)).toBeNull();
        expect(parseReminderTrigger('?remindme1h x', prefixes)).toBeNull();
        expect(parseReminderTrigger('?reminderss', prefixes)).toBeNull();
    });

    it('keeps newlines inside the arguments but strips leading whitespace', () => {
        expect(parseReminderTrigger('?remindme 1h x\nline', prefixes)).toEqual({
            command: 'remindme',
            rawArgs: '1h x\nline',
        });
        expect(
            parseReminderTrigger('?remindme\n1h line\nmore  ', prefixes)
        ).toEqual({ command: 'remindme', rawArgs: '1h line\nmore  ' });
    });

    it('tries the prefixes in order and falls through to a later one', () => {
        expect(parseReminderTrigger('!remindme 1h x', ['?', '!'])).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
        // '!' matches first but '!b' is not a command; '!b ' then matches.
        expect(
            parseReminderTrigger('!b remindme 1h x', ['!', '?', '!b '])
        ).toEqual({ command: 'remindme', rawArgs: '1h x' });
        expect(parseReminderTrigger('??remindme 1h', ['?', '??'])).toEqual({
            command: 'remindme',
            rawArgs: '1h',
        });
    });

    it('ignores empty prefixes and an empty prefix list', () => {
        expect(parseReminderTrigger('?remindme 1h x', [])).toBeNull();
        expect(parseReminderTrigger('remindme 1h x', [''])).toBeNull();
        expect(parseReminderTrigger('?remindme 1h x', ['', '?'])).toEqual({
            command: 'remindme',
            rawArgs: '1h x',
        });
    });

    it('returns null for non-triggers and empty content', () => {
        expect(parseReminderTrigger('remindme 1h x', prefixes)).toBeNull();
        expect(parseReminderTrigger('?ping', prefixes)).toBeNull();
        expect(parseReminderTrigger('hello ?remindme 1h', prefixes)).toBeNull();
        expect(parseReminderTrigger(' ?remindme 1h', prefixes)).toBeNull();
        expect(parseReminderTrigger('?', prefixes)).toBeNull();
        expect(parseReminderTrigger('', prefixes)).toBeNull();
        expect(parseReminderTrigger(null, prefixes)).toBeNull();
        expect(parseReminderTrigger(undefined, prefixes)).toBeNull();
    });
});

describe('stripReminderInvocation', () => {
    const all = ['!b ', '?', '!'];

    it('returns the raw argument text for the bot prefix and short triggers', () => {
        expect(stripReminderInvocation('!b remindme 1h x', all)).toBe('1h x');
        expect(stripReminderInvocation('?remindme 1h x', all)).toBe('1h x');
        expect(stripReminderInvocation('!remindme 1h  x\ny', all)).toBe(
            '1h  x\ny'
        );
        expect(stripReminderInvocation('!b reminders', all)).toBe('');
        expect(stripReminderInvocation('? Remindme 1h x', all)).toBe('1h x');
        expect(stripReminderInvocation('!b  Remindme 1h x', all)).toBe('1h x');
    });

    it('returns null when the content is not a reminder invocation', () => {
        expect(stripReminderInvocation('!b ping', all)).toBeNull();
        expect(stripReminderInvocation('remindme 1h x', all)).toBeNull();
        expect(stripReminderInvocation(null, all)).toBeNull();
        expect(stripReminderInvocation('!b remindme 1h x', [])).toBeNull();
    });
});
