import { ChannelLink } from '../entities/ChannelLink';

export interface CreateChannelLinkData {
    guildLinkId: string;
    /** Webhook-owning channel; the thread's parent when `discordThreadId` is set. */
    discordChannelId: string;
    discordThreadId?: string | null;
    /** Webhook-owning channel; the thread's parent when `fluxerThreadId` is set. */
    fluxerChannelId: string;
    fluxerThreadId?: string | null;
    discordWebhookId: string;
    discordWebhookToken: string;
    fluxerWebhookId: string;
    fluxerWebhookToken: string;
}

export interface ChannelLinkRepository {
    create(data: CreateChannelLinkData): Promise<ChannelLink>;

    findByGuildAndLinkId(
        guildLinkId: string,
        linkId: string
    ): Promise<ChannelLink | null>;

    findAllByGuild(guildLinkId: string): Promise<ChannelLink[]>;

    findById(id: string): Promise<ChannelLink | null>;

    /**
     * Finds the link whose Discord side *is* this location: the row with
     * `discordThreadId = id`, or the channel row (`discordThreadId IS NULL`)
     * with `discordChannelId = id`.
     */
    findByDiscordLocation(locationId: string): Promise<ChannelLink | null>;

    /** Mirror of {@link findByDiscordLocation} for the Fluxer side. */
    findByFluxerLocation(locationId: string): Promise<ChannelLink | null>;

    /** All rows whose Discord webhook channel is this channel (the channel row and its thread rows). */
    findAllByDiscordChannel(discordChannelId: string): Promise<ChannelLink[]>;

    /** All rows whose Fluxer webhook channel is this channel (the channel row and its thread rows). */
    findAllByFluxerChannel(fluxerChannelId: string): Promise<ChannelLink[]>;

    /** Number of rows sharing this Discord webhook (webhooks are shared between a channel and its threads). */
    countByDiscordWebhookId(discordWebhookId: string): Promise<number>;

    /** Number of rows sharing this Fluxer webhook. */
    countByFluxerWebhookId(fluxerWebhookId: string): Promise<number>;

    setAutoSyncThreads(id: string, enabled: boolean): Promise<ChannelLink>;

    deleteById(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    getChannelLinksCount(): Promise<number>;
}
