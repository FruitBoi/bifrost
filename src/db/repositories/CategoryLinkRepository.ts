import { CategoryLink } from '../entities/CategoryLink';

export interface CategoryLinkRepository {
    create(data: {
        guildLinkId: string;
        discordCategoryId: string;
        fluxerChannelId: string;
    }): Promise<CategoryLink>;

    findById(id: string): Promise<CategoryLink | null>;

    findByDiscordCategoryId(
        discordCategoryId: string
    ): Promise<CategoryLink | null>;

    findAllByFluxerChannelId(fluxerChannelId: string): Promise<CategoryLink[]>;

    findAllByGuild(guildLinkId: string): Promise<CategoryLink[]>;

    deleteById(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    getCategoryLinksCount(): Promise<number>;
}
