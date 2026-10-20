import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Records who originally wrote each bridged message so replies can ping them
 * across the bridge:
 * - message_links.sourcePlatform: 'discord' | 'fluxer', the side that holds
 *   the original (human-authored) message; the other side is the webhook copy
 * - message_links.sourceAuthorId: the original author's user id on that platform
 *
 * Both columns are nullable, so existing rows need no backfill (they simply
 * cannot be pinged).
 */

const MESSAGE_LINK_INDEXES: Array<{
    fields: string[];
    name: string;
    unique?: boolean;
}> = [
    {
        fields: ['discordMessageId'],
        unique: true,
        name: 'message_links_discord_message_id',
    },
    {
        fields: ['fluxerMessageId'],
        unique: true,
        name: 'message_links_fluxer_message_id',
    },
    { fields: ['guildLinkId'], name: 'message_links_guild_link_id' },
];

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.addColumn('message_links', 'sourcePlatform', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('message_links', 'sourceAuthorId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;
    const isSqlite = sequelize.getDialect() === 'sqlite';

    // SQLite drops a column by rebuilding the table, which loses its indexes
    // and rejects the rebuild while foreign keys are enforced.
    if (isSqlite) await sequelize.query('PRAGMA foreign_keys = OFF');
    try {
        await queryInterface.removeColumn('message_links', 'sourceAuthorId');
        await queryInterface.removeColumn('message_links', 'sourcePlatform');
    } finally {
        if (isSqlite) await sequelize.query('PRAGMA foreign_keys = ON');
    }
    if (isSqlite) {
        for (const index of MESSAGE_LINK_INDEXES) {
            await queryInterface.addIndex('message_links', index.fields, {
                unique: index.unique,
                name: index.name,
            });
        }
    }
};
