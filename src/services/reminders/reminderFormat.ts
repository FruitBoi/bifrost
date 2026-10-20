/**
 * Formatting helpers for the reminder commands (issue #9): humanized
 * durations, absolute times per platform and the one-line reminder listing
 * used by `reminders` and `reminder channel`, all modelled on YAGPDB's.
 */
import { Reminder, ReminderPlatform } from '../../db/entities/Reminder';

/** How many characters of a reminder message a listing shows. */
export const REMINDER_PREVIEW_LENGTH = 50;

const MINUTE_MS = 60 * 1000;

/** Units from large to small, in minutes; years are 365 days, months 30. */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
    ['year', 365 * 24 * 60],
    ['month', 30 * 24 * 60],
    ['week', 7 * 24 * 60],
    ['day', 24 * 60],
    ['hour', 60],
    ['minute', 1],
];

/**
 * `1 hour and 30 minutes`, `2 days 3 hours and 5 minutes`, `1 minute`;
 * anything below a minute is `less than 1 minute`. Minute precision.
 */
export function formatReminderDuration(ms: number): string {
    let minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
    if (minutes < 1) return 'less than 1 minute';

    const parts: string[] = [];
    for (const [unit, size] of DURATION_UNITS) {
        const count = Math.floor(minutes / size);
        if (count === 0) continue;
        minutes -= count * size;
        parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
    }
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(' ')} and ${parts[parts.length - 1]}`;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/**
 * Absolute time for a platform: Discord renders `<t:unix:f>` in the reader's
 * time zone; Fluxer may not, so it gets a plain `YYYY-MM-DD HH:MM UTC`.
 */
export function formatReminderTime(
    date: Date,
    platform: ReminderPlatform
): string {
    if (platform === 'discord') {
        return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
    }
    return (
        `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-` +
        `${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:` +
        `${pad2(date.getUTCMinutes())} UTC`
    );
}

/**
 * The first `max` characters (code points, so an emoji counts once) of the
 * message with runs of whitespace and newlines collapsed to one space, plus
 * `...` when something was cut off.
 */
export function cutReminderShort(
    message: string,
    max = REMINDER_PREVIEW_LENGTH
): string {
    const chars = Array.from(message.replace(/\s+/g, ' ').trim());
    if (chars.length <= max) return chars.join('');
    return `${chars.slice(0, max).join('')}...`;
}

/**
 * One listing line, YAGPDB style:
 * `**<id>**: <who>: '<message cut short>' - in <duration> (<time>)`, or
 * `- due now (<time>)` once the reminder is overdue. `who` is the channel
 * mention in a user listing and the user name in a channel listing.
 */
export function formatReminderLine(
    reminder: Reminder,
    who: string,
    now: number = Date.now()
): string {
    const remainingMs = reminder.dueAt.getTime() - now;
    const when =
        remainingMs > 0
            ? `in ${formatReminderDuration(remainingMs)}`
            : 'due now';
    const time = formatReminderTime(reminder.dueAt, reminder.platform);
    const preview = cutReminderShort(reminder.message);
    return `**${reminder.id}**: ${who}: '${preview}' - ${when} (${time})`;
}
