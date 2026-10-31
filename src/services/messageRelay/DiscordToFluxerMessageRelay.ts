import { Message, MessageType, OmitPartialGroupDMChannel } from 'discord.js';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import MessageQueueService, { toSerializable } from '../MessageQueueService';
import type MessageCountService from '../messageCount/MessageCountService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';
import ThreadSyncService from '../threadSync/ThreadSyncService';
import { hasPendingGifLink } from '../linkedMedia/discordLinkedMedia';
import { toLinkedMediaEmbed } from '../messageTransformer/DiscordMessageTransformer';

type DiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

/** Wait between re-fetches of a message whose gif link has not unfurled. */
const UNFURL_RETRY_DELAY_MS = 1000;
/** Re-fetches before relaying the message as it is (~3s at most). */
const UNFURL_MAX_TRIES = 3;
/**
 * Only messages this fresh are waited on: Discord unfurls within seconds,
 * so an older one (history transfer, pins) will not gain its embed.
 */
const UNFURL_MAX_AGE_MS = 60_000;

/**
 * The payload with its media-link uploads dropped and the links put back in
 * the content: what to send (or queue) when those downloads fail.
 */
export function withoutLinkedMedia(
    payload: WebhookMessageData
): WebhookMessageData {
    const { linkFallbackContent, ...rest } = payload;
    if (!payload.attachments?.some((a) => a.fromLink)) return rest;
    return {
        ...rest,
        content: linkFallbackContent ?? payload.content,
        attachments: payload.attachments.filter((a) => !a.fromLink),
    };
}

/**
 * System messages emitted alongside thread creation, and "X pinned a
 * message" notices (the pin itself is bridged, which makes the other
 * platform post its own notice); never worth bridging.
 */
const SKIPPED_MESSAGE_TYPES = new Set<MessageType>([
    MessageType.ThreadCreated,
    MessageType.ThreadStarterMessage,
    MessageType.ChannelPinnedMessage,
]);

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly threadSyncService: ThreadSyncService;
    private readonly unfurlRetryDelayMs: number;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        messageCountService,
        fluxerEntityResolver,
        threadSyncService,
        unfurlRetryDelayMs = UNFURL_RETRY_DELAY_MS,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            OmitPartialGroupDMChannel<Message<boolean>>,
            WebhookMessageData
        >;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        messageCountService?: MessageCountService;
        fluxerEntityResolver: FluxerEntityResolver;
        threadSyncService: ThreadSyncService;
        /** Wait between re-fetches while a gif link is unfurling; tests pass 0. */
        unfurlRetryDelayMs?: number;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
            metricsService,
            queueService,
            messageCountService,
        });
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.threadSyncService = threadSyncService;
        this.unfurlRetryDelayMs = unfurlRetryDelayMs;
    }

    protected sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private static hasPendingGif(message: DiscordMessage): boolean {
        return hasPendingGifLink(
            message.content ?? '',
            (message.embeds ?? []).map(toLinkedMediaEmbed)
        );
    }

    /**
     * A GIF-picker link is usually posted before Discord unfurls it (the
     * gifv embed arrives in a later update), and the media to upload comes
     * from that embed. While a fresh message still has such a link pending,
     * re-fetches it a few times; returns the freshest copy, or the original
     * when fetching fails.
     */
    private async awaitGifUnfurl(
        message: DiscordMessage
    ): Promise<DiscordMessage> {
        if (!DiscordToFluxerMessageRelay.hasPendingGif(message)) return message;
        const age = Date.now() - (message.createdTimestamp ?? Date.now());
        if (age > UNFURL_MAX_AGE_MS) return message;

        let current = message;
        for (let attempt = 1; attempt <= UNFURL_MAX_TRIES; attempt++) {
            await this.sleep(this.unfurlRetryDelayMs);
            try {
                current = (await message.fetch(true)) as DiscordMessage;
            } catch (error) {
                logger.warn(
                    `⚠️ Could not re-fetch message ${message.id} for its gif embed:`,
                    error
                );
                return current;
            }
            if (!DiscordToFluxerMessageRelay.hasPendingGif(current)) break;
        }
        return current;
    }

    private async resolveLink(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<ChannelLink | null> {
        const link =
            await this.getLinkService().getChannelLinkByDiscordLocation(
                message.channelId
            );
        if (link) return link;

        if (message.channel.isThread()) {
            return this.threadSyncService.resolveDiscordThread(message.channel);
        }
        return null;
    }

    public async buildPayload(
        message: OmitPartialGroupDMChannel<Message<boolean>>,
        guildLink: GuildLink
    ): Promise<WebhookMessageData> {
        if (message.type === MessageType.UserJoin) {
            return {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        }
        const fresh = await this.awaitGifUnfurl(message);
        const fluxerEmojis = await this.fluxerEntityResolver.fetchEmojis(
            guildLink.fluxerGuildId
        );
        return this.getMessageTransformer().transformMessage(
            fresh,
            fluxerEmojis
        );
    }

    /**
     * Sends the payload; when that fails and it uploads media downloaded from
     * links, retries once with the links instead (live relays, history
     * transfers and pins alike). A Fluxer API block is not retried.
     */
    public async sendPayload(
        link: ChannelLink,
        payload: WebhookMessageData
    ): Promise<{ messageId: string }> {
        try {
            return await this.sendToFluxer(link, payload);
        } catch (error) {
            if (
                !payload.attachments?.some((a) => a.fromLink) ||
                isFluxerApiBlockError(error)
            )
                throw error;
            logger.warn(
                '⚠️ Uploading linked gif/video media to Fluxer failed, sending the links instead:',
                error
            );
            return this.sendToFluxer(link, withoutLinkedMedia(payload));
        }
    }

    private async sendToFluxer(
        link: ChannelLink,
        payload: WebhookMessageData
    ): Promise<{ messageId: string }> {
        const webhookService = this.getWebhookService();
        const webhook = await webhookService.getFluxerWebhook(
            link.fluxerWebhookId,
            link.fluxerWebhookToken
        );
        return webhookService.sendMessageViaFluxerWebhook(
            webhook,
            payload,
            link.fluxerThreadId
        );
    }

    public async relayMessage(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<void> {
        const linkService = this.getLinkService();

        if (SKIPPED_MESSAGE_TYPES.has(message.type)) return;

        const linkedChannel = await this.resolveLink(message);
        if (!linkedChannel) return;

        // Our own webhook echoing a bridged message back into the channel/thread.
        if (
            message.webhookId &&
            message.webhookId === linkedChannel.discordWebhookId
        )
            return;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        // A webhook/integration author has no user id to ping on Fluxer.
        const sourceAuthorId = message.webhookId
            ? undefined
            : message.author.id;

        // Build payload before attempting send so it can be queued on failure
        const msg = await this.buildPayload(message, guildLink);
        // Queued retries must never depend on downloading linked media.
        const fallback = withoutLinkedMedia(msg);

        if (isFluxerApiBlocked()) {
            logger.debug(
                `📬 Fluxer API blocked, queueing message ${message.id} without sending`
            );
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(fallback, sourceAuthorId, {
                    uncounted: message.type === MessageType.UserJoin,
                })
            );
            return;
        }

        try {
            const { messageId: webhookMessageId } = await this.sendPayload(
                linkedChannel,
                msg
            );

            if (message.type !== MessageType.UserJoin) {
                // Join notices are not chat messages and are not counted.
                this.countBridgedMessage(linkedChannel.guildLinkId, 'discord');
                await linkService.createMessageLink({
                    discordMessageId: message.id,
                    fluxerMessageId: webhookMessageId,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                    sourcePlatform: 'discord',
                    sourceAuthorId,
                });
            }
            this.metricsService?.messagesRelayed.inc({
                direction: 'discord_to_fluxer',
            });
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            logger.error('❌ Error relaying message to Fluxer:', error);
            this.metricsService?.messageRelayErrors.inc({
                direction: 'discord_to_fluxer',
            });
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(fallback, sourceAuthorId, {
                    uncounted: message.type === MessageType.UserJoin,
                })
            );
        }
    }
}
