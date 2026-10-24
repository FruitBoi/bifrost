import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ThreadDirectoryPlatform } from '../entities/ThreadDirectory';

export class ThreadDirectoryEntryModel extends Model {
    declare id: number;
    declare platform: ThreadDirectoryPlatform;
    declare channelId: string;
    declare threadId: string;
    declare description: string | null;
    declare hidden: boolean;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ThreadDirectoryEntryModel.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        threadId: { type: DataTypes.STRING, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        hidden: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
    },
    {
        sequelize,
        tableName: 'thread_directory_entries',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        indexes: [
            { unique: true, fields: ['platform', 'threadId'] },
            { fields: ['platform', 'channelId'] },
        ],
    }
);
