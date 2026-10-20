import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class ChannelLinkModel extends Model {}

ChannelLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },

        guildLinkId: {
            type: DataTypes.UUID,
        },

        discordChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        discordThreadId: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerThreadId: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        discordWebhookId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        discordWebhookToken: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerWebhookId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerWebhookToken: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        linkId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        autoSyncThreads: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
    },
    {
        sequelize,
        tableName: 'channel_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            // A channel may be linked once as a channel, and may additionally
            // own any number of thread links.
            {
                unique: true,
                fields: ['discordChannelId'],
                where: { discordThreadId: null },
            },
            {
                unique: true,
                fields: ['fluxerChannelId'],
                where: { fluxerThreadId: null },
            },
            { unique: true, fields: ['discordThreadId'] },
            { unique: true, fields: ['fluxerThreadId'] },
            { fields: ['discordChannelId'] },
            { fields: ['fluxerChannelId'] },
            { fields: ['guildLinkId'] },
        ],
    }
);
