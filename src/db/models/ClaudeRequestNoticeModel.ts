import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ClaudeRequestPlatform } from '../entities/ClaudeRequest';

export class ClaudeRequestNoticeModel extends Model {
    declare id: number;
    declare platform: ClaudeRequestPlatform;
    declare issueNumber: number;
    declare issueUrl: string;
    declare title: string;
    declare userId: string;
    declare guildId: string;
    declare channelId: string;
    declare noticeMessageId: string;
    declare createdAt: Date;
}

ClaudeRequestNoticeModel.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        issueNumber: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        issueUrl: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        title: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        userId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        guildId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        channelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        noticeMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'claude_request_notices',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { unique: true, fields: ['platform', 'noticeMessageId'] },
            { fields: ['createdAt'] },
        ],
    }
);
