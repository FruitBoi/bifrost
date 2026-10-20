/** Platform a reminder was created on and will be delivered to. */
export type ReminderPlatform = 'discord' | 'fluxer';

/**
 * A scheduled reminder (issue #9, modelled on YAGPDB's `remindme`). Reminders
 * are per platform: the user, guild and channel IDs all belong to `platform`,
 * and the reminder is posted back into that channel when it is due.
 *
 * `id` is a small auto-incremented integer so users can refer to reminders in
 * `reminder delete <id>`; it is unique across both platforms.
 */
export interface Reminder {
    id: number;
    platform: ReminderPlatform;
    userId: string;
    guildId: string;
    channelId: string;
    message: string;
    /** When the reminder should be delivered. */
    dueAt: Date;
    /** Failed delivery attempts so far; the row is dropped after too many. */
    attempts: number;
    createdAt: Date;
}
