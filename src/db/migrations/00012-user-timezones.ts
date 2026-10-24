import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Per-user time zones (issue #27): `remindme` accepts dates and times such
 * as `Oct 26 20:15` or `Monday 7pm`, which need the user's zone. It is asked
 * for once and remembered here.
 *
 * - user_timezones: one row per (platform, userId), which is the composite
 *   primary key, so a user has at most one zone per platform. `timeZone` is
 *   an IANA name or a fixed offset like `UTC+05:30`.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('user_timezones', {
        platform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        userId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        timeZone: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references user_timezones and it references nothing, so
    // dropping the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('user_timezones');
};
