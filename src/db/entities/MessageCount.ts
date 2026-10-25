import { MessagePlatform } from './MessageLink';

/** Messages bridged from one platform of a guild link during one UTC hour. */
export interface MessageCount {
    guildLinkId: string;
    sourcePlatform: MessagePlatform;
    /** UTC epoch hour: `Math.floor(ms / 3_600_000)`. */
    hour: number;
    count: number;
}
