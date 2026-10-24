import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ClaudeRequestPlatform } from '../entities/ClaudeRequest';

export class ClaudeRequestModel extends Model {
    declare id: number;
    declare platform: ClaudeRequestPlatform;
    declare issueNumber: number;
    declare issueUrl: string;
    declare title: string;
    declare userId: string;
    declare guildId: string;
    declare channelId: string;
    declare messageId: string | null;
    declare attempts: number;
    declare createdAt: Date;
}

ClaudeRequestModel.init(
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
        messageId: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        attempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        tableName: 'claude_requests',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [{ fields: ['issueNumber'] }],
    }
);
