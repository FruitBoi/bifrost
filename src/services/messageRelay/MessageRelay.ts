import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../LinkService';
import MessageTransformer from '../messageTransformer/MessageTransformer';
import { WebhookMessageData, WebhookService } from '../WebhookService';
import MetricsService from '../MetricsService';
import MessageQueueService from '../MessageQueueService';

export default abstract class MessageRelay<RelayMessage> {
    private readonly linkService: LinkService;
    private readonly webhookService: WebhookService;
    private readonly messageTransformer: MessageTransformer<
        RelayMessage,
        WebhookMessageData
    >;
    protected readonly metricsService: MetricsService | null;
    protected readonly queueService: MessageQueueService | null;

    constructor({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
    }: {
        linkService: LinkService;
        webhookService: WebhookService;
        messageTransformer: MessageTransformer<
            RelayMessage,
            WebhookMessageData
        >;
        metricsService?: MetricsService;
        queueService?: MessageQueueService;
    }) {
        this.linkService = linkService;
        this.webhookService = webhookService;
        this.messageTransformer = messageTransformer;
        this.metricsService = metricsService ?? null;
        this.queueService = queueService ?? null;
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
