/** Platform a stored time zone belongs to (user IDs are per platform). */
export type UserTimezonePlatform = 'discord' | 'fluxer';

/**
 * A user's time zone (issue #27), asked for the first time `remindme` needs
 * to interpret a date or time such as `Monday 7pm`. `timeZone` is an IANA
 * name (`America/New_York`) or a fixed offset (`UTC+05:30`).
 */
export interface UserTimezone {
    platform: UserTimezonePlatform;
    userId: string;
    timeZone: string;
    updatedAt: Date;
}
