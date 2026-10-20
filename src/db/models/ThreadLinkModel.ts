import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class ThreadLinkModel extends Model {}

ThreadLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
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
        discordThreadId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        fluxerThreadId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'thread_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { unique: true, fields: ['discordThreadId'] },
            { unique: true, fields: ['fluxerThreadId'] },
            { fields: ['channelLinkId'] },
            { fields: ['guildLinkId'] },
        ],
    }
);
