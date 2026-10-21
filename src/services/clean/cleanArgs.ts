/**
 * Argument parsing for the `clean` command (issue #12), modelled on YAGPDB's
 * `clean` (aliases `clear`, `cl`):
 *
 *     clean <num> [user] [switches]      clean [user] <num> [switches]
 *
 * `num` is the number of messages to delete (1–100) and `user` an optional
 * mention or user ID that limits the deletion to that user's messages. The
 * switches, which may appear anywhere:
 *
 * - `-r <regex>`   only messages whose content matches the regex
 * - `-im`          invert the regex match
 * - `-i`           regex is case-insensitive
 * - `-ma <dur>`    max age: only messages younger than the duration
 * - `-minage <dur>` min age: only messages older than the duration
 * - `-nopin`       ignore pinned messages
 * - `-a`           only messages with attachments
 * - `-bots`        only messages written by bots
 * - `-from <id>`   start at this message ID (it and older ones)
 * - `-to <id>`     stop at this message ID (it and newer ones)
 *
 * Durations use the reminder syntax (`1h30m`, `2d`, bare numbers are
 * minutes). Double-quoted tokens keep their spaces (`-r "foo bar"`).
 */

import { parseDuration } from '../reminders/reminderArgs';

/** Command words that run `clean`, the first being the canonical name. */
export const CLEAN_COMMAND_NAMES = ['clean', 'clear', 'cl'] as const;
export type CleanCommandName = (typeof CLEAN_COMMAND_NAMES)[number];

/** Most messages one invocation deletes (the bulk-delete limit on both platforms). */
export const MAX_CLEAN_COUNT = 100;
/** Longest accepted `-r` pattern; longer ones are rejected as invalid. */
export const MAX_CLEAN_REGEX_LENGTH = 256;

export interface CleanOptions {
    /** Number of matching messages to delete, 1–{@link MAX_CLEAN_COUNT}. */
    count: number;
    /** Only messages by this user ID. */
    userId: string | null;
    /** Only messages whose content matches (or, with `invertRegex`, does not). */
    regex: RegExp | null;
    invertRegex: boolean;
    /** Only messages younger than this. */
    maxAgeMs: number | null;
    /** Only messages older than this. */
    minAgeMs: number | null;
    /** Skip pinned messages. */
    ignorePinned: boolean;
    /** Only messages with at least one attachment. */
    attachmentsOnly: boolean;
    /** Only messages written by bots. */
    botsOnly: boolean;
    /** Only this message and older ones (`-from`). */
    fromId: string | null;
    /** Only this message and newer ones (`-to`). */
    toId: string | null;
}

export type CleanArgsFailure =
    | { reason: 'missing_count' }
    /** The count is not a whole number from 1 to {@link MAX_CLEAN_COUNT}. */
    | { reason: 'invalid_count'; value: string }
    /** A third positional argument was given. */
    | { reason: 'too_many_args'; value: string }
    /** The user is neither a mention nor an ID. */
    | { reason: 'invalid_user'; value: string }
    | { reason: 'unknown_switch'; value: string }
    /** `switch` (e.g. `-r`) was the last token or was followed by nothing usable. */
    | { reason: 'missing_switch_value'; switch: string }
    | { reason: 'invalid_regex'; value: string; detail: string }
    | { reason: 'invalid_duration'; switch: string; value: string }
    | { reason: 'invalid_message_id'; switch: string; value: string };

export type CleanArgsResult =
    | { ok: true; options: CleanOptions }
    | ({ ok: false } & CleanArgsFailure);

const FLAG_SWITCHES = ['im', 'i', 'nopin', 'a', 'bots'] as const;
const VALUE_SWITCHES = ['r', 'ma', 'minage', 'to', 'from'] as const;
type FlagSwitch = (typeof FLAG_SWITCHES)[number];
type ValueSwitch = (typeof VALUE_SWITCHES)[number];

const MENTION_RE = /^<@!?(\d+)>$/;
const DIGITS_RE = /^\d+$/;
const SNOWFLAKE_RE = /^\d{1,25}$/;
/** Numbers this long and longer are IDs, shorter ones are counts. */
const MIN_ID_DIGITS = 15;

/**
 * Splits `raw` on whitespace, keeping double-quoted runs together (without
 * their quotes): `5 -r "foo bar"` → `['5', '-r', 'foo bar']`. An unmatched
 * quote is an ordinary character.
 */
export function tokenizeCleanArgs(raw: string): string[] {
    const tokens: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    for (const match of raw.matchAll(re)) {
        tokens.push(match[1] ?? match[2]);
    }
    return tokens;
}

function isFlagSwitch(name: string): name is FlagSwitch {
    return (FLAG_SWITCHES as readonly string[]).includes(name);
}

function isValueSwitch(name: string): name is ValueSwitch {
    return (VALUE_SWITCHES as readonly string[]).includes(name);
}

function parseSnowflakeArg(
    switchName: string,
    value: string
): { ok: true; id: string } | { ok: false; failure: CleanArgsFailure } {
    const match = MENTION_RE.exec(value);
    const id = match ? match[1] : value;
    if (!SNOWFLAKE_RE.test(id)) {
        return {
            ok: false,
            failure: {
                reason: 'invalid_message_id',
                switch: `-${switchName}`,
                value,
            },
        };
    }
    return { ok: true, id };
}

/** Parses everything after the command word (see the module comment). */
export function parseCleanArgs(raw: string): CleanArgsResult {
    const tokens = tokenizeCleanArgs(raw);
    const positional: string[] = [];
    const flags = new Set<FlagSwitch>();
    const values = new Map<ValueSwitch, string>();

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.length > 1 && token.startsWith('-')) {
            if (/^-\d+$/.test(token)) {
                return { ok: false, reason: 'invalid_count', value: token };
            }
            const name = token.slice(1).toLowerCase();
            if (isFlagSwitch(name)) {
                flags.add(name);
                continue;
            }
            if (isValueSwitch(name)) {
                const value = tokens[i + 1];
                if (value === undefined || value === '') {
                    return {
                        ok: false,
                        reason: 'missing_switch_value',
                        switch: `-${name}`,
                    };
                }
                values.set(name, value);
                i++;
                continue;
            }
            return { ok: false, reason: 'unknown_switch', value: token };
        }
        positional.push(token);
    }

    if (positional.length > 2) {
        return { ok: false, reason: 'too_many_args', value: positional[2] };
    }

    let countToken: string | null = null;
    let userId: string | null = null;
    for (const token of positional) {
        const mention = MENTION_RE.exec(token);
        const isId =
            mention !== null ||
            (DIGITS_RE.test(token) && token.length >= MIN_ID_DIGITS);
        if (isId) {
            if (userId !== null) {
                // Two IDs: there is no count.
                return { ok: false, reason: 'invalid_count', value: token };
            }
            userId = mention ? mention[1] : token;
        } else if (countToken === null) {
            countToken = token;
        } else {
            return { ok: false, reason: 'invalid_user', value: token };
        }
    }
    if (countToken === null) {
        return { ok: false, reason: 'missing_count' };
    }
    const count = DIGITS_RE.test(countToken) ? Number(countToken) : NaN;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CLEAN_COUNT) {
        return { ok: false, reason: 'invalid_count', value: countToken };
    }

    let regex: RegExp | null = null;
    const pattern = values.get('r');
    if (pattern !== undefined) {
        if (pattern.length > MAX_CLEAN_REGEX_LENGTH) {
            return {
                ok: false,
                reason: 'invalid_regex',
                value: pattern,
                detail: `pattern longer than ${MAX_CLEAN_REGEX_LENGTH} characters`,
            };
        }
        try {
            regex = new RegExp(pattern, flags.has('i') ? 'i' : '');
        } catch (err) {
            return {
                ok: false,
                reason: 'invalid_regex',
                value: pattern,
                detail: (err as Error).message,
            };
        }
    }

    const durations: Record<'ma' | 'minage', number | null> = {
        ma: null,
        minage: null,
    };
    for (const name of ['ma', 'minage'] as const) {
        const value = values.get(name);
        if (value === undefined) continue;
        const ms = parseDuration(value);
        if (ms === null) {
            return {
                ok: false,
                reason: 'invalid_duration',
                switch: `-${name}`,
                value,
            };
        }
        // Like YAGPDB, a zero duration means "no limit".
        durations[name] = ms === 0 ? null : ms;
    }

    const ids: Record<'from' | 'to', string | null> = { from: null, to: null };
    for (const name of ['from', 'to'] as const) {
        const value = values.get(name);
        if (value === undefined) continue;
        const parsed = parseSnowflakeArg(name, value);
        if (!parsed.ok) return { ok: false, ...parsed.failure };
        ids[name] = parsed.id;
    }

    return {
        ok: true,
        options: {
            count,
            userId,
            regex,
            invertRegex: flags.has('im'),
            maxAgeMs: durations.ma,
            minAgeMs: durations.minage,
            ignorePinned: flags.has('nopin'),
            attachmentsOnly: flags.has('a'),
            botsOnly: flags.has('bots'),
            fromId: ids.from,
            toId: ids.to,
        },
    };
}

/** `value` as inline code; backticks are stripped so it cannot break out. */
function code(value: string): string {
    return `\`${value.replace(/`/g, '')}\``;
}

/**
 * The error line a handler shows above the command usage for a parse
 * failure, or null when the usage alone says it all (no count given).
 * Shared by the Discord and Fluxer handlers.
 */
export function cleanFailureMessage(failure: CleanArgsFailure): string | null {
    switch (failure.reason) {
        case 'missing_count':
            return null;
        case 'invalid_count':
            return `${code(failure.value)} is not a valid number of messages; give a whole number from 1 to ${MAX_CLEAN_COUNT}.`;
        case 'too_many_args':
            return `Unexpected argument ${code(failure.value)}.`;
        case 'invalid_user':
            return `${code(failure.value)} is not a user mention or ID.`;
        case 'unknown_switch':
            return `Unknown switch ${code(failure.value)}.`;
        case 'missing_switch_value':
            return `${code(failure.switch)} needs a value.`;
        case 'invalid_regex':
            return `Invalid regex ${code(failure.value)}: ${failure.detail}`;
        case 'invalid_duration':
            return `${code(failure.value)} is not a valid duration for ${code(failure.switch)}; use something like \`1h30min\`, \`2d\` or \`30\` (minutes).`;
        case 'invalid_message_id':
            return `${code(failure.value)} is not a message ID for ${code(failure.switch)}.`;
    }
}
