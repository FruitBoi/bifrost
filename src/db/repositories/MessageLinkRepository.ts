import { MessageLink, MessagePlatform } from '../entities/MessageLink';

/**
 * Where the original message lives and who wrote it. `authorId` is null when
 * the original was posted by a webhook or integration: there is no user to
 * ping on that platform.
 */
export interface MessageLinkSource {
    platform: MessagePlatform;
    authorId: string | null;
}

export interface MessageLinkRepository {
    createMessageLink(
        guildLinkId: string,
        channelLinkId: string,
        discordMessageId: string,
        fluxerMessageId: string,
        source?: MessageLinkSource
    ): Promise<void>;

    getMessageLinkById(id: string): Promise<MessageLink | null>;

    getMessageLinkByDiscordMessageId(
        discordMessageId: string
    ): Promise<MessageLink | null>;

    getMessageLinkByFluxerMessageId(
        fluxerMessageId: string
    ): Promise<MessageLink | null>;

    deleteMessageLink(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    deleteByChannelLinkId(channelLinkId: string): Promise<void>;

    getMessageLinksCount(): Promise<number>;
}
