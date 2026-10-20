import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class UserLinkModel extends Model {}

UserLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        discordUserId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        fluxerUserId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'user_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { unique: true, fields: ['guildLinkId', 'discordUserId'] },
            { unique: true, fields: ['guildLinkId', 'fluxerUserId'] },
            { fields: ['guildLinkId'] },
        ],
    }
);
