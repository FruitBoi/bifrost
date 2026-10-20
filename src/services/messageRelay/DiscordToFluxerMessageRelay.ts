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
import { WebhookMessageData, WebhookService } from '../WebhookService';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkContext, LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import MetricsService from '../MetricsService';
import ThreadSyncService from '../threadSync/ThreadSyncService';

/** System messages emitted alongside thread creation; never worth bridging. */
const SKIPPED_MESSAGE_TYPES = new Set<MessageType>([
    MessageType.ThreadCreated,
    MessageType.ThreadStarterMessage,
]);

export default class DiscordToFluxerMessageRelay extends MessageRelay<
    OmitPartialGroupDMChannel<Message<boolean>>
> {
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly threadSyncService: ThreadSyncService;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        fluxerEntityResolver,
        threadSyncService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            OmitPartialGroupDMChannel<Message<boolean>>,
            WebhookMessageData
        >;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        fluxerEntityResolver: FluxerEntityResolver;
        threadSyncService: ThreadSyncService;
    }) {
        super({
            linkService,
            webhookService,
            messageTransformer,
            metricsService,
            queueService,
        });
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.threadSyncService = threadSyncService;
    }

    private async resolveContext(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<LinkContext | null> {
        if (message.channel.isThread()) {
            return this.threadSyncService.resolveDiscordThread(message.channel);
        }

        const channelLink =
            await this.getLinkService().getChannelLinkByDiscordChannelId(
                message.channelId
            );
        return channelLink ? { channelLink, threadLink: null } : null;
    }

    public async relayMessage(
        message: OmitPartialGroupDMChannel<Message<boolean>>
    ): Promise<void> {
        const linkService = this.getLinkService();
        const webhookService = this.getWebhookService();

        if (SKIPPED_MESSAGE_TYPES.has(message.type)) return;

        const context = await this.resolveContext(message);
        if (!context) return;
        const { channelLink: linkedChannel, threadLink } = context;

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

        const fluxerThreadId = threadLink?.fluxerThreadId ?? null;

        // Build payload before attempting send so it can be queued on failure
        let msg: WebhookMessageData;
        if (message.type === MessageType.UserJoin) {
            msg = {
                content: formatJoinMessage(message.author.username, 'discord'),
                username: message.client.user?.username || 'Bifröst',
                avatarURL: message.client.user?.avatarURL() || '',
            };
        } else {
            const fluxerEmojis = await this.fluxerEntityResolver.fetchEmojis(
                guildLink.fluxerGuildId
            );
            msg = await this.getMessageTransformer().transformMessage(
                message,
                fluxerEmojis
            );
        }

        if (isFluxerApiBlocked()) {
            logger.debug(
                `Fluxer API blocked, queueing message ${message.id} without sending`
            );
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(msg),
                threadLink?.id ?? null
            );
            return;
        }

        try {
            const webhook = await webhookService.getFluxerWebhook(
                linkedChannel.fluxerWebhookId,
                linkedChannel.fluxerWebhookToken
            );

            const { messageId: webhookMessageId } =
                await webhookService.sendMessageViaFluxerWebhook(
                    webhook,
                    msg,
                    fluxerThreadId
                );

            if (message.type !== MessageType.UserJoin) {
                await linkService.createMessageLink({
                    discordMessageId: message.id,
                    fluxerMessageId: webhookMessageId,
                    guildLinkId: linkedChannel.guildLinkId,
                    channelLinkId: linkedChannel.id,
                    threadLinkId: threadLink?.id ?? null,
                });
            }
            this.metricsService?.messagesRelayed.inc({
                direction: 'discord_to_fluxer',
            });
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            logger.error('Error relaying message to Fluxer:', error);
            this.metricsService?.messageRelayErrors.inc({
                direction: 'discord_to_fluxer',
            });
            await this.queueService?.enqueue(
                'discord_to_fluxer',
                linkedChannel.id,
                message.id,
                toSerializable(msg),
                threadLink?.id ?? null
            );
        }
    }
}
