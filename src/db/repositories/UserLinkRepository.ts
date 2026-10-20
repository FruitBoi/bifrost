import { UserLink } from '../entities/UserLink';

export interface CreateUserLinkData {
    guildLinkId: string;
    discordUserId: string;
    fluxerUserId: string;
}

export interface UserLinkRepository {
    /** Inserts a row; rejects when either user is already mapped in the guild link. */
    create(data: CreateUserLinkData): Promise<UserLink>;

    findById(id: string): Promise<UserLink | null>;

    findByDiscordUser(
        guildLinkId: string,
        discordUserId: string
    ): Promise<UserLink | null>;

    findByFluxerUser(
        guildLinkId: string,
        fluxerUserId: string
    ): Promise<UserLink | null>;

    findAllByGuild(guildLinkId: string): Promise<UserLink[]>;

    deleteById(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    getUserLinksCount(): Promise<number>;
}
