import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MetricsService from '../MetricsService';
import MessageQueueService from '../MessageQueueService';
import type MessageCountService from '../messageCount/MessageCountService';
import type { MessagePlatform } from '../../db/entities/MessageLink';
import logger from '../../utils/logging/logger';

export default abstract class MessageRelay<RelayMessage> {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly messageTransformer: MessageTransformer<
        RelayMessage,
        WebhookMessageData
    >;
    protected readonly metricsService: MetricsService | null;
    protected readonly queueService: MessageQueueService | null;
    protected readonly messageCountService: MessageCountService | null;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        messageCountService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            RelayMessage,
            WebhookMessageData
        >;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
        messageCountService?: MessageCountService;
    }) {
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.messageTransformer = messageTransformer;
        this.metricsService = metricsService ?? null;
        this.queueService = queueService ?? null;
        this.messageCountService = messageCountService ?? null;
    }

    /**
     * Counts one message bridged live from `source` (issue #46). Fire and
     * forget: called right after the send succeeded, so a counting failure
     * must never reach the relay's error path, which would queue (and later
     * re-send) a message that was already delivered.
     */
    protected countBridgedMessage(
        guildLinkId: string,
        source: MessagePlatform
    ): void {
        if (!this.messageCountService) return;
        try {
            this.messageCountService
                .record(guildLinkId, source)
                .catch((err: unknown) =>
                    logger.warn('⚠️ Failed to count bridged message:', err)
                );
        } catch (err) {
            logger.warn('⚠️ Failed to count bridged message:', err);
        }
    }

    public abstract relayMessage(message: RelayMessage): Promise<void>;

    /**
     * The webhook payload the bridged copy of `message` is posted with: the
     * join notice for a member-join system message, otherwise the
     * transformer's output with the other guild's emojis resolved. Shared by
     * the live relay and the history transfer so copies look the same.
     */
    public abstract buildPayload(
        message: RelayMessage,
        guildLink: GuildLink
    ): Promise<WebhookMessageData>;

    /**
     * Posts `payload` through `link`'s webhook on the other platform, into
     * the linked thread when the link targets one. Throws when the webhook
     * cannot be used or the send fails.
     */
    public abstract sendPayload(
        link: ChannelLink,
        payload: WebhookMessageData
    ): Promise<{ messageId: string }>;

    protected getLinkService(): LinkService {
        return this.linkService;
    }

    protected getWebhookService(): WebhookService {
        return this.webhookService;
    }

    protected getMessageTransformer(): MessageTransformer<
        RelayMessage,
        WebhookMessageData
    > {
        return this.messageTransformer;
    }
}
