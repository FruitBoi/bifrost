/**
 * Argument parsing for the `history` command (issue #16, alias `backfill`),
 * run inside a linked channel or thread to copy its history to the linked
 * location on the other platform:
 *
 *     history [count|all] [switches]    history confirm | status | stop
 *
 * Without a count the most recent `defaultCount` eligible messages are
 * transferred; `all` transfers the whole history and needs a `confirm`
 * step. `status` shows the job for the current link and `stop` (or
 * `cancel`) ends it. The switches, which may appear anywhere:
 *
 * - `-ma <dur>`        max age: only messages younger than the duration
 * - `-after <id|link>` only messages newer than this message
 * - `-before <id|link>` only messages older than this message
 * - `-digest`          pack many messages into transcript posts
 * - `-notime`          do not prefix copies with the original time
 *
 * Durations use the reminder syntax (`1h30m`, `2d`, bare numbers are
 * minutes; `0` means no limit). Double-quoted tokens keep their spaces.
 */

import { compareSnowflakes } from '../clean/cleanFilter';
import { tokenizeCleanArgs } from '../clean/cleanArgs';
import { parseDuration } from '../reminders/reminderArgs';
import { HistoryOptions } from './HistorySource';

/** Command words that run `history`, the first being the canonical name. */
export const HISTORY_COMMAND_NAMES = ['history', 'backfill'] as const;
export type HistoryCommandName = (typeof HISTORY_COMMAND_NAMES)[number];

/** Configured bounds for the count positional. */
export interface HistoryArgsLimits {
    /** Count used when none is given. */
    defaultCount: number;
    /** Largest count accepted (anything larger needs `all`). */
    maxCount: number;
}

export type HistoryArgsFailure =
    /** The first positional is neither a keyword nor a whole number from 1 to `maxCount`. */
    | { reason: 'invalid_count'; value: string; maxCount: number }
    /** A second positional argument was given. */
    | { reason: 'too_many_args'; value: string }
    /** `confirm`, `status` or `stop` was combined with other tokens. */
    | { reason: 'action_with_args'; action: string; value: string }
    | { reason: 'unknown_switch'; value: string }
    /** `switch` (e.g. `-ma`) was the last token or was followed by nothing usable. */
    | { reason: 'missing_switch_value'; switch: string }
    | { reason: 'invalid_duration'; switch: string; value: string }
    | { reason: 'invalid_message_id'; switch: string; value: string }
    /** `-after` names a message that is not older than the `-before` one. */
    | { reason: 'invalid_range'; afterId: string; beforeId: string };

export type HistoryArgsResult =
    | {
          ok: true;
          action: 'start';
          options: HistoryOptions;
          /** true for `all` (needs the confirm step) */
          needsConfirm: boolean;
      }
    | { ok: true; action: 'confirm' }
    | { ok: true; action: 'status' }
    | { ok: true; action: 'stop' }
    | ({ ok: false } & HistoryArgsFailure);

const FLAG_SWITCHES = ['digest', 'notime'] as const;
const VALUE_SWITCHES = ['ma', 'after', 'before'] as const;
type FlagSwitch = (typeof FLAG_SWITCHES)[number];
type ValueSwitch = (typeof VALUE_SWITCHES)[number];

const ACTION_WORDS: Record<string, 'confirm' | 'status' | 'stop'> = {
    confirm: 'confirm',
    status: 'status',
    stop: 'stop',
    cancel: 'stop',
};

const DIGITS_RE = /^\d+$/;
const SNOWFLAKE_RE = /^\d{1,25}$/;
/** A message link on either platform: the message id is the last path segment. */
const MESSAGE_LINK_RE = /^<?https?:\/\/\S+?\/(\d{1,25})\/?(?:[?#]\S*)?>?$/;

function isFlagSwitch(name: string): name is FlagSwitch {
    return (FLAG_SWITCHES as readonly string[]).includes(name);
}

function isValueSwitch(name: string): name is ValueSwitch {
    return (VALUE_SWITCHES as readonly string[]).includes(name);
}

/** The message id in `value`, a bare snowflake or a message link; null when neither. */
export function parseMessageRef(value: string): string | null {
    if (SNOWFLAKE_RE.test(value)) return value;
    const match = MESSAGE_LINK_RE.exec(value);
    return match ? match[1] : null;
}

/** Parses everything after the command word (see the module comment). */
export function parseHistoryArgs(
    raw: string,
    limits: HistoryArgsLimits
): HistoryArgsResult {
    const tokens = tokenizeCleanArgs(raw);
    const positional: string[] = [];
    const flags = new Set<FlagSwitch>();
    const values = new Map<ValueSwitch, string>();
    /** Every token that is not a positional, for the action-word check. */
    const switchTokens: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.length > 1 && token.startsWith('-')) {
            if (/^-\d+$/.test(token)) {
                return {
                    ok: false,
                    reason: 'invalid_count',
                    value: token,
                    maxCount: limits.maxCount,
                };
            }
            const name = token.slice(1).toLowerCase();
            if (isFlagSwitch(name)) {
                flags.add(name);
                switchTokens.push(token);
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
                switchTokens.push(token);
                i++;
                continue;
            }
            return { ok: false, reason: 'unknown_switch', value: token };
        }
        positional.push(token);
    }

    const first = positional[0];
    const action =
        first === undefined ? undefined : ACTION_WORDS[first.toLowerCase()];
    if (action !== undefined) {
        const extra = positional[1] ?? switchTokens[0];
        if (extra !== undefined) {
            return {
                ok: false,
                reason: 'action_with_args',
                action: first.toLowerCase(),
                value: extra,
            };
        }
        return { ok: true, action };
    }

    if (positional.length > 1) {
        return { ok: false, reason: 'too_many_args', value: positional[1] };
    }

    let count: number | null = limits.defaultCount;
    if (first !== undefined) {
        if (first.toLowerCase() === 'all') {
            count = null;
        } else {
            const parsed = DIGITS_RE.test(first) ? Number(first) : NaN;
            if (
                !Number.isSafeInteger(parsed) ||
                parsed < 1 ||
                parsed > limits.maxCount
            ) {
                return {
                    ok: false,
                    reason: 'invalid_count',
                    value: first,
                    maxCount: limits.maxCount,
                };
            }
            count = parsed;
        }
    }

    let maxAgeMs: number | null = null;
    const maxAge = values.get('ma');
    if (maxAge !== undefined) {
        const ms = parseDuration(maxAge);
        if (ms === null) {
            return {
                ok: false,
                reason: 'invalid_duration',
                switch: '-ma',
                value: maxAge,
            };
        }
        // Like YAGPDB, a zero duration means "no limit".
        maxAgeMs = ms === 0 ? null : ms;
    }

    const ids: Record<'after' | 'before', string | null> = {
        after: null,
        before: null,
    };
    for (const name of ['after', 'before'] as const) {
        const value = values.get(name);
        if (value === undefined) continue;
        const id = parseMessageRef(value);
        if (id === null) {
            return {
                ok: false,
                reason: 'invalid_message_id',
                switch: `-${name}`,
                value,
            };
        }
        ids[name] = id;
    }
    if (
        ids.after !== null &&
        ids.before !== null &&
        compareSnowflakes(ids.after, ids.before) >= 0
    ) {
        return {
            ok: false,
            reason: 'invalid_range',
            afterId: ids.after,
            beforeId: ids.before,
        };
    }

    return {
        ok: true,
        action: 'start',
        needsConfirm: count === null,
        options: {
            count,
            maxAgeMs,
            afterId: ids.after,
            beforeId: ids.before,
            mode: flags.has('digest') ? 'digest' : 'messages',
            timestamps: !flags.has('notime'),
        },
    };
}

/** `value` as inline code; backticks are stripped so it cannot break out. */
function code(value: string): string {
    return `\`${value.replace(/`/g, '')}\``;
}

/**
 * The error line a handler shows above the command usage for a parse
 * failure. Shared by the Discord and Fluxer handlers.
 */
export function historyFailureMessage(failure: HistoryArgsFailure): string {
    switch (failure.reason) {
        case 'invalid_count':
            return `${code(failure.value)} is not a valid number of messages; give a whole number from 1 to ${failure.maxCount}, or \`all\`.`;
        case 'too_many_args':
            return `Unexpected argument ${code(failure.value)}.`;
        case 'action_with_args':
            return `${code(failure.action)} takes no other arguments (got ${code(failure.value)}).`;
        case 'unknown_switch':
            return `Unknown switch ${code(failure.value)}.`;
        case 'missing_switch_value':
            return `${code(failure.switch)} needs a value.`;
        case 'invalid_duration':
            return `${code(failure.value)} is not a valid duration for ${code(failure.switch)}; use something like \`1h30min\`, \`2d\` or \`30\` (minutes).`;
        case 'invalid_message_id':
            return `${code(failure.value)} is not a message ID or link for ${code(failure.switch)}.`;
        case 'invalid_range':
            return `${code('-after')} must name an older message than ${code('-before')} (${code(failure.afterId)} is not older than ${code(failure.beforeId)}).`;
    }
}
