export interface MessageLink {
    id: string;
    guildLinkId: string;
    channelLinkId: string;

    /** Set when the message lives inside a bridged thread rather than the channel itself. */
    threadLinkId: string | null;

    discordMessageId: string;
    fluxerMessageId: string;

    createdAt: Date;
}
