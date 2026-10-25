import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Per-server command role allowlists (issue #43): server administrators can
 * choose which roles may use the role-gated commands (`clean`, `history`,
 * `role`, `map`) instead of everyone sharing the global lists from
 * config.yml.
 *
 * - command_roles: one row per allowlisted role, keyed by (platform, guildId,
 *   roleGroup, roleId), the composite primary key. `guildId` is the raw
 *   Discord or Fluxer guild ID, not a guild link: the allowlist belongs to
 *   one server and must work whether or not it is bridged, so there is no
 *   foreign key. A (platform, guildId, roleGroup) without rows falls back to
 *   the config defaults. Role IDs are snowflakes, kept as strings.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('command_roles', {
        platform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        guildId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        roleGroup: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        roleId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references command_roles and it references nothing.
    await queryInterface.dropTable('command_roles');
};
