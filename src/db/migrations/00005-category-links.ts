import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Category links: every text channel in a Discord category is bridged to a
 * thread inside one Fluxer channel.
 *
 * - category_links: the mapping (one row per Discord category).
 * - channel_links.categoryLinkId (nullable): set on the channel↔thread links a
 *   category link creates, so they can be renamed/removed with it.
 */

const CHANNEL_LINK_INDEXES: Array<{
    fields: string[];
    name: string;
    unique?: boolean;
    where?: Record<string, null>;
}> = [
    {
        fields: ['discordChannelId'],
        unique: true,
        where: { discordThreadId: null },
        name: 'channel_links_discord_channel_id',
    },
    {
        fields: ['fluxerChannelId'],
        unique: true,
        where: { fluxerThreadId: null },
        name: 'channel_links_fluxer_channel_id',
    },
    {
        fields: ['discordThreadId'],
        unique: true,
        name: 'channel_links_discord_thread_id',
    },
    {
        fields: ['fluxerThreadId'],
        unique: true,
        name: 'channel_links_fluxer_thread_id',
    },
    {
        fields: ['discordChannelId'],
        name: 'channel_links_discord_parent_channel_id',
    },
    {
        fields: ['fluxerChannelId'],
        name: 'channel_links_fluxer_parent_channel_id',
    },
    { fields: ['guildLinkId'], name: 'channel_links_guild_link_id' },
];

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('category_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID, allowNull: false },
        discordCategoryId: { type: DataTypes.STRING, allowNull: false },
        fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('category_links', ['discordCategoryId'], {
        unique: true,
        name: 'category_links_discord_category_id',
    });
    await queryInterface.addIndex('category_links', ['fluxerChannelId'], {
        name: 'category_links_fluxer_channel_id',
    });
    await queryInterface.addIndex('category_links', ['guildLinkId'], {
        name: 'category_links_guild_link_id',
    });

    await queryInterface.addColumn('channel_links', 'categoryLinkId', {
        type: DataTypes.UUID,
        allowNull: true,
    });
    await queryInterface.addIndex('channel_links', ['categoryLinkId'], {
        name: 'channel_links_category_link_id',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;
    const isSqlite = sequelize.getDialect() === 'sqlite';

    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_category_link_id'
    );

    // SQLite drops a column by rebuilding the table, which loses its indexes
    // and rejects the rebuild while foreign keys point at the table.
    if (isSqlite) await sequelize.query('PRAGMA foreign_keys = OFF');
    try {
        await queryInterface.removeColumn('channel_links', 'categoryLinkId');
    } finally {
        if (isSqlite) await sequelize.query('PRAGMA foreign_keys = ON');
    }
    if (isSqlite) {
        for (const index of CHANNEL_LINK_INDEXES) {
            await queryInterface.addIndex('channel_links', index.fields, {
                unique: index.unique,
                where: index.where,
                name: index.name,
            });
        }
    }

    await queryInterface.dropTable('category_links');
};
