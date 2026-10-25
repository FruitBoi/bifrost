import { Op } from 'sequelize';
import { QueuedMessageModel } from '../db/models/QueuedMessageModel';
import WebhookEmbed from './WebhookEmbed';
import { LinkService } from './LinkService';
import {
    WebhookAttachment,
    WebhookMessageData,
    WebhookService,
} from './WebhookService';
import logger from '../utils/logging/logger';
import type MessageCountService from './messageCount/MessageCountService';
import type { MessagePlatform } from '../db/entities/MessageLink';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../utils/fluxerApiGuard';

export type SerializableEmbed = ReturnType<WebhookEmbed['toPlainObject']>;

export type SerializableWebhookMessageData = {
    content: string;
    username: string;
    avatarURL: string;
    attachments?: WebhookAttachment[];
    embeds?: SerializableEmbed[];
    mentionUserIds?: string[];
    /**
     * Author of the original message on the source platform (implied by the
     * entry's direction), so the link created on drain can be ping-resolved.
     * Absent when the original was posted by a webhook or the entry predates
     * author tracking.
     */
    sourceAuthorId?: string;
    /**
     * Set for member-join notices, which are not chat messages and are left
     * out of the bridged message counts when the entry is delivered.
     */
    uncounted?: true;
};

export function toSerializable(
    data: WebhookMessageData,
    sourceAuthorId?: string,
    { uncounted = false }: { uncounted?: boolean } = {}
): SerializableWebhookMessageData {
    return {
        ...data,
        embeds: data.embeds?.map((e) => e.toPlainObject()),
        ...(sourceAuthorId ? { sourceAuthorId } : {}),
        ...(uncounted ? { uncounted: true as const } : {}),
    };
}

function toWebhookMessageData(
    data: SerializableWebhookMessageData
): WebhookMessageData {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
        sourceAuthorId: _sourceAuthorId,
        uncounted: _uncounted,
        ...rest
    } = data;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return {
        ...rest,
        embeds: data.embeds?.map((e) => WebhookEmbed.fromPlainObject(e)),
    };
}

export default class MessageQueueService {
    private drainInterval: ReturnType<typeof setInterval> | null = null;

    private messageCountService: MessageCountService | null = null;

    constructor(private readonly ttlMs: number) {}

    /**
     * Counts each queued message once it is finally delivered (issue #46);
     * the live relay does not count messages it only queued.
     */
    setMessageCountService(service: MessageCountService | null): void {
        this.messageCountService = service;
    }

    async enqueue(
        direction: 'discord_to_fluxer' | 'fluxer_to_discord',
        channelLinkId: string,
        sourceMessageId: string,
        payload: SerializableWebhookMessageData
    ): Promise<void> {
        await QueuedMessageModel.create({
            direction,
            channelLinkId,
            sourceMessageId,
            payload: JSON.stringify(payload),
        });
        logger.debug(
            `📬 Queued message for retry: direction=${direction} sourceMessageId=${sourceMessageId}`
        );
    }

    async drain(
        webhookService: WebhookService,
        linkService: LinkService
    ): Promise<void> {
        const expiryCutoff = new Date(Date.now() - this.ttlMs);

        const expired = await QueuedMessageModel.destroy({
            where: { createdAt: { [Op.lt]: expiryCutoff } },
        });
        if (expired > 0) {
            logger.info(
                `📬 Message queue: discarded ${expired} expired entr${expired === 1 ? 'y' : 'ies'} (TTL exceeded)`
            );
        }

        const pending = await QueuedMessageModel.findAll();
        if (pending.length === 0) return;

        logger.info(
            `📬 Message queue: attempting to drain ${pending.length} pending entr${pending.length === 1 ? 'y' : 'ies'}`
        );

        for (const entry of pending) {
            if (
                entry.direction === 'discord_to_fluxer' &&
                isFluxerApiBlocked()
            ) {
                continue;
            }

            try {
                const serialized = JSON.parse(
                    entry.payload
                ) as SerializableWebhookMessageData;
                const payload = toWebhookMessageData(serialized);
                const sourceAuthorId = serialized.sourceAuthorId;
                const channelLink = await linkService.getChannelLinkById(
                    entry.channelLinkId
                );
                if (!channelLink) {
                    logger.warn(
                        `⚠️ Queue drain: channel link ${entry.channelLinkId} no longer exists, discarding entry`
                    );
                    await entry.destroy();
                    continue;
                }

                if (entry.direction === 'discord_to_fluxer') {
                    const webhook = await webhookService.getFluxerWebhook(
                        channelLink.fluxerWebhookId,
                        channelLink.fluxerWebhookToken
                    );
                    const { messageId: fluxerMessageId } =
                        await webhookService.sendMessageViaFluxerWebhook(
                            webhook,
                            payload,
                            channelLink.fluxerThreadId
                        );
                    if (!serialized.uncounted)
                        this.countDelivered(channelLink.guildLinkId, 'discord');
                    await linkService.createMessageLink({
                        discordMessageId: entry.sourceMessageId,
                        fluxerMessageId,
                        guildLinkId: channelLink.guildLinkId,
                        channelLinkId: channelLink.id,
                        sourcePlatform: 'discord',
                        sourceAuthorId,
                    });
                } else {
                    const webhook = await webhookService.getDiscordWebhook(
                        channelLink.discordWebhookId,
                        channelLink.discordWebhookToken
                    );
                    if (!webhook) {
                        throw new Error(
                            `Discord webhook not found for channel link ${channelLink.id}`
                        );
                    }
                    const { messageId: discordMessageId } =
                        await webhookService.sendMessageViaDiscordWebhook(
                            webhook,
                            payload,
                            channelLink.discordThreadId
                        );
                    if (!serialized.uncounted)
                        this.countDelivered(channelLink.guildLinkId, 'fluxer');
                    await linkService.createMessageLink({
                        discordMessageId,
                        fluxerMessageId: entry.sourceMessageId,
                        guildLinkId: channelLink.guildLinkId,
                        channelLinkId: channelLink.id,
                        sourcePlatform: 'fluxer',
                        sourceAuthorId,
                    });
                }

                await entry.destroy();
                logger.info(
                    `📬 Queue drain: relayed queued message ${entry.id} (${entry.direction})`
                );
            } catch (err) {
                if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
                await entry.update({
                    retryCount: entry.retryCount + 1,
                    lastError: String(err),
                });
                logger.warn(
                    `⚠️ Queue drain: retry failed for entry ${entry.id} (attempt ${entry.retryCount + 1}): ${err}`
                );
            }
        }
    }

    /**
     * Fire and forget: the message was already delivered, so a counting
     * failure must never reach drain's retry path (that would re-send it).
     */
    private countDelivered(guildLinkId: string, source: MessagePlatform): void {
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

    startDrainInterval(
        webhookService: WebhookService,
        linkService: LinkService,
        intervalMs = 30_000
    ): void {
        this.drainInterval = setInterval(() => {
            this.drain(webhookService, linkService).catch((err) =>
                logger.error('❌ Queue drain interval error:', err)
            );
        }, intervalMs);
    }

    stopDrainInterval(): void {
        if (this.drainInterval) {
            clearInterval(this.drainInterval);
            this.drainInterval = null;
        }
    }
}
