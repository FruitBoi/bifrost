/**
 * Platform-independent half of date/time reminders and the `timezone`
 * command (issue #27): the wording shared by the Discord and Fluxer
 * `remindme` / `timezone` handlers and the parsing of `timezone` arguments.
 */
import type { Reminder, ReminderPlatform } from '../db/entities/Reminder';
import {
    MAX_REMINDER_MESSAGE_LENGTH,
    MAX_REMINDERS_PER_USER,
} from '../services/reminders/ReminderService';
import {
    formatTimeZone,
    parseTimeZone,
} from '../services/reminders/reminderDate';
import {
    formatReminderDuration,
    formatReminderTime,
} from '../services/reminders/reminderFormat';
import type ReminderTimezoneService from '../services/reminders/ReminderTimezoneService';
import {
    DateReminderFailure,
    formatLocalDateTime,
} from '../services/reminders/ReminderTimezoneService';
import { EmbedColors } from '../utils/embeds';
import logger from '../utils/logging/logger';

/** Names the `timezone` command is registered under. */
export const TIMEZONE_COMMAND_NAMES = ['timezone', 'tz'] as const;

/** Reply to a `remindme` whose time is neither a duration nor a date. */
export const INVALID_TIME_MESSAGE =
    "I couldn't understand that time. Use a duration like `1h30min`, `2d`, `30` (minutes), or a date/time like `Oct 26 20:15`, `Monday 7pm`, `tomorrow 9am`.";

/** Reply to a date that does not exist in the calendar (`Feb 30`). */
export const INVALID_DATE_MESSAGE =
    "That date doesn't exist. Check the day and month, e.g. `Oct 26 20:15` or `2026-10-26 9am`.";

/** Reply to a date/time that has already gone by (`Oct 26 2020`). */
export const IN_PAST_MESSAGE =
    'That time is already in the past. Give a date or time that is still ahead, e.g. `tomorrow 8am` or `Oct 26 20:15`.';

/** The zone examples shown in prompts and errors, with the hint prefix. */
function zoneExamples(p: string): string {
    return `\`${p}timezone America/New_York\`, \`${p}timezone Europe/London\`, \`${p}timezone UTC+2\` or \`${p}timezone EST\``;
}

/** Asks for the user's zone the first time a date/time reminder needs it. */
export function timezonePromptMessage(p: string): string {
    return `To use dates and times I need your time zone. Reply with \`${p}timezone <zone>\`, e.g. ${zoneExamples(p)}. Your reminder will be set as soon as you do.`;
}

/** Reply to `timezone <zone>` with a zone that is not recognised. */
export function invalidTimezoneMessage(p: string, input: string): string {
    return `\`${input.replace(/`/g, "'")}\` is not a time zone I know. Use a name like ${zoneExamples(p)}.`;
}

/** Reply to a bare `timezone` without a stored zone. */
export function noTimezoneMessage(p: string): string {
    return `You have not set a time zone yet. Set one with \`${p}timezone <zone>\`, e.g. ${zoneExamples(p)}.`;
}

/** Reply to a bare `timezone` with a stored zone. */
export function currentTimezoneMessage(
    p: string,
    zone: string,
    nowMs: number
): string {
    return `Your time zone is **${formatTimeZone(zone)}**; it is ${formatLocalDateTime(nowMs, zone)} there.\nChange it with \`${p}timezone <zone>\` or remove it with \`${p}timezone clear\`.`;
}

/** Confirms a newly stored zone. */
export function timezoneSetMessage(zone: string, nowMs: number): string {
    return `Time zone set to **${formatTimeZone(zone)}** (it is ${formatLocalDateTime(nowMs, zone)} there). Dates and times in \`remindme\` are read in this zone.`;
}

/** Shared by both `remindme` handlers: why `ReminderService.create` refused. */
export function reminderFailureMessage(
    reason: DateReminderFailure,
    p: string
): string | null {
    switch (reason) {
        case 'too_many':
            return `You can have at most ${MAX_REMINDERS_PER_USER} reminders at a time. Delete some with \`${p}reminder delete <id>\`.`;
        case 'too_long':
            return 'Reminders can be at most 10 years from now.';
        case 'too_short':
            return "That's too soon; the reminder must be at least a second away.";
        case 'message_too_long':
            return `Reminder messages can be at most ${MAX_REMINDER_MESSAGE_LENGTH} characters.`;
        case 'invalid_date':
            return INVALID_DATE_MESSAGE;
        case 'in_past':
            return IN_PAST_MESSAGE;
        case 'empty_message':
            return null;
    }
}

/**
 * The confirmation of a date/time reminder: the wall-clock time in the
 * user's zone (named, so a wrong zone is easy to spot), how far away that
 * is, and the platform's absolute time (`<t:…:f>` on Discord, UTC on Fluxer).
 */
export function dateReminderConfirmation(
    platform: ReminderPlatform,
    reminder: Reminder,
    delayMs: number,
    zone: string,
    where: string,
    p: string
): string {
    const local = formatLocalDateTime(reminder.dueAt.getTime(), zone);
    return (
        `Reminder **#${reminder.id}** set for ${local} (${formatTimeZone(zone)}), ` +
        `${formatReminderDuration(delayMs)} from now (${formatReminderTime(reminder.dueAt, platform)})${where}\n` +
        `View your reminders with \`${p}reminders\``
    );
}

export type TimezoneArgs =
    | { kind: 'show' }
    | { kind: 'clear' }
    | { kind: 'set'; zone: string };

/** `timezone`, `timezone clear|reset|remove|unset`, `timezone <zone>`. */
export function parseTimezoneArgs(raw: string): TimezoneArgs {
    const zone = raw.trim();
    if (zone === '') return { kind: 'show' };
    if (/^(?:clear|reset|remove|unset|delete)$/i.test(zone)) {
        return { kind: 'clear' };
    }
    return { kind: 'set', zone };
}

/** One embed of a `timezone` reply. */
export interface TimezoneReplyPart {
    description: string;
    color: number;
}

/**
 * Runs `timezone [zone | clear]` for a user and returns the reply embeds:
 * shows, clears or stores the zone, and once a zone is stored creates the
 * reminder that was waiting for it (issue #27), whose confirmation (or
 * failure) becomes a second embed. `channelId` is where the command was
 * typed, so the confirmation names the reminder's channel when it differs.
 */
export async function runTimezoneCommand(
    service: ReminderTimezoneService,
    platform: ReminderPlatform,
    userId: string,
    rawArgs: string,
    channelId: string,
    p: string
): Promise<TimezoneReplyPart[]> {
    const args = parseTimezoneArgs(rawArgs);
    const now = service.currentTime();

    if (args.kind === 'show') {
        const zone = await service.getTimeZone(platform, userId);
        return [
            zone === null
                ? { description: noTimezoneMessage(p), color: EmbedColors.Info }
                : {
                      description: currentTimezoneMessage(p, zone, now),
                      color: EmbedColors.Info,
                  },
        ];
    }

    if (args.kind === 'clear') {
        const removed = await service.clearTimeZone(platform, userId);
        return [
            {
                description: removed
                    ? 'Your time zone has been removed. You will be asked for it again the next time you set a reminder for a date or time.'
                    : 'You have no time zone set.',
                color: removed ? EmbedColors.Success : EmbedColors.Info,
            },
        ];
    }

    const zone = parseTimeZone(args.zone);
    if (zone === null) {
        return [
            {
                description: invalidTimezoneMessage(p, args.zone),
                color: EmbedColors.Error,
            },
        ];
    }
    await service.setTimeZone(platform, userId, zone);
    logger.info(`🕰️ ${platform} user ${userId} set their time zone to ${zone}`);
    const parts: TimezoneReplyPart[] = [
        {
            description: timezoneSetMessage(zone, now),
            color: EmbedColors.Success,
        },
    ];

    const pending = service.takePending(platform, userId);
    if (!pending) return parts;
    const result = await service.createDateReminder(
        platform,
        userId,
        {
            guildId: pending.guildId,
            channelId: pending.channelId,
            spec: pending.spec,
            message: pending.message,
        },
        zone
    );
    if (result.ok) {
        const where =
            pending.channelId === channelId
                ? ''
                : ` in <#${pending.channelId}>`;
        parts.push({
            description: dateReminderConfirmation(
                platform,
                result.reminder,
                result.delayMs,
                zone,
                where,
                p
            ),
            color: EmbedColors.Success,
        });
    } else {
        parts.push({
            description: `Your waiting reminder could not be set: ${
                reminderFailureMessage(result.reason, p) ??
                'its message is empty.'
            }`,
            color: EmbedColors.Error,
        });
    }
    return parts;
}
