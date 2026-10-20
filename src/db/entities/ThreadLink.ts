export interface ThreadLink {
    id: string;
    guildLinkId: string;
    channelLinkId: string;

    discordThreadId: string;
    fluxerThreadId: string;

    createdAt: Date;
}
