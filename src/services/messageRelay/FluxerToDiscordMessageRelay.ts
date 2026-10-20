import { Message, MessageType } from '@fluxerjs/core';
import MessageRelay from './MessageRelay';
import logger from '../../utils/logging/logger';
import { formatJoinMessage } from '../../utils/formatJoinMessage';
import MessageQueueService, { toSerializable } from '../MessageQueueService';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import { ChannelLink } from '../../db/entities/ChannelLink';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';
import ThreadSyncService from '../threadSync/ThreadSyncService';

/** System messages emitted alongside thread creation; never worth bridging. */
const SKIPPED_MESSAGE_TYPES = new Set<number>([
    MessageType.ThreadCreated,
    MessageType.ThreadStarterMessage,
]);

export default class FluxerToDiscordMessageRelay extends MessageRelay<Message> {
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly threadSyncService: ThreadSyncService;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
        threadSyncService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<Message, WebhookMessageData>;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        discordEntityResolver: DiscordEntityResolver;
        threadSyncService: ThreadSyncService;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
            metricsService,
            queueService,
        });
        this.discordEntityResolver = discordEntityResolver;
        this.threadSyncService = threadSyncService;
    }

    private async resolveLink(message: Message): Promise<ChannelLink | null> {
        const link = await this.getLinkService().getChannelLinkByFluxerLocation(
            message.channelId
        );
        if (link) return link;

        const channel =
            message.channel ??
            (await message.resolveChannel().catch(() => null));
        if (channel?.isThread()) {
            return this.threadSyncService.resolveFluxerThread(channel);
        }
        return null;
    }

    public async relayMessage(message: Message): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        if (SKIPPED_MESSAGE_TYPES.has(message.type)) return;

        const linkedChannel = await this.resolveLink(message);
        if (!linkedChannel) return;

        // Our own webhook echoing a bridged message back into the channel/thread.
        if (
            message.webhookId &&
            message.webhookId === linkedChannel.fluxerWebhookId
        )
            return;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        const discordThreadId = linkedChannel.discordThreadId;
        // A webhook/integration author has no user id to ping on Discord.
        const sourceAuthorId = message.webhookId
            ? undefined
            : message.author.id;

        // Build payload before attempting send so it can be queued on failure
        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(
                    message.author.username +
                        '#' +
                        message.author.discriminator,
                    'fluxer'
                ),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            const discordEmojis = await this.discordEntityResolver.fetchEmojis(
                guildLink.discordGuildId
            );
            msg = await this.getMessageTransformer().transformMessage(
                message,
                discordEmojis
            );
        }

        try {
            const webhook = await webhookService.getDiscordWebhook(
                linkedChannel.discordWebhookId,
                linkedChannel.discordWebhookToken
            );
            if (!webhook) {
                logger.warn(
                    `⚠️ No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message`
                );
                return;
            }

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaDiscordWebhook(
                    webhook,
                    msg,
                    discordThreadId
                );

            if (message.type !== MessageType.UserJoin) {
                await linkService.createMessageLink({
                    discordMessageId: webhookMessageId,
                    fluxerMessageId: message.id,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                    sourcePlatform: 'fluxer',
                    sourceAuthorId,
                });
            }
            this.metricsService?.messagesRelayed.inc({
                direction: 'fluxer_to_discord',
            });
        } catch (error) {
            logger.error('❌ Error relaying message to Discord:', error);
            this.metricsService?.messageRelayErrors.inc({
                direction: 'fluxer_to_discord',
            });
            await this.queueService?.enqueue(
                'fluxer_to_discord',
                linkedChannel.id,
                message.id,
                toSerializable(msg, sourceAuthorId)
            );
        }
    }
}
