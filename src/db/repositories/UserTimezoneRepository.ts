import { UserTimezonePlatform } from '../entities/UserTimezone';

export interface UserTimezoneRepository {
    /** The stored zone string (e.g. `America/New_York` or `UTC+05:30`), or null. */
    get(platform: UserTimezonePlatform, userId: string): Promise<string | null>;

    /** Inserts or replaces the user's zone. */
    set(
        platform: UserTimezonePlatform,
        userId: string,
        timeZone: string
    ): Promise<void>;

    /** True when a row was removed. */
    delete(platform: UserTimezonePlatform, userId: string): Promise<boolean>;
}
