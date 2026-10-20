/** The platform a bridged message was originally written on. */
export type MessagePlatform = 'discord' | 'fluxer';

export interface MessageLink {
    id: string;
    guildLinkId: string;
    channelLinkId: string;

    discordMessageId: string;
    fluxerMessageId: string;

    /**
     * Which side holds the original, human-authored message; the other side
     * is the webhook copy. Null on rows created before this was recorded.
     */
    sourcePlatform: MessagePlatform | null;
    /** The original author's user id on `sourcePlatform`. */
    sourceAuthorId: string | null;

    createdAt: Date;
}
