import { describe, expect, it } from 'vitest';
import {
    CLEAN_COMMAND_NAMES,
    CleanOptions,
    MAX_CLEAN_COUNT,
    MAX_CLEAN_REGEX_LENGTH,
    parseCleanArgs,
    tokenizeCleanArgs,
} from '../../../src/services/clean/cleanArgs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const USER_ID = '123456789012345678';
const OTHER_ID = '987654321098765432';

/** The options for `clean <count>` without any filter. */
function bare(count: number): CleanOptions {
    return {
        count,
        userId: null,
        regex: null,
        invertRegex: false,
        maxAgeMs: null,
        minAgeMs: null,
        ignorePinned: false,
        attachmentsOnly: false,
        botsOnly: false,
        fromId: null,
        toId: null,
    };
}

function parseOk(raw: string): CleanOptions {
    const result = parseCleanArgs(raw);
    if (!result.ok) {
        throw new Error(
            `expected ${JSON.stringify(raw)} to parse, got ${JSON.stringify(result)}`
        );
    }
    return result.options;
}

describe('constants', () => {
    it('names clean first and its aliases after it', () => {
        expect(CLEAN_COMMAND_NAMES).toEqual(['clean', 'clear', 'cl']);
    });

    it('limits the count and the regex length', () => {
        expect(MAX_CLEAN_COUNT).toBe(100);
        expect(MAX_CLEAN_REGEX_LENGTH).toBe(256);
    });
});

describe('tokenizeCleanArgs', () => {
    it('splits on whitespace', () => {
        expect(tokenizeCleanArgs('10 -bots')).toEqual(['10', '-bots']);
        expect(tokenizeCleanArgs('10')).toEqual(['10']);
    });

    it('collapses runs of spaces, tabs and newlines', () => {
        expect(tokenizeCleanArgs('  10 \t -r\n\nfoo   ')).toEqual([
            '10',
            '-r',
            'foo',
        ]);
    });

    it('returns no tokens for empty or blank input', () => {
        expect(tokenizeCleanArgs('')).toEqual([]);
        expect(tokenizeCleanArgs('   ')).toEqual([]);
        expect(tokenizeCleanArgs('\n\t')).toEqual([]);
    });

    it('keeps double-quoted runs together without the quotes', () => {
        expect(tokenizeCleanArgs('5 -r "foo bar"')).toEqual([
            '5',
            '-r',
            'foo bar',
        ]);
        expect(tokenizeCleanArgs('-r "  padded  " 5')).toEqual([
            '-r',
            '  padded  ',
            '5',
        ]);
        expect(tokenizeCleanArgs('-r "line\nbreak"')).toEqual([
            '-r',
            'line\nbreak',
        ]);
        expect(tokenizeCleanArgs('"a" "b c" d')).toEqual(['a', 'b c', 'd']);
    });

    it('yields an empty token for an empty quoted string', () => {
        expect(tokenizeCleanArgs('-r ""')).toEqual(['-r', '']);
        expect(tokenizeCleanArgs('"" 5')).toEqual(['', '5']);
    });

    it('treats an unmatched quote as an ordinary character', () => {
        expect(tokenizeCleanArgs('-r "foo bar')).toEqual(['-r', '"foo', 'bar']);
        expect(tokenizeCleanArgs('-r foo" bar')).toEqual(['-r', 'foo"', 'bar']);
        expect(tokenizeCleanArgs('"')).toEqual(['"']);
    });

    it('does not interpret single quotes', () => {
        expect(tokenizeCleanArgs("-r 'foo bar'")).toEqual([
            '-r',
            "'foo",
            "bar'",
        ]);
    });
});

describe('parseCleanArgs positionals', () => {
    it('parses a bare count', () => {
        expect(parseCleanArgs('10')).toEqual({ ok: true, options: bare(10) });
        expect(parseCleanArgs('  10  ')).toEqual({
            ok: true,
            options: bare(10),
        });
    });

    it('accepts the lower and upper bounds of the count', () => {
        expect(parseOk('1').count).toBe(1);
        expect(parseOk(String(MAX_CLEAN_COUNT)).count).toBe(MAX_CLEAN_COUNT);
        expect(parseOk('100').count).toBe(100);
    });

    it.each(['0', '101', '-5', '-0', 'ten', '1.5', '0x10', '1e2', '+5', '10a'])(
        'rejects the count %s',
        (value) => {
            expect(parseCleanArgs(value)).toEqual({
                ok: false,
                reason: 'invalid_count',
                value,
            });
        }
    );

    it('rejects a count above the limit even by one', () => {
        expect(parseCleanArgs(String(MAX_CLEAN_COUNT + 1))).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: String(MAX_CLEAN_COUNT + 1),
        });
    });

    it('rejects a negative count even when switches follow', () => {
        expect(parseCleanArgs('-5 -bots')).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: '-5',
        });
        expect(parseCleanArgs('10 -5')).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: '-5',
        });
    });

    it('reports a missing count', () => {
        expect(parseCleanArgs('')).toEqual({
            ok: false,
            reason: 'missing_count',
        });
        expect(parseCleanArgs('   ')).toEqual({
            ok: false,
            reason: 'missing_count',
        });
        expect(parseCleanArgs('-bots')).toEqual({
            ok: false,
            reason: 'missing_count',
        });
        expect(parseCleanArgs('-r foo -nopin')).toEqual({
            ok: false,
            reason: 'missing_count',
        });
        expect(parseCleanArgs(`<@${USER_ID}>`)).toEqual({
            ok: false,
            reason: 'missing_count',
        });
        expect(parseCleanArgs(USER_ID)).toEqual({
            ok: false,
            reason: 'missing_count',
        });
    });

    it('takes a user mention after or before the count', () => {
        expect(parseCleanArgs(`10 <@${USER_ID}>`)).toEqual({
            ok: true,
            options: { ...bare(10), userId: USER_ID },
        });
        expect(parseCleanArgs(`<@${USER_ID}> 10`)).toEqual({
            ok: true,
            options: { ...bare(10), userId: USER_ID },
        });
    });

    it('takes a nickname mention (<@!id>)', () => {
        expect(parseOk(`<@!${USER_ID}> 10`).userId).toBe(USER_ID);
        expect(parseOk(`10 <@!${USER_ID}>`).userId).toBe(USER_ID);
    });

    it('takes a raw user ID after or before the count', () => {
        expect(parseCleanArgs(`10 ${USER_ID}`)).toEqual({
            ok: true,
            options: { ...bare(10), userId: USER_ID },
        });
        expect(parseCleanArgs(`${USER_ID} 10`)).toEqual({
            ok: true,
            options: { ...bare(10), userId: USER_ID },
        });
    });

    it('tells counts from IDs by digit length (15 digits and up is an ID)', () => {
        const fourteen = '12345678901234';
        const fifteen = '123456789012345';
        expect(fourteen).toHaveLength(14);
        expect(fifteen).toHaveLength(15);
        // A 14-digit number is a (far too large) count.
        expect(parseCleanArgs(fourteen)).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: fourteen,
        });
        expect(parseCleanArgs(`10 ${fourteen}`)).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: fourteen,
        });
        // A 15-digit number is a user ID.
        expect(parseCleanArgs(`10 ${fifteen}`)).toEqual({
            ok: true,
            options: { ...bare(10), userId: fifteen },
        });
        expect(parseCleanArgs(fifteen)).toEqual({
            ok: false,
            reason: 'missing_count',
        });
    });

    it('rejects two IDs because there is no count', () => {
        expect(parseCleanArgs(`${USER_ID} ${OTHER_ID}`)).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: OTHER_ID,
        });
        expect(parseCleanArgs(`<@${USER_ID}> <@${OTHER_ID}>`)).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: `<@${OTHER_ID}>`,
        });
    });

    it('rejects a second non-ID positional as an invalid user', () => {
        expect(parseCleanArgs('10 20')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: '20',
        });
        expect(parseCleanArgs('10 @bob')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: '@bob',
        });
        expect(parseCleanArgs('10 <@&123456789012345678>')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: '<@&123456789012345678>',
        });
        expect(parseCleanArgs('10 <#123456789012345678>')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: '<#123456789012345678>',
        });
        expect(parseCleanArgs(`${USER_ID} bob`)).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: 'bob',
        });
    });

    it('checks the shape of the user positional before the count value', () => {
        // Only the first non-ID positional is the count; the second is the user.
        expect(parseCleanArgs('ten bob')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: 'bob',
        });
        expect(parseCleanArgs(`ten <@${USER_ID}>`)).toEqual({
            ok: false,
            reason: 'invalid_count',
            value: 'ten',
        });
    });

    it('rejects a third positional', () => {
        expect(parseCleanArgs(`10 <@${USER_ID}> extra`)).toEqual({
            ok: false,
            reason: 'too_many_args',
            value: 'extra',
        });
        expect(parseCleanArgs('10 20 30')).toEqual({
            ok: false,
            reason: 'too_many_args',
            value: '30',
        });
        expect(parseCleanArgs(`10 -bots ${USER_ID} -nopin x`)).toEqual({
            ok: false,
            reason: 'too_many_args',
            value: 'x',
        });
    });

    it('treats a lone dash as a positional', () => {
        expect(parseCleanArgs('10 -')).toEqual({
            ok: false,
            reason: 'invalid_user',
            value: '-',
        });
    });
});

describe('parseCleanArgs switches', () => {
    it.each([
        ['-im', { invertRegex: true }],
        ['-nopin', { ignorePinned: true }],
        ['-a', { attachmentsOnly: true }],
        ['-bots', { botsOnly: true }],
    ] as const)('%s sets exactly its field', (flag, expected) => {
        expect(parseCleanArgs(`10 ${flag}`)).toEqual({
            ok: true,
            options: { ...bare(10), ...expected },
        });
    });

    it('-i alone is accepted and changes nothing', () => {
        expect(parseCleanArgs('10 -i')).toEqual({
            ok: true,
            options: bare(10),
        });
    });

    it('accepts switches before, between and after the positionals', () => {
        const expected = {
            ...bare(10),
            userId: USER_ID,
            botsOnly: true,
            ignorePinned: true,
        };
        expect(parseOk(`-bots -nopin 10 <@${USER_ID}>`)).toEqual(expected);
        expect(parseOk(`10 -bots <@${USER_ID}> -nopin`)).toEqual(expected);
        expect(parseOk(`10 <@${USER_ID}> -bots -nopin`)).toEqual(expected);
        expect(parseOk(`-bots <@${USER_ID}> -nopin 10`)).toEqual(expected);
    });

    it('matches switch names case-insensitively', () => {
        expect(parseOk('10 -NOPIN').ignorePinned).toBe(true);
        expect(parseOk('10 -Bots').botsOnly).toBe(true);
        expect(parseOk('10 -A').attachmentsOnly).toBe(true);
        expect(parseOk('10 -IM').invertRegex).toBe(true);
        expect(parseOk('10 -R foo').regex?.source).toBe('foo');
        expect(parseOk('10 -MA 1h').maxAgeMs).toBe(HOUR_MS);
        expect(parseOk('10 -MinAge 1h').minAgeMs).toBe(HOUR_MS);
        expect(parseOk(`10 -FROM ${USER_ID}`).fromId).toBe(USER_ID);
        expect(parseOk(`10 -To ${USER_ID}`).toId).toBe(USER_ID);
    });

    it('does not lower-case the values', () => {
        expect(parseOk('10 -r FOO').regex?.source).toBe('FOO');
    });

    it('rejects unknown switches', () => {
        expect(parseCleanArgs('10 -x')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-x',
        });
        expect(parseCleanArgs('10 --bots')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '--bots',
        });
        expect(parseCleanArgs('10 -5abc')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-5abc',
        });
        expect(parseCleanArgs('10 -r"foo"')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-r"foo"',
        });
        // The original spelling is reported.
        expect(parseCleanArgs('10 -Nope')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-Nope',
        });
    });

    it('reports the switch error before the positional errors', () => {
        expect(parseCleanArgs('-x').ok).toBe(false);
        expect(parseCleanArgs('-x')).toMatchObject({
            reason: 'unknown_switch',
        });
        expect(parseCleanArgs('1 2 3 -x')).toMatchObject({
            reason: 'unknown_switch',
        });
    });

    describe('-r', () => {
        it('compiles the pattern without flags', () => {
            const { regex } = parseOk('10 -r foo');
            expect(regex).toBeInstanceOf(RegExp);
            expect(regex?.source).toBe('foo');
            expect(regex?.flags).toBe('');
            expect(regex?.test('foo')).toBe(true);
            expect(regex?.test('FOO')).toBe(false);
        });

        it('adds the i flag only with -i', () => {
            const insensitive = parseOk('10 -r foo -i').regex;
            expect(insensitive?.flags).toBe('i');
            expect(insensitive?.test('FOO')).toBe(true);
            expect(parseOk('-i 10 -r foo').regex?.flags).toBe('i');

            const inverted = parseOk('10 -r foo -im').regex;
            expect(inverted?.flags).toBe('');
            expect(inverted?.test('FOO')).toBe(false);
        });

        it('-im sets invertRegex and -i does not', () => {
            expect(parseOk('10 -r foo -im')).toEqual({
                ...bare(10),
                regex: /foo/,
                invertRegex: true,
            });
            expect(parseOk('10 -r foo -i').invertRegex).toBe(false);
            expect(parseOk('10 -r foo -i -im')).toEqual({
                ...bare(10),
                regex: /foo/i,
                invertRegex: true,
            });
        });

        it('takes a double-quoted pattern with spaces', () => {
            expect(parseOk('10 -r "foo bar"').regex?.source).toBe('foo bar');
            expect(parseOk('10 -r "^\\s*$"').regex?.source).toBe('^\\s*$');
        });

        it('takes a value that starts with a dash', () => {
            expect(parseOk('10 -r -foo')).toEqual({
                ...bare(10),
                regex: /-foo/,
            });
            // Even when it looks like a switch, it is the pattern.
            expect(parseOk('10 -r -bots')).toEqual({
                ...bare(10),
                regex: /-bots/,
            });
        });

        it('reports a missing value', () => {
            expect(parseCleanArgs('10 -r')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-r',
            });
            expect(parseCleanArgs('10 -r ""')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-r',
            });
            expect(parseCleanArgs('-r')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-r',
            });
            // Reported with the canonical lower-case name.
            expect(parseCleanArgs('10 -R')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-r',
            });
        });

        it('rejects an invalid pattern with the engine detail', () => {
            const result = parseCleanArgs('10 -r [');
            expect(result).toMatchObject({
                ok: false,
                reason: 'invalid_regex',
                value: '[',
            });
            expect(result).toHaveProperty('detail', expect.any(String));
            if (result.ok || result.reason !== 'invalid_regex') {
                throw new Error('unreachable');
            }
            expect(result.detail.length).toBeGreaterThan(0);
            expect(parseCleanArgs('10 -r "(a"')).toMatchObject({
                ok: false,
                reason: 'invalid_regex',
                value: '(a',
            });
            expect(parseCleanArgs('10 -r "a{2,1}"')).toMatchObject({
                ok: false,
                reason: 'invalid_regex',
                value: 'a{2,1}',
            });
        });

        it('rejects a pattern longer than the limit', () => {
            const limit = 'a'.repeat(MAX_CLEAN_REGEX_LENGTH);
            const tooLong = 'a'.repeat(MAX_CLEAN_REGEX_LENGTH + 1);
            expect(parseOk(`10 -r ${limit}`).regex?.source).toBe(limit);
            expect(parseCleanArgs(`10 -r ${tooLong}`)).toEqual({
                ok: false,
                reason: 'invalid_regex',
                value: tooLong,
                detail: `pattern longer than ${MAX_CLEAN_REGEX_LENGTH} characters`,
            });
        });

        it('the last -r wins', () => {
            expect(parseOk('10 -r foo -r bar').regex?.source).toBe('bar');
        });
    });

    describe('-ma and -minage', () => {
        it('parse reminder-style durations', () => {
            expect(parseOk('10 -ma 1h30m').maxAgeMs).toBe(
                HOUR_MS + 30 * MINUTE_MS
            );
            expect(parseOk('10 -ma 1h30m').maxAgeMs).toBe(5_400_000);
            expect(parseOk('10 -minage 2d').minAgeMs).toBe(2 * DAY_MS);
            expect(parseOk('10 -ma 90s').maxAgeMs).toBe(90_000);
            expect(parseOk('10 -ma 1w').maxAgeMs).toBe(7 * DAY_MS);
        });

        it('treat a bare number as minutes', () => {
            expect(parseOk('10 -ma 30').maxAgeMs).toBe(30 * MINUTE_MS);
            expect(parseOk('10 -minage 1').minAgeMs).toBe(MINUTE_MS);
        });

        it('treat zero as no limit', () => {
            expect(parseOk('10 -ma 0')).toEqual(bare(10));
            expect(parseOk('10 -minage 0')).toEqual(bare(10));
            expect(parseOk('10 -ma 0h')).toEqual(bare(10));
        });

        it('set only their own field', () => {
            expect(parseOk('10 -ma 1h')).toEqual({
                ...bare(10),
                maxAgeMs: HOUR_MS,
            });
            expect(parseOk('10 -minage 1h')).toEqual({
                ...bare(10),
                minAgeMs: HOUR_MS,
            });
            expect(parseOk('10 -ma 2h -minage 1h')).toEqual({
                ...bare(10),
                maxAgeMs: 2 * HOUR_MS,
                minAgeMs: HOUR_MS,
            });
        });

        it.each([
            ['-ma', 'abc'],
            ['-ma', 'h1'],
            ['-ma', '1x'],
            ['-ma', '-1h'],
            ['-minage', 'abc'],
            ['-minage', '1.5h'],
        ])('%s %s is an invalid duration', (name, value) => {
            expect(parseCleanArgs(`10 ${name} ${value}`)).toEqual({
                ok: false,
                reason: 'invalid_duration',
                switch: name,
                value,
            });
        });

        it('report a missing value', () => {
            expect(parseCleanArgs('10 -ma')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-ma',
            });
            expect(parseCleanArgs('10 -minage')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-minage',
            });
        });

        it('the last value wins', () => {
            expect(parseOk('10 -ma 1h -ma 2h').maxAgeMs).toBe(2 * HOUR_MS);
            expect(parseOk('10 -ma 1h -ma 0').maxAgeMs).toBeNull();
        });
    });

    describe('-from and -to', () => {
        it('accept a snowflake and set only their own field', () => {
            expect(parseOk(`10 -from ${USER_ID}`)).toEqual({
                ...bare(10),
                fromId: USER_ID,
            });
            expect(parseOk(`10 -to ${USER_ID}`)).toEqual({
                ...bare(10),
                toId: USER_ID,
            });
            expect(parseOk(`10 -from ${USER_ID} -to ${OTHER_ID}`)).toEqual({
                ...bare(10),
                fromId: USER_ID,
                toId: OTHER_ID,
            });
        });

        it('accept short and 25-digit IDs', () => {
            expect(parseOk('10 -from 1').fromId).toBe('1');
            const long = '1'.repeat(25);
            expect(parseOk(`10 -to ${long}`).toId).toBe(long);
        });

        it('strip a mention wrapper from the ID', () => {
            expect(parseOk(`10 -from <@${USER_ID}>`).fromId).toBe(USER_ID);
            expect(parseOk(`10 -to <@!${USER_ID}>`).toId).toBe(USER_ID);
        });

        it.each([
            ['-from', 'abc'],
            ['-from', '1'.repeat(26)],
            ['-to', 'abc'],
            ['-to', '1'.repeat(26)],
            ['-to', '12a'],
            ['-to', '-1'],
            ['-to', '<#123456789012345678>'],
            ['-to', '<@&123456789012345678>'],
            ['-to', `https://discord.com/channels/1/2/${USER_ID}`],
        ])('%s %s is an invalid message ID', (name, value) => {
            expect(parseCleanArgs(`10 ${name} ${value}`)).toEqual({
                ok: false,
                reason: 'invalid_message_id',
                switch: name,
                value,
            });
        });

        it('report a missing value', () => {
            expect(parseCleanArgs('10 -from')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-from',
            });
            expect(parseCleanArgs('10 -to')).toEqual({
                ok: false,
                reason: 'missing_switch_value',
                switch: '-to',
            });
        });

        it('the last value wins', () => {
            expect(parseOk(`10 -to ${USER_ID} -to ${OTHER_ID}`).toId).toBe(
                OTHER_ID
            );
        });

        it('do not consume the ID as a positional', () => {
            expect(parseOk(`10 -from ${USER_ID}`).userId).toBeNull();
            expect(parseOk(`${USER_ID} -from ${OTHER_ID} 10`)).toEqual({
                ...bare(10),
                userId: USER_ID,
                fromId: OTHER_ID,
            });
        });
    });

    it('a value switch consumes a quoted token that would otherwise be a switch', () => {
        expect(parseOk('10 -r "-nopin"')).toEqual({
            ...bare(10),
            regex: /-nopin/,
        });
    });

    it('a value switch at the end consumes nothing and fails', () => {
        expect(parseCleanArgs('10 -bots -ma')).toEqual({
            ok: false,
            reason: 'missing_switch_value',
            switch: '-ma',
        });
    });

    it('validates in the order regex, durations, IDs', () => {
        expect(parseCleanArgs('10 -r [ -ma abc -to abc')).toMatchObject({
            reason: 'invalid_regex',
        });
        expect(parseCleanArgs('10 -r a -ma abc -to abc')).toMatchObject({
            reason: 'invalid_duration',
        });
        expect(parseCleanArgs('10 -r a -ma 1h -to abc')).toMatchObject({
            reason: 'invalid_message_id',
        });
        // The count is checked before any switch value.
        expect(parseCleanArgs('0 -r [')).toMatchObject({
            reason: 'invalid_count',
        });
    });

    it('parses a kitchen-sink invocation', () => {
        const raw = [
            '-bots',
            '50',
            '-r',
            '"hello world"',
            '-i',
            '-im',
            `<@!${USER_ID}>`,
            '-ma',
            '2d',
            '-minage',
            '1h30m',
            '-nopin',
            '-a',
            '-from',
            USER_ID,
            '-to',
            `<@${OTHER_ID}>`,
        ].join(' ');
        expect(parseCleanArgs(raw)).toEqual({
            ok: true,
            options: {
                count: 50,
                userId: USER_ID,
                regex: /hello world/i,
                invertRegex: true,
                maxAgeMs: 2 * DAY_MS,
                minAgeMs: HOUR_MS + 30 * MINUTE_MS,
                ignorePinned: true,
                attachmentsOnly: true,
                botsOnly: true,
                fromId: USER_ID,
                toId: OTHER_ID,
            },
        });
    });

    it('is not confused by newlines and tabs in the raw text', () => {
        expect(parseOk('10\n-bots\t-nopin\n')).toEqual({
            ...bare(10),
            botsOnly: true,
            ignorePinned: true,
        });
    });
});
