import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Claude request notifications (issue #26): every issue filed by the
 * `clauderequest` command is remembered so the requester can be told in the
 * channel they asked from once the issue is closed.
 *
 * - claude_requests: one row per filed request that has not been reported
 *   back yet. The IDs belong to `platform` (Discord or Fluxer); `messageId`
 *   is the invoking message, replied to when it still exists. `attempts`
 *   counts failed notifications so a request that keeps failing is dropped.
 *   Rows are deleted once the requester was notified. `issueNumber` is not
 *   unique: the configured repository may change between deployments.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('claude_requests', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        issueNumber: { type: DataTypes.INTEGER, allowNull: false },
        issueUrl: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING, allowNull: false },
        userId: { type: DataTypes.STRING, allowNull: false },
        guildId: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        messageId: { type: DataTypes.STRING, allowNull: true },
        attempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('claude_requests', ['issueNumber'], {
        name: 'claude_requests_issue_number',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references claude_requests and it references nothing, so
    // dropping the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('claude_requests');
};
