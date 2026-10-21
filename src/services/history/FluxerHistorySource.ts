import {
    Client,
    Message,
    MessageType,
    TextChannel,
    ThreadChannel,
} from '@fluxerjs/core';
import type { HistoryItem, HistorySource } from './HistorySource';
import type { ChannelLink } from '../../db/entities/ChannelLink';
import type { GuildLink } from '../../db/entities/GuildLink';
import type { LinkService } from '../LinkService';
import type FluxerToDiscordMessageRelay from '../messageRelay/FluxerToDiscordMessageRelay';
import type { WebhookMessageData } from '../WebhookService';
import { isCommandString } from '../../commands/parseCommandString';
import { COMMAND_PREFIX } from '../../utils/env';

/** A Fluxer location whose history can be read. */
export type FluxerHistoryChannel = TextChannel | ThreadChannel;

/** Only plain messages and replies are copied; everything else is a system message. */
const CONTENT_MESSAGE_TYPES = new Set<number>([
    MessageType.Default,
    MessageType.Reply,
]);

/** A Fluxer message reduced to what the history transfer decides on. */
export function toFluxerHistoryItem(message: Message): HistoryItem<Message> {
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
            message.stickers.length === 0,
        isCommand: isCommandString(message.content, COMMAND_PREFIX),
        raw: message,
    };
}

/**
 * The Fluxer side of a channel link as a {@link HistorySource}: reads the
 * channel's (or thread's) history and posts copies to the linked Discord
 * location through the live relay, so they look exactly like bridged
 * messages (issue #16).
 */
export default class FluxerHistorySource implements HistorySource<Message> {
    readonly platform = 'fluxer' as const;
    readonly link: ChannelLink;
    readonly guildLink: GuildLink;
    readonly botUserId: string | null;

    private readonly client: Client;
    private readonly channel: FluxerHistoryChannel;
    private readonly relay: FluxerToDiscordMessageRelay;
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
        channel: FluxerHistoryChannel;
        link: ChannelLink;
        guildLink: GuildLink;
        relay: FluxerToDiscordMessageRelay;
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
    ): Promise<HistoryItem<Message>[]> {
        const page = await this.channel.messages.fetch({
            limit,
            ...(beforeId ? { before: beforeId } : {}),
        });
        return [...page.values()].map(toFluxerHistoryItem);
    }

    async fetchAfter(
        afterId: string,
        limit: number
    ): Promise<HistoryItem<Message>[]> {
        const page = await this.channel.messages.fetch({
            limit,
            after: afterId,
        });
        return [...page.values()].map(toFluxerHistoryItem);
    }

    buildPayload(item: HistoryItem<Message>): Promise<WebhookMessageData> {
        return this.relay.buildPayload(item.raw, this.guildLink);
    }

    send(payload: WebhookMessageData): Promise<{ messageId: string }> {
        return this.relay.sendPayload(this.link, payload);
    }

    async isBridged(messageId: string): Promise<boolean> {
        return !!(await this.linkService.getMessageLinkByFluxerMessageId(
            messageId
        ));
    }

    async createMessageLink(
        item: HistoryItem<Message>,
        targetMessageId: string
    ): Promise<void> {
        await this.linkService.createMessageLink({
            discordMessageId: targetMessageId,
            fluxerMessageId: item.id,
            guildLinkId: this.link.guildLinkId,
            channelLinkId: this.link.id,
            sourcePlatform: 'fluxer',
            // A webhook/integration author has no user to ping on Discord.
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
