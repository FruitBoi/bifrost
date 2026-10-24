import { describe, expect, it } from 'vitest';
import {
    parseCommandTrigger,
    stripCommandInvocation,
} from '../../src/commands/commandTrigger';

const prefixes = ['?', '!'];
const names = ['clean', 'clear', 'cl'] as const;

describe('parseCommandTrigger', () => {
    it('recognises ?clean with its arguments', () => {
        expect(parseCommandTrigger('?clean 10 -bots', prefixes, names)).toEqual(
            { command: 'clean', rawArgs: '10 -bots' }
        );
    });

    it('recognises !clear without arguments', () => {
        expect(parseCommandTrigger('!clear', prefixes, names)).toEqual({
            command: 'clear',
            rawArgs: '',
        });
        expect(parseCommandTrigger('!clear   ', prefixes, names)).toEqual({
            command: 'clear',
            rawArgs: '',
        });
        expect(parseCommandTrigger('!clear\n', prefixes, names)).toEqual({
            command: 'clear',
            rawArgs: '',
        });
    });

    it.each([...names])('recognises %s with every prefix', (name) => {
        expect(parseCommandTrigger(`?${name}`, prefixes, names)?.command).toBe(
            name
        );
        expect(parseCommandTrigger(`!${name} a b`, prefixes, names)).toEqual({
            command: name,
            rawArgs: 'a b',
        });
    });

    it('matches the command word case-insensitively', () => {
        expect(parseCommandTrigger('?CLEAN 10', prefixes, names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('?Clear 10', prefixes, names)).toEqual({
            command: 'clear',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('!cL 10', prefixes, names)).toEqual({
            command: 'cl',
            rawArgs: '10',
        });
    });

    it('returns the canonical spelling from commandNames, not the typed word', () => {
        const mixed = ['Clean', 'CLEAR'] as const;
        expect(parseCommandTrigger('?clean 10', prefixes, mixed)).toEqual({
            command: 'Clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('?CLEAN 10', prefixes, mixed)).toEqual({
            command: 'Clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('?clear 10', prefixes, mixed)).toEqual({
            command: 'CLEAR',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('?cl 10', prefixes, mixed)).toBeNull();
    });

    it('allows whitespace between the prefix and the command word', () => {
        // Phone keyboards add a space and a capital after punctuation.
        expect(parseCommandTrigger('? Clean 10', prefixes, names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('! Clear', prefixes, names)).toEqual({
            command: 'clear',
            rawArgs: '',
        });
        expect(parseCommandTrigger('?  \tcl 10', prefixes, names)).toEqual({
            command: 'cl',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('?\nclean 10', prefixes, names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('? ', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?   ', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('? cleanup 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('? ping', prefixes, names)).toBeNull();
        // The whitespace is not part of the prefix match: '?' must still be first.
        expect(parseCommandTrigger(' ? clean 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('\n?clean 10', prefixes, names)).toBeNull();
    });

    it('requires the command word to end at whitespace or the end', () => {
        expect(parseCommandTrigger('?cleanup 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?cleanup', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?clean10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?clearly', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?cl10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?clean,10', prefixes, names)).toBeNull();
    });

    it('does not match a prefix of a command word', () => {
        expect(parseCommandTrigger('?c 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?cle 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?clea 10', prefixes, names)).toBeNull();
    });

    it('keeps the arguments verbatim apart from the leading whitespace', () => {
        expect(
            parseCommandTrigger('?clean 10  -r "a  b"\nline', prefixes, names)
        ).toEqual({ command: 'clean', rawArgs: '10  -r "a  b"\nline' });
        expect(
            parseCommandTrigger('?clean\n10 line\nmore  ', prefixes, names)
        ).toEqual({ command: 'clean', rawArgs: '10 line\nmore  ' });
        expect(
            parseCommandTrigger('?clean \t\n 10\t-bots', prefixes, names)
        ).toEqual({ command: 'clean', rawArgs: '10\t-bots' });
        // Trailing whitespace after the arguments is kept too.
        expect(parseCommandTrigger('?clean 10 ', prefixes, names)).toEqual({
            command: 'clean',
            rawArgs: '10 ',
        });
    });

    it('tries the prefixes in order and falls through to a later one', () => {
        expect(parseCommandTrigger('!clean 10', ['?', '!'], names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        // '!' matches first but 'b' is not a command; '!b ' then matches.
        expect(
            parseCommandTrigger('!b clean 10', ['!', '?', '!b '], names)
        ).toEqual({ command: 'clean', rawArgs: '10' });
        expect(
            parseCommandTrigger('!b clean 10', ['!b ', '?', '!'], names)
        ).toEqual({ command: 'clean', rawArgs: '10' });
        expect(parseCommandTrigger('??clean 10', ['?', '??'], names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('??clean 10', ['??', '?'], names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
    });

    it('does not treat the bot prefix word as a command', () => {
        expect(parseCommandTrigger('!b clean 10', ['!'], names)).toBeNull();
        expect(parseCommandTrigger('!b', ['!', '!b '], names)).toBeNull();
        expect(parseCommandTrigger('!b ', ['!', '!b '], names)).toBeNull();
    });

    it('only accepts command names from the given list', () => {
        expect(
            parseCommandTrigger('?remindme 1h x', prefixes, names)
        ).toBeNull();
        expect(parseCommandTrigger('?clean 10', prefixes, [])).toBeNull();
        expect(
            parseCommandTrigger('?clean 10', prefixes, ['remindme'])
        ).toBeNull();
        expect(
            parseCommandTrigger('?clean 10', prefixes, ['remindme', 'clean'])
        ).toEqual({ command: 'clean', rawArgs: '10' });
    });

    it('ignores empty prefixes and an empty prefix list', () => {
        expect(parseCommandTrigger('?clean 10', [], names)).toBeNull();
        expect(parseCommandTrigger('clean 10', [''], names)).toBeNull();
        expect(parseCommandTrigger('?clean 10', ['', '?'], names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
    });

    it('recognises typed slash commands with the / prefix', () => {
        const slash = ['!', '/'];
        expect(parseCommandTrigger('/clean 10', slash, names)).toEqual({
            command: 'clean',
            rawArgs: '10',
        });
        expect(parseCommandTrigger('/shrug', slash, names)).toBeNull();
        expect(
            parseCommandTrigger('see /usr/bin/clean', slash, names)
        ).toBeNull();
    });

    it('returns null for non-triggers and empty content', () => {
        expect(parseCommandTrigger('clean 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?ping', prefixes, names)).toBeNull();
        expect(
            parseCommandTrigger('hello ?clean 10', prefixes, names)
        ).toBeNull();
        expect(parseCommandTrigger(' ?clean 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('!', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('?!clean 10', prefixes, names)).toBeNull();
        expect(parseCommandTrigger('', prefixes, names)).toBeNull();
        expect(parseCommandTrigger(null, prefixes, names)).toBeNull();
        expect(parseCommandTrigger(undefined, prefixes, names)).toBeNull();
    });
});

describe('stripCommandInvocation', () => {
    const all = ['!b ', '?', '!'];

    it('returns the raw argument text for the bot prefix and short triggers', () => {
        expect(stripCommandInvocation('!b clean 10 -bots', all, names)).toBe(
            '10 -bots'
        );
        expect(stripCommandInvocation('?clean 10 -bots', all, names)).toBe(
            '10 -bots'
        );
        expect(stripCommandInvocation('! Clear 10 -bots', all, names)).toBe(
            '10 -bots'
        );
        expect(stripCommandInvocation('!cl 10  -r "a b"\ny', all, names)).toBe(
            '10  -r "a b"\ny'
        );
        expect(stripCommandInvocation('!b clean', all, names)).toBe('');
        expect(stripCommandInvocation('? Clean 10', all, names)).toBe('10');
        expect(stripCommandInvocation('!b  Clean 10', all, names)).toBe('10');
    });

    it('returns null when the content is not an invocation of the commands', () => {
        expect(
            stripCommandInvocation('!b remindme 1h x', all, names)
        ).toBeNull();
        expect(stripCommandInvocation('!b ping', all, names)).toBeNull();
        expect(stripCommandInvocation('!b cleanup 10', all, names)).toBeNull();
        expect(stripCommandInvocation('clean 10', all, names)).toBeNull();
        expect(stripCommandInvocation('', all, names)).toBeNull();
        expect(stripCommandInvocation(null, all, names)).toBeNull();
        expect(stripCommandInvocation(undefined, all, names)).toBeNull();
        expect(stripCommandInvocation('!b clean 10', [], names)).toBeNull();
        expect(stripCommandInvocation('!b clean 10', all, [])).toBeNull();
    });
});
