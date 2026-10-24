import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { UserTimezonePlatform } from '../entities/UserTimezone';

export class UserTimezoneModel extends Model {
    declare platform: UserTimezonePlatform;
    declare userId: string;
    declare timeZone: string;
    declare createdAt: Date;
    declare updatedAt: Date;
}

UserTimezoneModel.init(
    {
        platform: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        userId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        timeZone: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'user_timezones',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
    }
);
