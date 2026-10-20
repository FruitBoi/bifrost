import { ThreadLink } from '../entities/ThreadLink';

export interface ThreadLinkRepository {
    create(data: {
        guildLinkId: string;
        channelLinkId: string;
        discordThreadId: string;
        fluxerThreadId: string;
    }): Promise<ThreadLink>;

    findById(id: string): Promise<ThreadLink | null>;

    findByDiscordThreadId(discordThreadId: string): Promise<ThreadLink | null>;

    findByFluxerThreadId(fluxerThreadId: string): Promise<ThreadLink | null>;

    findAllByChannelLink(channelLinkId: string): Promise<ThreadLink[]>;

    findAllByGuild(guildLinkId: string): Promise<ThreadLink[]>;

    deleteById(id: string): Promise<void>;

    deleteByChannelLinkId(channelLinkId: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    getThreadLinksCount(): Promise<number>;
}
