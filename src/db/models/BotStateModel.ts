import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class BotStateModel extends Model {
    declare key: string;
    declare value: string;
    declare updatedAt: Date;
}

BotStateModel.init(
    {
        key: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        value: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'bot_state',
        timestamps: false,
    }
);
