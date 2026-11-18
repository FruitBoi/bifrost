import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Cancelling a reminder by replying to its "Reminder set" message with
 * `remindme cancel` (issue #65).
 *
 * - reminder_messages.reminderId: the `reminders.id` a 'set' message
 *   confirmed; null for delivered messages and rows recorded before this
 *   migration. Not a foreign key: delivered and deleted reminders leave their
 *   rows behind, and the service checks the reminder still matches.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.addColumn('reminder_messages', 'reminderId', {
        type: DataTypes.INTEGER,
        allowNull: true,
    });
};

/** The indexes 00019 created, which a SQLite table rebuild can drop. */
const INDEXES: { name: string; fields: string[]; unique?: boolean }[] = [
    {
        name: 'reminder_messages_platform_message',
        fields: ['platform', 'messageId'],
        unique: true,
    },
    {
        name: 'reminder_messages_platform_user_guild_kind_created',
        fields: ['platform', 'userId', 'guildId', 'kind', 'createdAt'],
    },
    { name: 'reminder_messages_created_at', fields: ['createdAt'] },
];

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn('reminder_messages', 'reminderId');
    // SQLite implements removeColumn by rebuilding the table, which loses
    // its indexes; put back any that are missing.
    const existing = (
        (await queryInterface.showIndex('reminder_messages')) as {
            name: string;
        }[]
    ).map((index) => index.name);
    for (const { name, fields, unique } of INDEXES) {
        if (existing.includes(name)) continue;
        await queryInterface.addIndex('reminder_messages', fields, {
            name,
            unique: unique ?? false,
        });
    }
};
