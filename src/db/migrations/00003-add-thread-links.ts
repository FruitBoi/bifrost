import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Adds thread bridging support:
 * - channel_links.autoSyncThreads: per-channel toggle for automatic thread bridging
 * - thread_links: maps a Discord thread to a Fluxer thread under a channel link
 * - message_links.threadLinkId / queued_messages.threadLinkId: nullable pointer so
 *   edits, deletes and queued retries know which thread to target
 *
 * All additions are nullable or defaulted, so existing rows need no backfill.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.addColumn('channel_links', 'autoSyncThreads', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    });

    await queryInterface.createTable('thread_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID, allowNull: false },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'channel_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        discordThreadId: { type: DataTypes.STRING, allowNull: false },
        fluxerThreadId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('thread_links', ['discordThreadId'], {
        unique: true,
        name: 'thread_links_discord_thread_id',
    });
    await queryInterface.addIndex('thread_links', ['fluxerThreadId'], {
        unique: true,
        name: 'thread_links_fluxer_thread_id',
    });
    await queryInterface.addIndex('thread_links', ['channelLinkId'], {
        name: 'thread_links_channel_link_id',
    });
    await queryInterface.addIndex('thread_links', ['guildLinkId'], {
        name: 'thread_links_guild_link_id',
    });

    await queryInterface.addColumn('message_links', 'threadLinkId', {
        type: DataTypes.UUID,
        allowNull: true,
    });
    await queryInterface.addIndex('message_links', ['threadLinkId'], {
        name: 'message_links_thread_link_id',
    });

    await queryInterface.addColumn('queued_messages', 'threadLinkId', {
        type: DataTypes.UUID,
        allowNull: true,
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // SQLite implements removeColumn by rebuilding the table (DROP + CREATE),
    // which its foreign-key enforcement rejects while other tables reference
    // it. Enforcement is switched off for the rollback only.
    const isSqlite = queryInterface.sequelize.getDialect() === 'sqlite';
    if (isSqlite) {
        await queryInterface.sequelize.query('PRAGMA foreign_keys = OFF');
    }
    try {
        await queryInterface.removeColumn('queued_messages', 'threadLinkId');
        await queryInterface.removeIndex(
            'message_links',
            'message_links_thread_link_id'
        );
        await queryInterface.removeColumn('message_links', 'threadLinkId');
        await queryInterface.dropTable('thread_links');
        await queryInterface.removeColumn('channel_links', 'autoSyncThreads');
    } finally {
        if (isSqlite) {
            await queryInterface.sequelize.query('PRAGMA foreign_keys = ON');
        }
    }
};
