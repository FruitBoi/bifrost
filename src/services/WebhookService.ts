import {
    Client as FluxerClient,
    TextChannel as FluxerTextChannel,
    Webhook as FluxerWebhook,
    MessageAttachmentFlags,
    Routes as FluxerRoutes,
} from '@fluxerjs/core';
import {
    AttachmentBuilder,
    Client as DiscordClient,
    TextChannel as DiscordTextChannel,
    WebhookClient,
} from 'discord.js';
import logger from '../utils/logging/logger';
import { sanitizeDiscordWebhookUsername } from '../utils/sanitizeDiscordWebhookUsername';
import {
    appendAttachmentLinks,
    DISCORD_DEFAULT_UPLOAD_LIMIT,
    discordUploadLimitForTier,
    splitOversizedAttachments,
} from './discordUploadLimit';
import WebhookEmbed from './WebhookEmbed';

type DiscordWebhook = WebhookClient;

export type WebhookAttachment = {
    url: string;
    name: string;
    spoiler?: boolean;
    /** File size in bytes, when known; used to keep uploads within Discord's limit. */
    size?: number;
};

export type WebhookMessageData = {
    content: string;
    username: string;
    avatarURL: string;
    attachments?: WebhookAttachment[];
    embeds?: WebhookEmbed[];
    /**
     * User ids that the relayed message must really ping. Content already
     * carries the matching `<@id>` mentions; this whitelists them for the
     * webhook so the platform notifies those users.
     */
    mentionUserIds?: string[];
    /**
     * Role ids that the relayed message must really ping. Content already
     * carries the matching `<@&id>` mentions; this whitelists them for the
     * webhook so the platform notifies the role's members. Only honoured on
     * send: an edit keeps the markup but never pings the role again.
     */
    mentionRoleIds?: string[];
    /**
     * Whether the relayed message must really ping `@everyone` / `@here`.
     * Content already carries the literal `@everyone` / `@here`; this adds
     * `everyone` to the webhook's parsed mentions. Only set when the original
     * itself pinged everyone, which both platforms allow only to authors
     * with Mention Everyone (issue #36). Only honoured on send.
     */
    mentionEveryone?: boolean;
    /**
     * When set, nothing in the message pings anyone: allowed mentions are
     * emptied for users and roles, overriding mentionUserIds/mentionRoleIds.
     * Used for history transfers.
     */
    suppressMentions?: boolean;
};

type AllowedMentions = {
    parse: 'everyone'[];
    users: string[];
    roles?: string[];
};

/**
 * Allowed-mentions whitelist for `mentionUserIds` / `mentionRoleIds` (the
 * same shape serves Discord's `allowedMentions` and Fluxer's
 * `allowed_mentions`), or undefined to keep the platform defaults when there
 * is nothing to ping. `parse` only ever holds `everyone`, and only when
 * `mentionEveryone` is set, so a bridged message never opts in to blanket
 * user or role pings; `roles` is only present when a role is actually
 * whitelisted. Edits whitelist no roles and no @everyone so that re-relaying
 * an edited message cannot ping them a second time. With `suppressMentions`
 * the whitelist is empty, so nobody is pinged at all.
 */
function allowedMentionsFor(
    data: WebhookMessageData,
    isEdit = false
): AllowedMentions | undefined {
    if (data.suppressMentions) return { parse: [], users: [] };
    const users = data.mentionUserIds ?? [];
    const roles = isEdit ? [] : (data.mentionRoleIds ?? []);
    const everyone = !isEdit && data.mentionEveryone === true;
    if (users.length === 0 && roles.length === 0 && !everyone) return undefined;
    return {
        parse: everyone ? ['everyone'] : [],
        users,
        ...(roles.length > 0 ? { roles } : {}),
    };
}

/** Appends `key=value` to a route that may or may not already carry a query string. */
function appendQuery(route: string, key: string, value: string): string {
    const separator = route.includes('?') ? '&' : '?';
    return `${route}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

export class WebhookService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;
    /** Guild of each fetched Discord webhook, to look up its upload limit. */
    private discordWebhookGuildIds = new Map<string, string>();

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    async createDiscordWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            if (!channel || !(channel instanceof DiscordTextChannel)) {
                throw new Error('Invalid Discord channel');
            }

            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
            logger.error('❌ Error creating Discord webhook:', error);
            throw error;
        }
    }

    async getDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<DiscordWebhook | null> {
        if (!this.discordClient) {
            throw new Error('Discord client not set in WebhookService');
        }

        try {
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            if (!webhook) return null;
            if (webhook.guildId) {
                this.discordWebhookGuildIds.set(webhookId, webhook.guildId);
            }
            const webhookClient = new WebhookClient({
                id: webhookId,
                token: webhookToken,
            });
            return webhookClient;
        } catch (error: unknown) {
            logger.error(
                '❌ Error getting or creating Discord webhook:',
                error
            );
            throw error;
        }
    }

    /**
     * Upload limit in bytes for a Discord webhook, from the boost tier of its
     * guild; the 10 MiB default when the guild is unknown or not cached.
     */
    private discordUploadLimitFor(webhook: DiscordWebhook): number {
        const webhookId = (webhook as { id?: string }).id;
        const guildId = webhookId
            ? this.discordWebhookGuildIds.get(webhookId)
            : undefined;
        const guild = guildId
            ? this.discordClient?.guilds.cache.get(guildId)
            : undefined;
        return guild
            ? discordUploadLimitForTier(guild.premiumTier)
            : DISCORD_DEFAULT_UPLOAD_LIMIT;
    }

    /**
     * Builds the files to upload with a Discord webhook message. Attachments
     * that would push the request over the upload limit are not uploaded;
     * their URLs are appended to the content instead so Discord embeds them.
     */
    private prepareDiscordFiles(
        webhook: DiscordWebhook,
        data: WebhookMessageData
    ): { content: string; files: AttachmentBuilder[] | undefined } {
        if (!data.attachments)
            return { content: data.content, files: undefined };

        const limit = this.discordUploadLimitFor(webhook);
        const { upload, linked } = splitOversizedAttachments(
            data.attachments,
            limit
        );
        if (linked.length > 0) {
            logger.info(
                `🔗 Linking ${linked.length} attachment(s) over Discord's ${limit}-byte upload limit instead of uploading: ${linked.map((att) => att.name).join(', ')}`
            );
        }

        const files = upload.map((att) => {
            const attBuilder = new AttachmentBuilder(att.url, {
                name: att.name,
            });
            if (att.spoiler) attBuilder.setSpoiler(true);
            return attBuilder;
        });
        return { content: appendAttachmentLinks(data.content, linked), files };
    }

    /**
     * Sends a message through a Discord webhook. When `threadId` is given the
     * message is posted into that thread of the webhook's channel.
     */
    async sendMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        data: WebhookMessageData,
        threadId?: string | null
    ): Promise<{ messageId: string }> {
        try {
            const { content, files } = this.prepareDiscordFiles(webhook, data);

            const { id } = await webhook.send({
                content,
                username: sanitizeDiscordWebhookUsername(data.username),
                avatarURL: data.avatarURL,
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
                threadId: threadId ?? undefined,
                allowedMentions: allowedMentionsFor(data),
            });

            return { messageId: id };
        } catch (error: unknown) {
            logger.error(
                '❌ Error sending message via Discord webhook:',
                error
            );
            throw error;
        }
    }

    async editMessageViaDiscordWebhook(
        webhook: DiscordWebhook,
        messageId: string,
        data: WebhookMessageData,
        threadId?: string | null
    ): Promise<void> {
        try {
            const { content, files } = this.prepareDiscordFiles(webhook, data);

            await webhook.editMessage(messageId, {
                content,
                files,
                embeds:
                    data.embeds?.map((embed) => embed.toDiscordEmbed()) || [],
                threadId: threadId ?? undefined,
                allowedMentions: allowedMentionsFor(data, true),
            });
        } catch (error: unknown) {
            logger.error(
                '❌ Error editing message via Discord webhook:',
                error
            );
            throw error;
        }
    }

    async createFluxerWebhook(
        channelId: string,
        name: string
    ): Promise<{ id: string; token: string }> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const channel = (await this.fluxerClient.channels.fetch(
                channelId
            )) as FluxerTextChannel;
            const webhook = await channel.createWebhook({ name });
            return { id: webhook.id, token: webhook.token! };
        } catch (error: unknown) {
            logger.error('❌ Error creating Fluxer webhook:', error);
            throw error;
        }
    }

    async deleteDiscordWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.discordClient) return;
        try {
            const webhook = await this.discordClient.fetchWebhook(
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('❌ Error deleting Discord webhook:', error);
            throw error;
        }
    }

    async deleteFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<void> {
        if (!this.fluxerClient) return;
        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            await webhook.delete();
        } catch (error) {
            logger.error('❌ Error deleting Fluxer webhook:', error);
            throw error;
        }
    }

    async getFluxerWebhook(
        webhookId: string,
        webhookToken: string
    ): Promise<FluxerWebhook> {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in WebhookService');
        }

        try {
            const webhook = FluxerWebhook.fromToken(
                this.fluxerClient,
                webhookId,
                webhookToken
            );
            return webhook;
        } catch (error: unknown) {
            logger.error('❌ Error getting or creating Fluxer webhook:', error);
            throw error;
        }
    }

    /**
     * `Webhook.send` in @fluxerjs/core builds the execute route internally and
     * offers no thread option, but the Fluxer API accepts `?thread_id=` on
     * execute exactly like Discord. This returns a webhook bound to a client
     * whose REST `post` transparently appends that query parameter, so the
     * SDK's payload/multipart handling is reused untouched.
     */
    private fluxerWebhookTargetingThread(
        webhook: FluxerWebhook,
        threadId: string
    ): FluxerWebhook {
        const client = webhook.client;
        const realRest = client.rest;

        const rest = new Proxy(realRest, {
            get(target, prop) {
                if (prop === 'post') {
                    return (route: string, options?: unknown) =>
                        target.post(
                            appendQuery(route, 'thread_id', threadId),
                            options as never
                        );
                }
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });

        const proxiedClient = new Proxy(client, {
            get(target, prop) {
                if (prop === 'rest') return rest;
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });

        return FluxerWebhook.fromToken(
            proxiedClient as FluxerClient,
            webhook.id,
            webhook.token!
        );
    }

    /**
     * Sends a message through a Fluxer webhook. When `threadId` is given the
     * message is posted into that thread of the webhook's channel.
     */
    async sendMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        data: WebhookMessageData,
        threadId?: string | null
    ): Promise<{ messageId: string }> {
        try {
            const target = threadId
                ? this.fluxerWebhookTargetingThread(webhook, threadId)
                : webhook;

            const msg = await target.send(
                {
                    content: data.content,
                    username: data.username,
                    avatarUrl: data.avatarURL,
                    files:
                        data.attachments?.map((attachment) => ({
                            url: attachment.url,
                            name: attachment.name,
                            filename: attachment.name,
                        })) || [],
                    attachments:
                        data.attachments?.map((attachment, index) => ({
                            id: index,
                            name: attachment.name,
                            filename: attachment.name,
                            flags: attachment.spoiler
                                ? MessageAttachmentFlags.IS_SPOILER
                                : undefined,
                        })) || [],
                    embeds:
                        data.embeds?.map((embed) => embed.toFluxerEmbed()) ||
                        [],
                    allowedMentions: allowedMentionsFor(data),
                },
                true
            );

            if (!msg) {
                throw new Error(
                    'Did not receive message object after sending via Fluxer webhook'
                );
            }

            return { messageId: msg.id };
        } catch (error: unknown) {
            logger.error('❌ Error sending message via Fluxer webhook:', error);
            throw error;
        }
    }

    async editMessageViaFluxerWebhook(
        webhook: FluxerWebhook,
        messageId: string,
        data: WebhookMessageData,
        threadId?: string | null
    ): Promise<void> {
        try {
            let route =
                FluxerRoutes.webhookExecute(webhook.id, webhook.token!) +
                `/messages/${messageId}`;
            if (threadId) route = appendQuery(route, 'thread_id', threadId);
            const allowedMentions = allowedMentionsFor(data, true);

            await webhook.client.rest.patch(route, {
                body: {
                    content: data.content,
                    attachments:
                        data.attachments?.map((attachment, index) => ({
                            id: index,
                            name: attachment.name,
                            filename: attachment.name,
                            flags: attachment.spoiler
                                ? MessageAttachmentFlags.IS_SPOILER
                                : undefined,
                        })) || [],
                    embeds:
                        data.embeds?.map((embed) => embed.toFluxerEmbed()) ||
                        [],
                    ...(allowedMentions
                        ? { allowed_mentions: allowedMentions }
                        : {}),
                },
                auth: false,
            });
        } catch (error: unknown) {
            logger.error('❌ Error editing message via Fluxer webhook:', error);
            throw error;
        }
    }
}
