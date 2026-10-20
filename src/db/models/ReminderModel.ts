import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ReminderPlatform } from '../entities/Reminder';

export class ReminderModel extends Model {
    declare id: number;
    declare platform: ReminderPlatform;
    declare userId: string;
    declare guildId: string;
    declare channelId: string;
    declare message: string;
    declare dueAt: Date;
    declare attempts: number;
    declare createdAt: Date;
}

ReminderModel.init(
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
        message: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        dueAt: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        attempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        tableName: 'reminders',
        createdAt: 'createdAt',
        updatedAt: false,
        indexes: [
            { fields: ['dueAt'] },
            { fields: ['platform', 'userId'] },
            { fields: ['platform', 'channelId'] },
        ],
    }
);
