import { Reminder, ReminderPlatform } from '../entities/Reminder';

export interface CreateReminderData {
    platform: ReminderPlatform;
    userId: string;
    guildId: string;
    channelId: string;
    message: string;
    dueAt: Date;
}

export interface ReminderRepository {
    create(data: CreateReminderData): Promise<Reminder>;

    findById(id: number): Promise<Reminder | null>;

    /** Ordered by dueAt ascending; all guilds when guildId is omitted. */
    findByUser(
        platform: ReminderPlatform,
        userId: string,
        guildId?: string
    ): Promise<Reminder[]>;

    /** Ordered by dueAt ascending. */
    findByChannel(
        platform: ReminderPlatform,
        channelId: string
    ): Promise<Reminder[]>;

    /** Reminders of the user across all guilds of the platform. */
    countByUser(platform: ReminderPlatform, userId: string): Promise<number>;

    /** dueAt <= before, ordered by dueAt ascending. */
    findDue(before: Date, limit?: number): Promise<Reminder[]>;

    incrementAttempts(id: number): Promise<void>;

    /** True when a row was removed. */
    deleteById(id: number): Promise<boolean>;

    /** Returns the number of rows removed. */
    deleteByUser(platform: ReminderPlatform, userId: string): Promise<number>;

    count(): Promise<number>;
}
