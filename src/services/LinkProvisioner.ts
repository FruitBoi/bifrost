import { ChannelType as DiscordChannelType } from 'discord.js';
import { ChannelLink } from '../db/entities/ChannelLink';
import { GuildLink } from '../db/entities/GuildLink';
import { VoiceLink } from '../db/entities/VoiceLink';
import DiscordEntityResolver from './entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from './entityResolver/FluxerEntityResolver';
import { LinkService } from './LinkService';
import { WebhookService } from './WebhookService';
import logger from '../utils/logging/logger';

/** One side of a link: a text channel, or a thread inside one. */
export interface LinkTarget {
    /** Webhook-owning channel; for a thread, its parent. */
    channelId: string;
    /** Set when the target is a thread. */
    threadId: string | null;
}

/** A resolved, validated target plus display info. */
export interface ResolvedLinkTarget extends LinkTarget {
    kind: 'channel' | 'thread';
    name: string;
    /** Parent channel name when `kind === 'thread'`. */
    parentName: string | null;
}

/** A resolved voice channel on either platform. */
export interface ResolvedVoiceTarget {
    id: string;
    name: string;
}

/**
 * Creates and removes links including their webhooks.
 *
 * Webhooks live on channels, never on threads, so every link posts through
 * a webhook on its (parent) channel. A channel and all thread links under it
 * share one webhook per platform; it is created with the first link that
 * needs it and deleted with the last one.
 */
export default class LinkProvisioner {
    constructor(
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {}

    // ---------------------------------------------------------------------
    // Target resolution
    // ---------------------------------------------------------------------

    /**
     * Resolves a Discord channel or thread ID inside the given guild. Returns
     * null when the ID is neither a text channel nor a thread of one in that
     * guild.
     */
    async resolveDiscordTarget(
        discordGuildId: string,
        id: string
    ): Promise<ResolvedLinkTarget | null> {
        const thread = await this.discordEntityResolver.fetchThread(id);
        if (thread) {
            if (thread.guildId !== discordGuildId || !thread.parentId) {
                return null;
            }
            const parent = thread.parent;
            if (parent && parent.type !== DiscordChannelType.GuildText) {
                return null;
            }
            return {
                kind: 'thread',
                channelId: thread.parentId,
                threadId: thread.id,
                name: thread.name,
                parentName: parent?.name ?? null,
            };
        }

        const channel = await this.discordEntityResolver.fetchChannel(
            discordGuildId,
            id
        );
        if (!channel || channel.type !== DiscordChannelType.GuildText) {
            return null;
        }
        return {
            kind: 'channel',
            channelId: channel.id,
            threadId: null,
            name: channel.name,
            parentName: null,
        };
    }

    /** Mirror of {@link resolveDiscordTarget} for Fluxer. */
    async resolveFluxerTarget(
        fluxerGuildId: string,
        id: string
    ): Promise<ResolvedLinkTarget | null> {
        const thread = await this.fluxerEntityResolver.fetchThread(id);
        if (thread) {
            if (thread.guildId !== fluxerGuildId || !thread.parentId) {
                return null;
            }
            const parent = await this.fluxerEntityResolver.fetchChannel(
                fluxerGuildId,
                thread.parentId
            );
            if (!parent || !parent.isText()) return null;
            return {
                kind: 'thread',
                channelId: thread.parentId,
                threadId: thread.id,
                name: thread.name ?? thread.id,
                parentName: parent.name ?? null,
            };
        }

        const channel = await this.fluxerEntityResolver.fetchChannel(
            fluxerGuildId,
            id
        );
        if (!channel || !channel.isText()) return null;
        return {
            kind: 'channel',
            channelId: channel.id,
            threadId: null,
            name: channel.name ?? channel.id,
            parentName: null,
        };
    }

    // ---------------------------------------------------------------------
    // Create / remove
    // ---------------------------------------------------------------------

    /**
     * Links two targets. Fails if either location is already linked. Webhooks
     * are reused from existing links on the same channel, or created.
     */
    async createLink({
        guildLink,
        discord,
        fluxer,
        categoryLinkId = null,
    }: {
        guildLink: GuildLink;
        discord: LinkTarget;
        fluxer: LinkTarget;
        /** Set when the link is created on behalf of a category link. */
        categoryLinkId?: string | null;
    }): Promise<ChannelLink> {
        const discordLocation = discord.threadId ?? discord.channelId;
        const fluxerLocation = fluxer.threadId ?? fluxer.channelId;

        if (
            await this.linkService.getChannelLinkByDiscordLocation(
                discordLocation
            )
        ) {
            throw new Error(
                discord.threadId
                    ? 'Discord thread already linked'
                    : 'Discord channel already linked'
            );
        }
        if (
            await this.linkService.getChannelLinkByFluxerLocation(
                fluxerLocation
            )
        ) {
            throw new Error(
                fluxer.threadId
                    ? 'Fluxer thread already linked'
                    : 'Fluxer channel already linked'
            );
        }

        const discordWebhook = await this.discordWebhookFor(discord.channelId);
        let fluxerWebhook: { id: string; token: string; created: boolean };
        try {
            fluxerWebhook = await this.fluxerWebhookFor(fluxer.channelId);
        } catch (err) {
            await this.discardIfCreated('discord', discordWebhook);
            throw err;
        }

        try {
            return await this.linkService.createChannelLink({
                guildLinkId: guildLink.id,
                discordChannelId: discord.channelId,
                discordThreadId: discord.threadId,
                fluxerChannelId: fluxer.channelId,
                fluxerThreadId: fluxer.threadId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
                categoryLinkId,
            });
        } catch (err) {
            await this.discardIfCreated('discord', discordWebhook);
            await this.discardIfCreated('fluxer', fluxerWebhook);
            throw err;
        }
    }

    /** Removes a link and deletes its webhooks if no other link uses them. */
    async removeLink(link: ChannelLink): Promise<void> {
        await this.linkService.removeChannelLink(link.id);
        await this.deleteWebhooksIfUnused(link);
    }

    /** Removes a guild link with everything under it, deleting all webhooks. */
    async removeGuildLink(guildLink: GuildLink): Promise<void> {
        const links = await this.linkService.getChannelLinksForGuildLink(
            guildLink.id
        );
        await this.linkService.removeGuildLink(guildLink.id);

        const discordWebhooks = new Map<string, string>();
        const fluxerWebhooks = new Map<string, string>();
        for (const link of links) {
            discordWebhooks.set(
                link.discordWebhookId,
                link.discordWebhookToken
            );
            fluxerWebhooks.set(link.fluxerWebhookId, link.fluxerWebhookToken);
        }
        for (const [id, token] of discordWebhooks) {
            await this.webhookService
                .deleteDiscordWebhook(id, token)
                .catch((err) =>
                    logger.error(
                        'Failed to delete Discord webhook during guild unlink:',
                        err
                    )
                );
        }
        for (const [id, token] of fluxerWebhooks) {
            await this.webhookService
                .deleteFluxerWebhook(id, token)
                .catch((err) =>
                    logger.error(
                        'Failed to delete Fluxer webhook during guild unlink:',
                        err
                    )
                );
        }
    }

    // ---------------------------------------------------------------------
    // Webhook sharing
    // ---------------------------------------------------------------------

    private async discordWebhookFor(
        channelId: string
    ): Promise<{ id: string; token: string; created: boolean }> {
        const existing =
            await this.linkService.getChannelLinksForDiscordChannel(channelId);
        if (existing.length > 0) {
            return {
                id: existing[0].discordWebhookId,
                token: existing[0].discordWebhookToken,
                created: false,
            };
        }
        const webhook = await this.webhookService.createDiscordWebhook(
            channelId,
            `Fluxer Bridge Webhook for channel ${channelId}`
        );
        return { ...webhook, created: true };
    }

    private async fluxerWebhookFor(
        channelId: string
    ): Promise<{ id: string; token: string; created: boolean }> {
        const existing =
            await this.linkService.getChannelLinksForFluxerChannel(channelId);
        if (existing.length > 0) {
            return {
                id: existing[0].fluxerWebhookId,
                token: existing[0].fluxerWebhookToken,
                created: false,
            };
        }
        const webhook = await this.webhookService.createFluxerWebhook(
            channelId,
            `Discord Bridge Webhook for channel ${channelId}`
        );
        return { ...webhook, created: true };
    }

    private async discardIfCreated(
        platform: 'discord' | 'fluxer',
        webhook: { id: string; token: string; created: boolean }
    ): Promise<void> {
        if (!webhook.created) return;
        const remove =
            platform === 'discord'
                ? this.webhookService.deleteDiscordWebhook(
                      webhook.id,
                      webhook.token
                  )
                : this.webhookService.deleteFluxerWebhook(
                      webhook.id,
                      webhook.token
                  );
        await remove.catch((err) =>
            logger.error(
                `Failed to clean up ${platform} webhook after link failure:`,
                err
            )
        );
    }

    private async deleteWebhooksIfUnused(link: ChannelLink): Promise<void> {
        if (
            (await this.linkService.countLinksUsingDiscordWebhook(
                link.discordWebhookId
            )) === 0
        ) {
            await this.webhookService
                .deleteDiscordWebhook(
                    link.discordWebhookId,
                    link.discordWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Discord webhook:', err)
                );
        }
        if (
            (await this.linkService.countLinksUsingFluxerWebhook(
                link.fluxerWebhookId
            )) === 0
        ) {
            await this.webhookService
                .deleteFluxerWebhook(
                    link.fluxerWebhookId,
                    link.fluxerWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Fluxer webhook:', err)
                );
        }
    }

    // ---------------------------------------------------------------------
    // Voice links (one Discord voice channel <-> one Fluxer voice channel)
    // ---------------------------------------------------------------------

    /**
     * Resolves a Discord voice channel ID inside the given guild. Returns
     * null when the ID is not a voice channel of that guild.
     */
    async resolveDiscordVoiceTarget(
        discordGuildId: string,
        id: string
    ): Promise<ResolvedVoiceTarget | null> {
        const channel = await this.discordEntityResolver.fetchVoiceChannel(
            discordGuildId,
            id
        );
        if (!channel) return null;
        return { id: channel.id, name: channel.name };
    }

    /** Mirror of {@link resolveDiscordVoiceTarget} for Fluxer. */
    async resolveFluxerVoiceTarget(
        fluxerGuildId: string,
        id: string
    ): Promise<ResolvedVoiceTarget | null> {
        const channel = await this.fluxerEntityResolver.fetchVoiceChannel(
            fluxerGuildId,
            id
        );
        if (!channel) return null;
        return { id: channel.id, name: channel.name ?? channel.id };
    }

    /**
     * Links two voice channels. Both must be voice channels of the linked
     * guilds, and each voice channel can be linked only once. Voice links
     * have no webhooks, so nothing is provisioned besides the row.
     */
    async createVoiceLink(
        guildLink: GuildLink,
        discordChannelId: string,
        fluxerChannelId: string
    ): Promise<VoiceLink> {
        const discord = await this.resolveDiscordVoiceTarget(
            guildLink.discordGuildId,
            discordChannelId
        );
        if (!discord) {
            throw new Error(
                `Discord channel ${discordChannelId} is not a voice channel of the linked server`
            );
        }
        const fluxer = await this.resolveFluxerVoiceTarget(
            guildLink.fluxerGuildId,
            fluxerChannelId
        );
        if (!fluxer) {
            throw new Error(
                `Fluxer channel ${fluxerChannelId} is not a voice channel of the linked server`
            );
        }

        if (await this.linkService.getVoiceLinkForDiscordChannel(discord.id)) {
            throw new Error('Discord voice channel already linked');
        }
        if (await this.linkService.getVoiceLinkForFluxerChannel(fluxer.id)) {
            throw new Error('Fluxer voice channel already linked');
        }

        return this.linkService.createVoiceLink({
            guildLinkId: guildLink.id,
            discordChannelId: discord.id,
            fluxerChannelId: fluxer.id,
        });
    }

    /** Removes a voice link; there are no webhooks to clean up. */
    async removeVoiceLink(voiceLinkId: string): Promise<VoiceLink> {
        return this.linkService.removeVoiceLink(voiceLinkId);
    }
}
