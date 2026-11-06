import { ReminderPlatform } from './Reminder';

/** 'set': the "Reminder set" confirmation reply; 'delivered': the posted reminder that pinged the user. */
export type ReminderMessageKind = 'set' | 'delivered';

/**
 * One of the bot's own messages that belongs to a reminder (issue #58), so
 * `remindme again` / `remindme snooze` can find the reminder a user replies
 * to, or the last one that went off. Kept apart from `reminders` because
 * delivered reminders are deleted from that table; rows are pruned after
 * `REMINDER_MESSAGE_RETENTION_MS`.
 */
export interface ReminderMessage {
    platform: ReminderPlatform;
    /** ID of the bot's message (the confirmation reply or the delivered reminder). */
    messageId: string;
    kind: ReminderMessageKind;
    /** The reminder's owner. */
    userId: string;
    guildId: string;
    /** The channel the reminder is (or was) posted into. */
    channelId: string;
    /** The reminder text. */
    message: string;
    createdAt: Date;
}

export type RecordReminderMessageData = Omit<ReminderMessage, 'createdAt'>;
