/**
 * Argument parsing for the reminder commands (issue #9). The duration syntax
 * is a faithful port of YAGPDB's `common.ParseDuration`; the command-line
 * shapes (`remindme [-channel <ref>] <time> <message>`, `reminder delete
 * [id] [-a]`) mirror YAGPDB's `remindme` and `reminder delete`.
 */

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

export type RemindMeArgs =
    | {
          ok: true;
          delayMs: number;
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

/** `-channel <ref>` as the first two tokens (ref missing when group 1 is). */
const LEADING_CHANNEL_RE = /^-channel(?:\s+(\S+))?(?=\s|$)/i;
/** `-channel <ref>` as the last two tokens (ref missing when group 1 is). */
const TRAILING_CHANNEL_RE = /(?:^|\s)-channel(?:\s+(\S+))?\s*$/i;

/**
 * Parses everything after `remindme`: an optional `-channel <ref>` switch as
 * the first or the last two tokens, then the time as a single token, then
 * the message, which is the rest of the text with its inner whitespace and
 * newlines kept. `channelRef` is returned verbatim (`<#123>`, `123` or a
 * channel name); see {@link extractChannelId}.
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

    const time = /^\S+/.exec(text);
    if (!time) return { ok: false, reason: 'missing_time' };
    const delayMs = parseDuration(time[0]);
    if (delayMs === null) return { ok: false, reason: 'invalid_time' };

    const message = text.slice(time[0].length).trim();
    if (message === '') return { ok: false, reason: 'missing_message' };

    return { ok: true, delayMs, message, channelRef };
}

/** `<#123>` or a bare `123` → `'123'`; a name or anything else → null. */
export function extractChannelId(ref: string): string | null {
    const match = /^(?:<#(\d+)>|(\d+))$/.exec(ref.trim());
    return match ? (match[1] ?? match[2]) : null;
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
