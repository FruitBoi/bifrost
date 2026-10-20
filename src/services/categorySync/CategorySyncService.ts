import {
    CategoryChannel,
    ChannelType,
    Client as DiscordClient,
    DMChannel,
    NonThreadGuildBasedChannel,
    TextChannel as DiscordTextChannel,
} from 'discord.js';
import { Client as FluxerClient } from '@fluxerjs/core';
import { BotConfig, DEFAULT_BOT_CONFIG } from '../../config/BotConfig';
import { CategoryLink } from '../../db/entities/CategoryLink';
import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import LinkProvisioner from '../LinkProvisioner';
import { LinkService } from '../LinkService';
import ThreadSyncService from '../threadSync/ThreadSyncService';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';

export interface CategorySyncItem {
    channelId: string;
    channelName: string;
    /** Fluxer thread id, for linked items. */
    threadId?: string;
    /** Why the channel was skipped or failed. */
    reason?: string;
}

export interface CategorySyncResult {
    linked: CategorySyncItem[];
    skipped: CategorySyncItem[];
    failed: CategorySyncItem[];
}

export interface CategoryPreview {
    discordCategoryId: string;
    discordCategoryName: string;
    fluxerChannelId: string;
    fluxerChannelName: string;
    /** Text channels in the category and whether each is already bridged somewhere. */
    channels: { id: string; name: string; alreadyLinked: boolean }[];
}

/**
 * Bridges every text channel of a Discord category to a thread inside one
 * Fluxer channel, and keeps that mapping current as channels are created,
 * moved, renamed or deleted.
 *
 * Each bridged channel is an ordinary channel↔thread {@link ChannelLink}
 * tagged with the category link's id, so messages, edits and deletes flow
 * through the normal relay. Channel renames are mirrored to the thread
 * (`categories.mirrorChannelRenames`); thread renames are not mirrored back,
 * because Discord normalises channel names (lower-case, hyphens) and the echo
 * would rename the thread again. Moving a channel out of its category drops
 * the link when `categories.unlinkWhenChannelLeaves` is on (the default);
 * otherwise the link survives the move. Both switches come from the
 * {@link BotConfig} passed to {@link setBotConfig}.
 */
export default class CategorySyncService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;
    private botConfig: BotConfig = DEFAULT_BOT_CONFIG;

    /** De-duplicates concurrent bridging of the same Discord channel. */
    private readonly inFlight = new Map<string, Promise<CategorySyncItem>>();

    constructor(
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {}

    /** Kept for symmetry with the other services; Discord access goes through the resolver. */
    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    /** Applies the startup config; a copy is kept so later mutation has no effect. */
    setBotConfig(config: BotConfig): void {
        this.botConfig = structuredClone(config);
    }

    private ensureFluxerClient(): FluxerClient {
        void this.discordClient;
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in CategorySyncService');
        }
        return this.fluxerClient;
    }

    // ---------------------------------------------------------------------
    // Validation / preview
    // ---------------------------------------------------------------------

    private async fetchCategory(
        discordGuildId: string,
        discordCategoryId: string
    ): Promise<CategoryChannel> {
        const channel = await this.discordEntityResolver.fetchChannel(
            discordGuildId,
            discordCategoryId
        );
        if (!channel || channel.type !== ChannelType.GuildCategory) {
            throw new Error('Discord category not found');
        }
        return channel;
    }

    private textChannelsOf(category: CategoryChannel): DiscordTextChannel[] {
        return [...category.children.cache.values()]
            .filter(
                (c): c is DiscordTextChannel => c.type === ChannelType.GuildText
            )
            .sort((a, b) => a.position - b.position);
    }

    /**
     * Validates both sides and lists the channels that would be bridged.
     * Throws with a user-facing message when the category or Fluxer channel
     * is invalid or the category is already linked.
     */
    async preview(
        guildLink: GuildLink,
        discordCategoryId: string,
        fluxerChannelId: string
    ): Promise<CategoryPreview> {
        if (
            await this.linkService.getCategoryLinkByDiscordCategoryId(
                discordCategoryId
            )
        ) {
            throw new Error('Discord category already linked');
        }

        const category = await this.fetchCategory(
            guildLink.discordGuildId,
            discordCategoryId
        );
        const fluxerChannel = await this.fluxerEntityResolver.fetchChannel(
            guildLink.fluxerGuildId,
            fluxerChannelId
        );
        if (!fluxerChannel || !fluxerChannel.isText()) {
            throw new Error('Fluxer channel not found or not a text channel');
        }

        const channels = [];
        for (const channel of this.textChannelsOf(category)) {
            channels.push({
                id: channel.id,
                name: channel.name,
                alreadyLinked:
                    (await this.linkService.getChannelLinkByDiscordLocation(
                        channel.id
                    )) !== null,
            });
        }

        return {
            discordCategoryId,
            discordCategoryName: category.name,
            fluxerChannelId,
            fluxerChannelName: fluxerChannel.name ?? fluxerChannelId,
            channels,
        };
    }

    // ---------------------------------------------------------------------
    // Create / sync / remove
    // ---------------------------------------------------------------------

    /** Validates, persists the mapping and bridges the category's channels. */
    async createCategoryLink(
        guildLink: GuildLink,
        discordCategoryId: string,
        fluxerChannelId: string
    ): Promise<{ categoryLink: CategoryLink; result: CategorySyncResult }> {
        await this.preview(guildLink, discordCategoryId, fluxerChannelId);

        const categoryLink = await this.linkService.createCategoryLink({
            guildLinkId: guildLink.id,
            discordCategoryId,
            fluxerChannelId,
        });
        const result = await this.syncCategory(categoryLink);
        logger.info(
            `📁 Category link ${categoryLink.id}: bridged ${result.linked.length} channel(s), skipped ${result.skipped.length}, failed ${result.failed.length}`
        );
        return { categoryLink, result };
    }

    /** Bridges every not-yet-linked text channel of the category. */
    async syncCategory(
        categoryLink: CategoryLink
    ): Promise<CategorySyncResult> {
        const guildLink = await this.linkService.getGuildLinkById(
            categoryLink.guildLinkId
        );
        if (!guildLink) {
            throw new Error('Guild link not found');
        }
        const category = await this.fetchCategory(
            guildLink.discordGuildId,
            categoryLink.discordCategoryId
        );

        const result: CategorySyncResult = {
            linked: [],
            skipped: [],
            failed: [],
        };
        for (const channel of this.textChannelsOf(category)) {
            const item = await this.bridgeChannel(channel, categoryLink);
            if (item.threadId) result.linked.push(item);
            else if (item.reason === 'already linked')
                result.skipped.push(item);
            else result.failed.push(item);
        }
        return result;
    }

    /**
     * Creates a Fluxer thread for one Discord channel and links them.
     * Returns an item with `threadId` on success, otherwise with `reason`.
     */
    private bridgeChannel(
        channel: DiscordTextChannel,
        categoryLink: CategoryLink
    ): Promise<CategorySyncItem> {
        const existing = this.inFlight.get(channel.id);
        if (existing) return existing;

        const promise = this.doBridgeChannel(channel, categoryLink).finally(
            () => this.inFlight.delete(channel.id)
        );
        this.inFlight.set(channel.id, promise);
        return promise;
    }

    private async doBridgeChannel(
        channel: DiscordTextChannel,
        categoryLink: CategoryLink
    ): Promise<CategorySyncItem> {
        const base = { channelId: channel.id, channelName: channel.name };

        if (
            await this.linkService.getChannelLinkByDiscordLocation(channel.id)
        ) {
            return { ...base, reason: 'already linked' };
        }

        const guildLink = await this.linkService.getGuildLinkById(
            categoryLink.guildLinkId
        );
        if (!guildLink) return { ...base, reason: 'guild link not found' };

        try {
            const fluxerChannel =
                await this.ensureFluxerClient().channels.fetch(
                    categoryLink.fluxerChannelId
                );
            if (!fluxerChannel.isText()) {
                return {
                    ...base,
                    reason: 'Fluxer channel does not support threads',
                };
            }
            const thread = await fluxerChannel.threads.create({
                name: ThreadSyncService.normalizeThreadName(channel.name),
                reason: `Bridged from Discord channel #${channel.name}`,
            });
            await thread.join().catch(() => undefined);

            const link = await this.linkProvisioner.createLink({
                guildLink,
                discord: { channelId: channel.id, threadId: null },
                fluxer: {
                    channelId: categoryLink.fluxerChannelId,
                    threadId: thread.id,
                },
                categoryLinkId: categoryLink.id,
            });
            logger.info(
                `📁 Category link ${categoryLink.id}: bridged #${channel.name} (${channel.id}) ↔ Fluxer thread ${thread.id} (link ${link.linkId})`
            );
            return { ...base, threadId: thread.id };
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.error(
                `❌ Category link ${categoryLink.id}: failed to bridge #${channel.name} (${channel.id}):`,
                err
            );
            return { ...base, reason: (err as Error).message };
        }
    }

    /**
     * Removes the mapping and every link it created. Fluxer threads are left
     * in place.
     */
    async removeCategoryLink(
        categoryLink: CategoryLink
    ): Promise<{ removedLinks: number }> {
        const links = await this.linkService.getChannelLinksForCategoryLink(
            categoryLink.id
        );
        let removedLinks = 0;
        for (const link of links) {
            try {
                await this.linkProvisioner.removeLink(link);
                removedLinks++;
            } catch (err) {
                logger.error(
                    `❌ Category link ${categoryLink.id}: failed to remove link ${link.linkId}:`,
                    err
                );
            }
        }
        await this.linkService.removeCategoryLink(categoryLink.id);
        return { removedLinks };
    }

    // ---------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------

    private isText(
        channel: NonThreadGuildBasedChannel | DMChannel
    ): channel is DiscordTextChannel {
        return channel.type === ChannelType.GuildText;
    }

    /** A text channel created inside a linked category gets a thread. */
    async handleDiscordChannelCreate(
        channel: NonThreadGuildBasedChannel
    ): Promise<void> {
        if (!this.isText(channel) || !channel.parentId) return;
        const categoryLink =
            await this.linkService.getCategoryLinkByDiscordCategoryId(
                channel.parentId
            );
        if (!categoryLink) return;
        await this.bridgeChannel(channel, categoryLink);
    }

    /**
     * Moving a text channel into a linked category bridges it; moving a
     * category-bridged channel out drops its link (the thread stays) when
     * `categories.unlinkWhenChannelLeaves` is on; renaming a category-bridged
     * channel renames its thread when `categories.mirrorChannelRenames` is on.
     */
    async handleDiscordChannelUpdate(
        oldChannel: NonThreadGuildBasedChannel | DMChannel,
        newChannel: NonThreadGuildBasedChannel | DMChannel
    ): Promise<void> {
        if (!this.isText(newChannel)) return;
        const oldParentId = this.isText(oldChannel)
            ? oldChannel.parentId
            : null;
        const oldName = this.isText(oldChannel) ? oldChannel.name : null;

        if (oldParentId !== newChannel.parentId) {
            const link = await this.linkService.getChannelLinkByDiscordLocation(
                newChannel.id
            );
            if (
                this.botConfig.categories.unlinkWhenChannelLeaves &&
                link?.categoryLinkId
            ) {
                const previous = await this.linkService.getCategoryLinkById(
                    link.categoryLinkId
                );
                if (
                    previous &&
                    previous.discordCategoryId !== newChannel.parentId
                ) {
                    await this.linkProvisioner
                        .removeLink(link)
                        .catch((err) =>
                            logger.error(
                                '❌ Failed to remove link after channel left its category:',
                                err
                            )
                        );
                }
            }
            if (newChannel.parentId) {
                const target =
                    await this.linkService.getCategoryLinkByDiscordCategoryId(
                        newChannel.parentId
                    );
                if (target) await this.bridgeChannel(newChannel, target);
            }
            return;
        }

        if (
            this.botConfig.categories.mirrorChannelRenames &&
            oldName !== null &&
            oldName !== newChannel.name
        ) {
            await this.mirrorChannelRename(newChannel);
        }
    }

    private async mirrorChannelRename(channel: DiscordTextChannel) {
        const link = await this.linkService.getChannelLinkByDiscordLocation(
            channel.id
        );
        if (!link?.categoryLinkId || !link.fluxerThreadId) return;

        const thread = await this.fluxerEntityResolver.fetchThread(
            link.fluxerThreadId
        );
        if (!thread) return;
        const name = ThreadSyncService.normalizeThreadName(channel.name);
        if (thread.name === name) return;
        try {
            await thread.edit({ name });
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.error(
                `❌ Failed to rename Fluxer thread ${link.fluxerThreadId} after channel rename:`,
                err
            );
        }
    }

    /**
     * A deleted category drops its mapping (links keep working on their
     * own). A deleted linked channel drops its link. Used for every Discord
     * channel deletion, not only category members.
     */
    async handleDiscordChannelDelete(
        channel: NonThreadGuildBasedChannel | DMChannel
    ): Promise<void> {
        if (channel.type === ChannelType.GuildCategory) {
            const categoryLink =
                await this.linkService.getCategoryLinkByDiscordCategoryId(
                    channel.id
                );
            if (categoryLink) {
                await this.linkService.removeCategoryLink(categoryLink.id);
                logger.info(
                    `📁 Discord category ${channel.id} deleted; category link removed (its links were kept).`
                );
            }
            return;
        }
        const link = await this.linkService.getChannelLinkByDiscordLocation(
            channel.id
        );
        if (!link || link.discordThreadId) return;
        await this.linkProvisioner
            .removeLink(link)
            .catch((err) =>
                logger.error(
                    '❌ Failed to remove link after Discord channel deletion:',
                    err
                )
            );
        logger.info(`🔗 Discord channel ${channel.id} deleted; link removed.`);
    }

    /**
     * A deleted Fluxer channel drops its own link and every category link
     * targeting it (their threads died with the channel).
     */
    async handleFluxerChannelDelete(channelId: string): Promise<void> {
        const link =
            await this.linkService.getChannelLinkByFluxerLocation(channelId);
        if (link && !link.fluxerThreadId) {
            await this.linkProvisioner
                .removeLink(link)
                .catch((err) =>
                    logger.error(
                        '❌ Failed to remove link after Fluxer channel deletion:',
                        err
                    )
                );
        }
        const categoryLinks =
            await this.linkService.getCategoryLinksForFluxerChannel(channelId);
        for (const categoryLink of categoryLinks) {
            await this.removeCategoryLink(categoryLink).catch((err) =>
                logger.error(
                    '❌ Failed to remove category link after Fluxer channel deletion:',
                    err
                )
            );
        }
    }

    /** Convenience for callers that only hold ids. */
    async getChannelLinksForCategory(
        categoryLink: CategoryLink
    ): Promise<ChannelLink[]> {
        return this.linkService.getChannelLinksForCategoryLink(categoryLink.id);
    }
}
