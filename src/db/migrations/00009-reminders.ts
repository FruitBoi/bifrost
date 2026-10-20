import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Reminders (issue #9): the `remindme` command stores a message to post back
 * into a channel at a later time. Reminders belong to one platform (the IDs
 * are Discord or Fluxer IDs, as `platform` says) and are delivered there only.
 *
 * - reminders: one row per pending reminder. `id` is a small auto-incremented
 *   integer so users can refer to it in `reminder delete <id>`; the sequence
 *   is shared by both platforms. `attempts` counts failed deliveries so the
 *   scheduler can give up on a reminder that keeps failing. Rows are deleted
 *   once delivered.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('reminders', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.STRING, allowNull: false },
        guildId: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        message: { type: DataTypes.TEXT, allowNull: false },
        dueAt: { type: DataTypes.DATE, allowNull: false },
        attempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('reminders', ['dueAt'], {
        name: 'reminders_due_at',
    });
    await queryInterface.addIndex('reminders', ['platform', 'userId'], {
        name: 'reminders_platform_user',
    });
    await queryInterface.addIndex('reminders', ['platform', 'channelId'], {
        name: 'reminders_platform_channel',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references reminders and it references nothing, so dropping
    // the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('reminders');
};
