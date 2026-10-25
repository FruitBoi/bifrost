import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { MessagePlatform } from '../entities/MessageLink';
import { CommandRoleGroup } from '../entities/CommandRole';

export class CommandRoleModel extends Model {
    declare platform: MessagePlatform;
    declare guildId: string;
    declare roleGroup: CommandRoleGroup;
    declare roleId: string;
}

CommandRoleModel.init(
    {
        platform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        guildId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        roleGroup: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        roleId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'command_roles',
        timestamps: false,
    }
);
