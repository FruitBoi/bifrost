import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Bridged message counts (issue #46): how many messages each side of a guild
 * link sends through the bridge, so activity on the Discord and Fluxer
 * servers can be compared with the `messagecount` command. `message_links`
 * cannot answer this: its rows are deleted with their messages and also come
 * from history imports and pins.
 *
 * - message_counts: one row per (guild link, source platform, UTC hour), the
 *   composite primary key. `hour` is the UTC epoch hour
 *   (`Math.floor(ms / 3_600_000)`) as a plain integer, so raw upserts and
 *   Sequelize queries agree on SQLite and Postgres. `count` is bumped
 *   atomically with INSERT ... ON CONFLICT DO UPDATE. Rows are removed with
 *   their guild link.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('message_counts', {
        guildLinkId: {
            type: DataTypes.UUID,
            primaryKey: true,
            allowNull: false,
            references: { model: 'guild_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        sourcePlatform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        hour: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            allowNull: false,
        },
        count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references message_counts; its own foreign key goes with the
    // table, so dropping it is safe on both SQLite and Postgres.
    await queryInterface.dropTable('message_counts');
};
