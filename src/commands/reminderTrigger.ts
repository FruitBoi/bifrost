/**
 * Direct triggers for the reminder commands (issue #9): besides the normal
 * bot prefix (`!b remindme ...`), the reminder commands can be invoked with
 * short prefixes such as `?remindme ...` or `!remindme ...` (configured in
 * `reminders.triggerPrefixes`); `? Remindme ...` works too. Only the command
 * names below are reachable this way; every other command still needs the
 * bot prefix.
 */

/** Command words (lower case) that the short prefixes may trigger. */
export const REMINDER_COMMAND_NAMES = [
    'remindme',
    'remind',
    // Common typo of `remindme` (issue #49).
    'remindmr',
    'reminder',
    'reminders',
    'creminders',
    'channelreminders',
    'delreminder',
    'rmreminder',
    // The time zone that date/time reminders are read in (issue #27).
    'timezone',
    'tz',
] as const;

export type ReminderCommandName = (typeof REMINDER_COMMAND_NAMES)[number];

export interface ReminderTrigger {
    /** The command word, lower-cased (e.g. `remindme`). */
    command: ReminderCommandName;
    /**
     * Everything after the command word, with leading whitespace removed and
     * the rest (including newlines) kept verbatim.
     */
    rawArgs: string;
}

function isReminderCommandName(word: string): word is ReminderCommandName {
    return (REMINDER_COMMAND_NAMES as readonly string[]).includes(word);
}

/**
 * Recognises `<prefix><command>` at the start of `content` for any of the
 * given prefixes (checked in order; the first prefix that matches wins) and
 * any reminder command name, case-insensitively. Whitespace between the
 * prefix and the command word is allowed, so `? Remindme 1h x` (what a phone
 * keyboard makes of `?remindme`, with its automatic space and capital after
 * punctuation) works like `?remindme 1h x`. The command word must be followed
 * by whitespace or the end of the message, so `?remindmeow` is not a trigger.
 * Returns null when the message is not a reminder invocation.
 */
export function parseReminderTrigger(
    content: string | null | undefined,
    prefixes: readonly string[]
): ReminderTrigger | null {
    if (!content) return null;
    for (const prefix of prefixes) {
        if (!prefix || !content.startsWith(prefix)) continue;
        const rest = content.slice(prefix.length);
        const match = /^\s*(\S+)(?:\s+|$)/.exec(rest);
        if (!match) continue;
        const word = match[1].toLowerCase();
        if (!isReminderCommandName(word)) continue;
        return { command: word, rawArgs: rest.slice(match[0].length) };
    }
    return null;
}

/**
 * Returns the raw argument text of a reminder invocation written with any of
 * `prefixes` (the bot prefix and the short trigger prefixes), or null when
 * `content` is not one. Handlers use it to read the reminder message exactly
 * as typed (whitespace and newlines included) instead of re-joining the
 * whitespace-split args the command dispatcher hands them.
 */
export function stripReminderInvocation(
    content: string | null | undefined,
    prefixes: readonly string[]
): string | null {
    return parseReminderTrigger(content, prefixes)?.rawArgs ?? null;
}
