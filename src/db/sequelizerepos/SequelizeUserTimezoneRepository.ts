import { UserTimezonePlatform } from '../entities/UserTimezone';
import { UserTimezoneModel } from '../models';
import { UserTimezoneRepository } from '../repositories/UserTimezoneRepository';

export class SequelizeUserTimezoneRepository implements UserTimezoneRepository {
    async get(
        platform: UserTimezonePlatform,
        userId: string
    ): Promise<string | null> {
        const model = await UserTimezoneModel.findOne({
            where: { platform, userId },
        });
        return model ? model.timeZone : null;
    }

    async set(
        platform: UserTimezonePlatform,
        userId: string,
        timeZone: string
    ): Promise<void> {
        // upsert issues INSERT ... ON CONFLICT on both SQLite and Postgres
        // (the composite primary key is the conflict target).
        await UserTimezoneModel.upsert({ platform, userId, timeZone });
    }

    async delete(
        platform: UserTimezonePlatform,
        userId: string
    ): Promise<boolean> {
        const destroyed = await UserTimezoneModel.destroy({
            where: { platform, userId },
        });
        return destroyed > 0;
    }
}
