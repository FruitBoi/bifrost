import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * History transfer (issue #16): the `history` command copies a linked
 * channel's past messages to its counterpart on the other platform. Re-running
 * it must not duplicate anything, and digest mode packs many source messages
 * into one destination post, so the strictly one-to-one `message_links` table
 * cannot record what has been transferred.
 *
 * - history_messages: one row per source message that has been copied, naming
 *   the destination message that carries the copy. Several rows may share a
 *   `targetMessageId` (digest mode). The unique (sourcePlatform,
 *   sourceMessageId) index is what lets inserts ignore already-transferred
 *   messages. Rows belong to a guild link and a channel link and are removed
 *   with them.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('history_messages', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'guild_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'channel_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        sourcePlatform: { type: DataTypes.STRING, allowNull: false },
        sourceMessageId: { type: DataTypes.STRING, allowNull: false },
        targetMessageId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'history_messages',
        ['sourcePlatform', 'sourceMessageId'],
        { unique: true, name: 'history_messages_source' }
    );
    await queryInterface.addIndex('history_messages', ['channelLinkId'], {
        name: 'history_messages_channel_link',
    });
    await queryInterface.addIndex('history_messages', ['guildLinkId'], {
        name: 'history_messages_guild_link',
    });
    await queryInterface.addIndex('history_messages', ['targetMessageId'], {
        name: 'history_messages_target',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references history_messages; its own foreign keys go with the
    // table, so dropping it is safe on both SQLite and Postgres.
    await queryInterface.dropTable('history_messages');
};
