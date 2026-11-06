import { ReminderPlatform } from '../entities/Reminder';
import {
    ReminderMessage,
    ReminderMessageKind,
} from '../entities/ReminderMessage';

/** The bot's messages that belong to reminders (issue #58). */
export interface ReminderMessageRepository {
    /**
     * Stores the row, replacing an existing one with the same platform and
     * messageId.
     */
    save(data: ReminderMessage): Promise<void>;

    findByMessage(
        platform: ReminderPlatform,
        messageId: string
    ): Promise<ReminderMessage | null>;

    /**
     * The user's newest row of `kind` in the guild with createdAt >= since
     * (newest createdAt first, later insertion wins a tie).
     */
    findLatest(
        platform: ReminderPlatform,
        userId: string,
        guildId: string,
        kind: ReminderMessageKind,
        since: Date
    ): Promise<ReminderMessage | null>;

    /** Removes rows with createdAt < before; returns how many. */
    deleteOlderThan(before: Date): Promise<number>;
}
