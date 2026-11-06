import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Reminder snoozing (issue #58): `remindme again` / `remindme snooze` sets a
 * reminder again when the user replies to one of the bot's reminder messages,
 * or snoozes the last reminder that went off. Delivered reminders are deleted
 * from `reminders`, so the bot remembers its own messages here.
 *
 * - reminder_messages: one row per bot message that belongs to a reminder.
 *   `kind` is 'set' (the "Reminder set" confirmation reply) or 'delivered'
 *   (the posted reminder that pinged the user). The IDs are Discord or Fluxer
 *   IDs, as `platform` says, and `message` is a copy of the reminder text.
 *   `id` only orders rows inserted in the same millisecond; (platform,
 *   messageId) is unique. Rows are pruned by the service once older than its
 *   retention window. Nothing references it and it references nothing.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('reminder_messages', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        messageId: { type: DataTypes.STRING, allowNull: false },
        kind: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.STRING, allowNull: false },
        guildId: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        message: { type: DataTypes.TEXT, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'reminder_messages',
        ['platform', 'messageId'],
        { name: 'reminder_messages_platform_message', unique: true }
    );
    await queryInterface.addIndex(
        'reminder_messages',
        ['platform', 'userId', 'guildId', 'kind', 'createdAt'],
        { name: 'reminder_messages_platform_user_guild_kind_created' }
    );
    await queryInterface.addIndex('reminder_messages', ['createdAt'], {
        name: 'reminder_messages_created_at',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.dropTable('reminder_messages');
};
