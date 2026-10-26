import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Generic key/value store for process-wide bot state that has to survive
 * restarts. First use: the last deploy commit the bot announced, so the
 * deploy summary is posted once per new commit (issue #47).
 *
 * - bot_state: one row per key. `key` is the primary key; `value` is TEXT
 *   so callers may store anything serialisable. `updatedAt` is set by the
 *   repository on every write. Nothing references it and it references
 *   nothing.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('bot_state', {
        key: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        value: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
        },
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.dropTable('bot_state');
};
