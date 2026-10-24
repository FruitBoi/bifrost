import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Claude request notices (issue #35): every "Claude request implemented" /
 * "Claude request closed" notice the bot posts is remembered so a reply to
 * it can be commented on the GitHub issue, which is then reopened.
 *
 * - claude_request_notices: one row per posted notice. The IDs belong to
 *   `platform` (Discord or Fluxer); `noticeMessageId` is the bot's notice
 *   message and is unique per platform. `userId` is the original requester.
 *   Rows older than 180 days are pruned by the notify service.
 */
export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('claude_request_notices', {
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
        noticeMessageId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex(
        'claude_request_notices',
        ['platform', 'noticeMessageId'],
        {
            name: 'claude_request_notices_platform_notice_message_id',
            unique: true,
        }
    );
    await queryInterface.addIndex('claude_request_notices', ['createdAt'], {
        name: 'claude_request_notices_created_at',
    });
};

export const down: Migration = async ({ context: queryInterface }) => {
    // Nothing references claude_request_notices and it references nothing,
    // so dropping the table is safe on both SQLite and Postgres.
    await queryInterface.dropTable('claude_request_notices');
};
