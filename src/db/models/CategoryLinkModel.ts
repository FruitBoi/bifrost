import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class CategoryLinkModel extends Model {}

CategoryLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        discordCategoryId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'category_links',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { unique: true, fields: ['discordCategoryId'] },
            { fields: ['fluxerChannelId'] },
            { fields: ['guildLinkId'] },
        ],
    }
);
