import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ReminderPlatform } from '../entities/Reminder';
import { ReminderMessageKind } from '../entities/ReminderMessage';

export class ReminderMessageModel extends Model {
    declare id: number;
    declare platform: ReminderPlatform;
    declare messageId: string;
    declare kind: ReminderMessageKind;
    declare userId: string;
    declare guildId: string;
    declare channelId: string;
    declare message: string;
    declare createdAt: Date;
}

ReminderMessageModel.init(
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
        messageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        kind: {
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
        // Set explicitly by the repository (the service's clock), so it is a
        // plain attribute rather than a Sequelize-managed timestamp.
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'reminder_messages',
        timestamps: false,
        indexes: [
            {
                name: 'reminder_messages_platform_message',
                unique: true,
                fields: ['platform', 'messageId'],
            },
            {
                name: 'reminder_messages_platform_user_guild_kind_created',
                fields: ['platform', 'userId', 'guildId', 'kind', 'createdAt'],
            },
            {
                name: 'reminder_messages_created_at',
                fields: ['createdAt'],
            },
        ],
    }
);
