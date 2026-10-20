import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * User links: which Fluxer account belongs to which Discord account, per
 * guild link. Written by the Fluxer `role` command and read when relaying
 * user mentions, so a ping on one platform reaches the same person on the
 * other.
 *
 * - user_links: one row per (guild link, Discord user, Fluxer user). The two
 *   unique indexes make the mapping one-to-one inside a guild link.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('user_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID, allowNull: false },
        discordUserId: { type: DataTypes.STRING, allowNull: false },
        fluxerUserId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'user_links',
        ['guildLinkId', 'discordUserId'],
        { unique: true, name: 'user_links_guild_discord_user' }
    );
    await queryInterface.addIndex(
        'user_links',
        ['guildLinkId', 'fluxerUserId'],
        { unique: true, name: 'user_links_guild_fluxer_user' }
    );
    await queryInterface.addIndex('user_links', ['guildLinkId'], {
        name: 'user_links_guild_link_id',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references user_links and it references nothing, so dropping
    // the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('user_links');
};
