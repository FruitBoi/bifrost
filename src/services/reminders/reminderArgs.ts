/**
 * Argument parsing for the reminder commands (issue #9). The duration syntax
 * is a faithful port of YAGPDB's `common.ParseDuration`; the command-line
 * shapes (`remindme [-channel <ref>] <time> <message>`, `reminder delete
 * [id] [-a]`) mirror YAGPDB's `remindme` and `reminder delete`. Since
 * issue #27 the time may also be a date and/or time of day (`Oct 26 20:15`,
 * `Monday 7pm`, `tomorrow`), parsed by {@link parseReminderDate}. Since
 * issue #58 `remindme snooze <time>` / `remindme again <time>` sets an
 * existing reminder again ({@link parseSnoozeArgs}).
 */
import { parseChannelRef } from '../../utils/channelRef';
import { parseReminderDate, ReminderDateSpec } from './reminderDate';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Milliseconds for one unit of `modifier`, matched by prefix the way YAGPDB
 * does it: `s…` seconds, `m…` minutes unless it starts with `mo` (months of
 * 30 days), `h…` hours, `d…` days, `w…` weeks, `y…` years of 365 days, and
 * an empty modifier means minutes. Null for anything else.
 */
function unitMs(modifier: string): number | null {
    if (modifier === '') return MINUTE_MS;
    if (modifier.startsWith('s')) return SECOND_MS;
    if (modifier.startsWith('m') && modifier[1] !== 'o') return MINUTE_MS;
    if (modifier.startsWith('h')) return HOUR_MS;
    if (modifier.startsWith('d')) return DAY_MS;
    if (modifier.startsWith('w')) return WEEK_MS;
    if (modifier.startsWith('mo')) return MONTH_MS;
    if (modifier.startsWith('y')) return YEAR_MS;
    return null;
}

/** `<number><modifier>` in milliseconds, or null when it does not fit. */
function componentMs(number: string, modifier: string): number | null {
    const unit = unitMs(modifier);
    if (unit === null) return null;
    const count = Number(number);
    if (!Number.isSafeInteger(count)) return null;
    const ms = count * unit;
    return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * Parses a duration such as `1h30min`, `1day3h`, `2w`, `1mo`, `1y` or `90`
 * (bare numbers are minutes) into milliseconds. Whitespace inside the string
 * is ignored; a component with a modifier but no number counts as one
 * (`2d` and `2dh` both mean two days: a modifier is matched by its prefix).
 * The input must start with a digit and every modifier must be known,
 * otherwise the result is null. Unlike YAGPDB, modifiers are
 * case-insensitive (`1H` is an hour).
 */
export function parseDuration(input: string): number | null {
    if (!/^[0-9]/.test(input)) return null;
    input = input.toLowerCase();

    let total = 0;
    let numberBuf = '';
    let modifierBuf = '';
    for (const char of input) {
        if (/\s/.test(char)) continue;
        if (/[0-9]/.test(char)) {
            if (modifierBuf !== '') {
                if (numberBuf === '') numberBuf = '1';
                const ms = componentMs(numberBuf, modifierBuf);
                if (ms === null) return null;
                total += ms;
                numberBuf = '';
                modifierBuf = '';
            }
            numberBuf += char;
        } else {
            modifierBuf += char;
        }
    }
    if (numberBuf !== '') {
        const ms = componentMs(numberBuf, modifierBuf);
        if (ms === null) return null;
        total += ms;
    }

    if (!Number.isSafeInteger(total) || total < 0) return null;
    return total;
}

/**
 * When a reminder fires: a delay from now (`1h30m`), or a wall-clock date
 * and/or time that still needs the user's time zone to become an instant.
 */
export type ReminderWhen =
    | { kind: 'duration'; delayMs: number }
    | { kind: 'date'; spec: ReminderDateSpec };

export type RemindMeArgs =
    | {
          ok: true;
          when: ReminderWhen;
          message: string;
          channelRef: string | null;
      }
    | {
          ok: false;
          reason:
              | 'missing_time'
              | 'invalid_time'
              | 'missing_message'
              | 'missing_channel';
      };

/**
 * Reads the time at the start of `words` (shared by `remindme` and its
 * snooze form, issue #58): a single duration token (`1h30m`, `90`) when the
 * first word is one; otherwise a date/time of one or more words
 * (`Oct 26 20:15`, `next Monday at 7pm`, `tomorrow`; see
 * {@link parseReminderDate}). One exception: a bare number followed by a
 * meridiem or a month (`7 pm`, `26 Oct`) is read as a date/time rather than
 * as minutes. `consumed` is the number of words the time took; null when
 * the words do not start with a time.
 */
export function parseReminderTime(
    words: readonly string[]
): { when: ReminderWhen; consumed: number } | null {
    if (words.length === 0) return null;
    const date = parseReminderDate(words);
    const numberFirst = /^\d+$/.test(words[0]);
    if (date !== null && numberFirst && date.consumed >= 2) {
        return {
            when: { kind: 'date', spec: date.spec },
            consumed: date.consumed,
        };
    }
    const delayMs = parseDuration(words[0]);
    if (delayMs !== null) {
        return { when: { kind: 'duration', delayMs }, consumed: 1 };
    }
    if (date !== null) {
        return {
            when: { kind: 'date', spec: date.spec },
            consumed: date.consumed,
        };
    }
    return null;
}

/** `-channel <ref>` as the first two tokens (ref missing when group 1 is). */
const LEADING_CHANNEL_RE = /^-channel(?:\s+(\S+))?(?=\s|$)/i;
/** `-channel <ref>` as the last two tokens (ref missing when group 1 is). */
const TRAILING_CHANNEL_RE = /(?:^|\s)-channel(?:\s+(\S+))?\s*$/i;

/**
 * Parses everything after `remindme`: an optional `-channel <ref>` switch as
 * the first or the last two tokens, then the time, then the message, which
 * is the rest of the text with its inner whitespace and newlines kept.
 * `channelRef` is returned verbatim (`<#123>`, `123` or a channel name); see
 * {@link extractChannelId}.
 *
 * The time is read by {@link parseReminderTime}.
 */
export function parseRemindMeArgs(raw: string): RemindMeArgs {
    let text = raw.trim();
    let channelRef: string | null = null;

    const leading = LEADING_CHANNEL_RE.exec(text);
    if (leading) {
        if (leading[1] === undefined) {
            return { ok: false, reason: 'missing_channel' };
        }
        channelRef = leading[1];
        text = text.slice(leading[0].length).replace(/^\s+/, '');
    } else {
        const trailing = TRAILING_CHANNEL_RE.exec(text);
        if (trailing) {
            if (trailing[1] === undefined) {
                return { ok: false, reason: 'missing_channel' };
            }
            channelRef = trailing[1];
            text = text.slice(0, trailing.index).trim();
        }
    }

    const tokens: { text: string; end: number }[] = [];
    for (const match of text.matchAll(/\S+/g)) {
        tokens.push({
            text: match[0],
            end: (match.index ?? 0) + match[0].length,
        });
    }
    if (tokens.length === 0) return { ok: false, reason: 'missing_time' };

    const time = parseReminderTime(tokens.map((t) => t.text));
    if (time === null) return { ok: false, reason: 'invalid_time' };
    const { when, consumed } = time;

    const message = text.slice(tokens[consumed - 1].end).trim();
    if (message === '') return { ok: false, reason: 'missing_message' };

    return { ok: true, when, message, channelRef };
}

export type SnoozeArgs =
    | { snooze: false }
    | { snooze: true; ok: true; when: ReminderWhen }
    | {
          snooze: true;
          ok: false;
          reason: 'missing_time' | 'invalid_time' | 'unexpected_text';
      };

/**
 * A duration written over several words (`1h 30m`, `10 minutes`, `2 d`):
 * each word is a duration of its own, or a bare number followed by a word
 * that is only a unit. Null when any word does not fit, so `1h stretch` is
 * not read as `1hstretch` (one hour, by the unit's prefix).
 */
function parseSpacedDuration(words: readonly string[]): number | null {
    for (let i = 0; i < words.length; i++) {
        if (parseDuration(words[i]) === null) return null;
        const next = words[i + 1];
        if (
            /^\d+$/.test(words[i]) &&
            next !== undefined &&
            /^[a-z]+$/i.test(next) &&
            parseDuration(`1${next}`) !== null
        ) {
            i++;
        }
    }
    return parseDuration(words.join(''));
}

/** First word of the snooze form: `remindme snooze …` / `remindme again …`. */
const SNOOZE_WORDS = new Set(['snooze', 'again']);

/**
 * Parses everything after `remindme` as the snooze form (issue #58):
 * `snooze <time>` or `again <time>` (either word in any case) sets a
 * reminder that already exists again, so only the time follows; the text,
 * server and channel come from the reminder being snoozed. `{ snooze: false }`
 * when the first word is neither, so the normal `remindme` parsing applies
 * (a normal reminder must start with a time, so nothing valid is lost).
 *
 * The time is read like in `remindme` ({@link parseReminderTime}) and must
 * be the whole rest of the text. As there is no message to tell it apart
 * from, a duration may also be split by spaces (`1h 30m`, `10 minutes`).
 * Any other trailing text is rejected (`unexpected_text`) rather than
 * dropped, so `snooze 1h stretch` does not silently lose `stretch`, and
 * `-channel` is not accepted: the reminder keeps its channel.
 */
export function parseSnoozeArgs(raw: string): SnoozeArgs {
    const words = raw
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
    if (words.length === 0 || !SNOOZE_WORDS.has(words[0].toLowerCase())) {
        return { snooze: false };
    }

    const rest = words.slice(1);
    if (rest.length === 0) {
        return { snooze: true, ok: false, reason: 'missing_time' };
    }

    const time = parseReminderTime(rest);
    if (time !== null && time.consumed === rest.length) {
        return { snooze: true, ok: true, when: time.when };
    }
    const delayMs = parseSpacedDuration(rest);
    if (delayMs !== null) {
        return { snooze: true, ok: true, when: { kind: 'duration', delayMs } };
    }
    return {
        snooze: true,
        ok: false,
        reason: time === null ? 'invalid_time' : 'unexpected_text',
    };
}

/** Reply when there is no reminder to snooze (issue #58). */
export function nothingToSnoozeMessage(prefix: string): string {
    return `No reminder to snooze: reply to a reminder message with \`${prefix}remindme snooze <time>\`, or wait until one goes off.`;
}

/** Reply when the reminder to snooze belongs to someone else (issue #58). */
export const NOT_YOUR_REMINDER_MESSAGE =
    'You can only snooze your own reminders.';

/** Reply to text after the time in the snooze form (issue #58). */
export const SNOOZE_ONLY_TIME_MESSAGE =
    'Snoozing only takes a time, e.g. `snooze 10m` or `again tomorrow 9am`: the reminder keeps its text and channel.';

/** `<#123>`, a bare `123` or a channel link → `'123'`; a name or anything else → null. */
export function extractChannelId(ref: string): string | null {
    return parseChannelRef(ref);
}

export interface ReminderDeleteArgs {
    /** `-a` was given: delete all of the caller's reminders. */
    all: boolean;
    /** The reminder id, when a valid one was given. */
    id: number | null;
    /** Something other than `-a` was given as the id but it is not one. */
    invalidId: boolean;
}

/**
 * Parses everything after `reminder delete`: `-a` anywhere selects all of
 * the caller's reminders; otherwise the first token is the reminder id,
 * which must be a positive integer.
 */
export function parseReminderDeleteArgs(raw: string): ReminderDeleteArgs {
    const tokens = raw
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
    const all = tokens.some((t) => t.toLowerCase() === '-a');
    const idToken = tokens.find((t) => t.toLowerCase() !== '-a');
    if (idToken === undefined) return { all, id: null, invalidId: false };

    const id = /^\d+$/.test(idToken) ? Number(idToken) : NaN;
    if (Number.isSafeInteger(id) && id > 0) {
        return { all, id, invalidId: false };
    }
    return { all, id: null, invalidId: true };
}
