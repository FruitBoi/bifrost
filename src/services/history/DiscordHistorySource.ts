import {
    Client,
    GuildTextBasedChannel,
    Message,
    MessageType,
    OmitPartialGroupDMChannel,
} from 'discord.js';
import type { HistoryItem, HistorySource } from './HistorySource';
import type { ChannelLink } from '../../db/entities/ChannelLink';
import type { GuildLink } from '../../db/entities/GuildLink';
import type { LinkService } from '../LinkService';
import type DiscordToFluxerMessageRelay from '../messageRelay/DiscordToFluxerMessageRelay';
import type { WebhookMessageData } from '../WebhookService';
import { isCommandString } from '../../commands/parseCommandString';
import { COMMAND_PREFIX } from '../../utils/env';

export type DiscordHistoryMessage = OmitPartialGroupDMChannel<Message<boolean>>;

/** Only plain messages and replies are copied; everything else is a system message. */
const CONTENT_MESSAGE_TYPES = new Set<MessageType>([
    MessageType.Default,
    MessageType.Reply,
]);

/** A Discord message reduced to what the history transfer decides on. */
export function toDiscordHistoryItem(
    message: Message<boolean>
): HistoryItem<DiscordHistoryMessage> {
    return {
        id: message.id,
        createdAt: message.createdAt,
        authorId: message.author.id,
        // The same name the live transformer uses as the webhook username.
        authorName: message.author.username,
        authorIsBot: message.author.bot,
        webhookId: message.webhookId ?? null,
        isSystem: !CONTENT_MESSAGE_TYPES.has(message.type),
        isEmpty:
            !message.content &&
            message.attachments.size === 0 &&
            message.embeds.length === 0 &&
            message.stickers.size === 0,
        isCommand: isCommandString(message.content, COMMAND_PREFIX),
        raw: message as DiscordHistoryMessage,
    };
}

/**
 * The Discord side of a channel link as a {@link HistorySource}: reads the
 * channel's (or thread's) history and posts copies to the linked Fluxer
 * location through the live relay, so they look exactly like bridged
 * messages (issue #16).
 */
export default class DiscordHistorySource implements HistorySource<DiscordHistoryMessage> {
    readonly platform = 'discord' as const;
    readonly link: ChannelLink;
    readonly guildLink: GuildLink;
    readonly botUserId: string | null;

    private readonly client: Client;
    private readonly channel: GuildTextBasedChannel;
    private readonly relay: DiscordToFluxerMessageRelay;
    private readonly linkService: LinkService;

    constructor({
        client,
        channel,
        link,
        guildLink,
        relay,
        linkService,
    }: {
        client: Client;
        channel: GuildTextBasedChannel;
        link: ChannelLink;
        guildLink: GuildLink;
        relay: DiscordToFluxerMessageRelay;
        linkService: LinkService;
    }) {
        this.client = client;
        this.channel = channel;
        this.link = link;
        this.guildLink = guildLink;
        this.relay = relay;
        this.linkService = linkService;
        this.botUserId = client.user?.id ?? null;
    }

    async fetchBefore(
        beforeId: string | undefined,
        limit: number
    ): Promise<HistoryItem<DiscordHistoryMessage>[]> {
        const page = await this.channel.messages.fetch({
            limit,
            ...(beforeId ? { before: beforeId } : {}),
        });
        return [...page.values()].map(toDiscordHistoryItem);
    }

    async fetchAfter(
        afterId: string,
        limit: number
    ): Promise<HistoryItem<DiscordHistoryMessage>[]> {
        const page = await this.channel.messages.fetch({
            limit,
            after: afterId,
        });
        return [...page.values()].map(toDiscordHistoryItem);
    }

    buildPayload(
        item: HistoryItem<DiscordHistoryMessage>
    ): Promise<WebhookMessageData> {
        return this.relay.buildPayload(item.raw, this.guildLink);
    }

    send(payload: WebhookMessageData): Promise<{ messageId: string }> {
        return this.relay.sendPayload(this.link, payload);
    }

    async isBridged(messageId: string): Promise<boolean> {
        return !!(await this.linkService.getMessageLinkByDiscordMessageId(
            messageId
        ));
    }

    async createMessageLink(
        item: HistoryItem<DiscordHistoryMessage>,
        targetMessageId: string
    ): Promise<void> {
        await this.linkService.createMessageLink({
            discordMessageId: item.id,
            fluxerMessageId: targetMessageId,
            guildLinkId: this.link.guildLinkId,
            channelLinkId: this.link.id,
            sourcePlatform: 'discord',
            // A webhook/integration author has no user to ping on Fluxer.
            sourceAuthorId: item.webhookId ? undefined : item.authorId,
        });
    }

    digestIdentity(): { username: string; avatarURL: string } {
        return {
            username: this.client.user?.username ?? 'Bifröst',
            avatarURL: this.client.user?.displayAvatarURL() ?? '',
        };
    }
}
