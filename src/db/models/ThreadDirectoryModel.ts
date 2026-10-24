import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { ThreadDirectoryPlatform } from '../entities/ThreadDirectory';

export class ThreadDirectoryModel extends Model {
    declare id: number;
    declare platform: ThreadDirectoryPlatform;
    declare guildId: string;
    declare channelId: string;
    declare messageId: string;
    /** JSON array of the 2nd..nth message IDs. */
    declare extraMessageIds: string;
    declare title: string;
    declare createdAt: Date;
    declare updatedAt: Date;
}

ThreadDirectoryModel.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
        },
        platform: { type: DataTypes.STRING, allowNull: false },
        guildId: { type: DataTypes.STRING, allowNull: false },
        channelId: { type: DataTypes.STRING, allowNull: false },
        messageId: { type: DataTypes.STRING, allowNull: false },
        extraMessageIds: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: '[]',
        },
        title: { type: DataTypes.STRING, allowNull: false },
    },
    {
        sequelize,
        tableName: 'thread_directories',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        indexes: [{ unique: true, fields: ['platform', 'channelId'] }],
    }
);
