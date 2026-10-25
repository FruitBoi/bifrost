import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { MessagePlatform } from '../entities/MessageLink';

export class MessageCountModel extends Model {
    declare guildLinkId: string;
    declare sourcePlatform: MessagePlatform;
    declare hour: number;
    declare count: number;
}

MessageCountModel.init(
    {
        guildLinkId: {
            type: DataTypes.UUID,
            primaryKey: true,
            allowNull: false,
            references: {
                model: 'guild_links',
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        sourcePlatform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        hour: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            allowNull: false,
        },
        count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        tableName: 'message_counts',
        timestamps: false,
    }
);
