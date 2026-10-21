import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { MessagePlatform } from '../entities/MessageLink';

export class HistoryMessageModel extends Model {
    declare id: string;
    declare guildLinkId: string;
    declare channelLinkId: string;
    declare sourcePlatform: MessagePlatform;
    declare sourceMessageId: string;
    declare targetMessageId: string;
    declare createdAt: Date;
}

HistoryMessageModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: {
                model: 'guild_links',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: {
                model: 'channel_links',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        sourcePlatform: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        sourceMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        targetMessageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'history_messages',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            {
                unique: true,
                fields: ['sourcePlatform', 'sourceMessageId'],
            },
            {
                fields: ['channelLinkId'],
            },
            {
                fields: ['guildLinkId'],
            },
            {
                fields: ['targetMessageId'],
            },
        ],
    }
);
