import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Voice links: a Discord voice channel bridged to a Fluxer voice channel.
 * While a link is live the bot sits in both channels and relays audio.
 *
 * - voice_links: one row per pair of voice channels. Voice links have no
 *   webhooks and no threads, so they get their own table instead of a row in
 *   channel_links. Each voice channel can be linked at most once (unique
 *   indexes on both channel ids).
 * - voice_links.enabled: when false the link is kept but the bridge never
 *   joins the channels.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('voice_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID, allowNull: false },
        discordChannelId: { type: DataTypes.STRING, allowNull: false },
        fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
        enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('voice_links', ['discordChannelId'], {
        unique: true,
        name: 'voice_links_discord_channel_id',
    });
    await queryInterface.addIndex('voice_links', ['fluxerChannelId'], {
        unique: true,
        name: 'voice_links_fluxer_channel_id',
    });
    await queryInterface.addIndex('voice_links', ['guildLinkId'], {
        name: 'voice_links_guild_link_id',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references voice_links and it references nothing, so dropping
    // the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('voice_links');
};
