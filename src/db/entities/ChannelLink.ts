export interface ChannelLink {
    id: string;
    guildLinkId: string;

    discordChannelId: string;
    fluxerChannelId: string;

    discordWebhookId: string;
    discordWebhookToken: string;

    fluxerWebhookId: string;
    fluxerWebhookToken: string;

    linkId: string;

    /** When true, new threads in either channel are bridged automatically. */
    autoSyncThreads: boolean;

    createdAt: Date;
}
