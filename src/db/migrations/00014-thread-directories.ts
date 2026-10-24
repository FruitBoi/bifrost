import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Threads directories (issue #37): the bot posts a message listing a
 * channel's threads with optional descriptions and edits it in place.
 *
 * - thread_directories: one row per directory message. The IDs belong to
 *   `platform` (Discord or Fluxer); there is at most one directory per
 *   (platform, channelId).
 * - thread_directory_entries: per-thread settings (description, hidden).
 *   Unique per (platform, threadId). Rows are independent of the directory
 *   row so descriptions survive removing and re-posting a directory.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('thread_directories', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        guildId: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        messageId: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'thread_directories',
        ['platform', 'channelId'],
        {
            name: 'thread_directories_platform_channel_id',
            unique: true,
        }
    );

    await queryInterface.createTable('thread_directory_entries', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        threadId: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        hidden: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'thread_directory_entries',
        ['platform', 'threadId'],
        {
            name: 'thread_directory_entries_platform_thread_id',
            unique: true,
        }
    );
    await queryInterface.addIndex(
        'thread_directory_entries',
        ['platform', 'channelId'],
        {
            name: 'thread_directory_entries_platform_channel_id',
        }
    );
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Neither table references the other or anything else, so dropping them
    // is safe on both SQLite and Postgres.
    await queryInterface.dropTable('thread_directory_entries');
    await queryInterface.dropTable('thread_directories');
};
