import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class VoiceLinkModel extends Model {}

VoiceLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        discordChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        enabled: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
        },
    },
    {
        sequelize,
        tableName: 'voice_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { unique: true, fields: ['discordChannelId'] },
            { unique: true, fields: ['fluxerChannelId'] },
            { fields: ['guildLinkId'] },
        ],
    }
);
