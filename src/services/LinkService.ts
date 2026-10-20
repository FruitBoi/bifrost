import { MessageLinkRepository } from '../db/repositories/MessageLinkRepository';
import { ChannelLinkRepository } from '../db/repositories/ChannelLinkRepository';
import { GuildLinkRepository } from '../db/repositories/GuildLinkRepository';
import { ThreadLinkRepository } from '../db/repositories/ThreadLinkRepository';
import { ChannelLink } from '../db/entities/ChannelLink';
import { ThreadLink } from '../db/entities/ThreadLink';

/**
 * Where a message lives relative to the bridge: always a channel link, plus a
 * thread link when the message was posted inside a bridged thread.
 */
export interface LinkContext {
    channelLink: ChannelLink;
    threadLink: ThreadLink | null;
}

export class LinkService {
    constructor(
        private guildRepo: GuildLinkRepository,
        private channelRepo: ChannelLinkRepository,
        private messageRepo: MessageLinkRepository,
        private threadRepo: ThreadLinkRepository
    ) {}

    async getGuildLinkById(id: string) {
        return this.guildRepo.findById(id);
    }

    async getGuildLinkForDiscordGuild(discordGuildId: string) {
        return this.guildRepo.findByDiscordGuildId(discordGuildId);
    }

    async getGuildLinkForFluxerGuild(fluxerGuildId: string) {
        return this.guildRepo.findByFluxerGuildId(fluxerGuildId);
    }

    async getAllGuildLinks() {
        return this.guildRepo.findAll();
    }

    async createGuildLink(discordGuildId: string, fluxerGuildId: string) {
        const existingDiscordLink =
            await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (existingDiscordLink) {
            throw new Error('Discord guild already linked');
        }

        const existingFluxerLink =
            await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (existingFluxerLink) {
            throw new Error('Fluxer guild already linked');
        }

        return this.guildRepo.create(discordGuildId, fluxerGuildId);
    }

    private async removeGuildLink(guildLinkId: string) {
        await this.messageRepo.deleteByGuildLinkId(guildLinkId);
        await this.threadRepo.deleteByGuildLinkId(guildLinkId);
        await this.channelRepo.deleteByGuildLinkId(guildLinkId);
        await this.guildRepo.deleteById(guildLinkId);
    }

    async removeGuildLinkFromDiscord(discordGuildId: string) {
        const existingLink =
            await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!existingLink) {
            throw new Error('Guild not linked');
        }

        await this.removeGuildLink(existingLink.id);
    }

    async removeGuildLinkFromFluxer(fluxerGuildId: string) {
        const existingLink =
            await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!existingLink) {
            throw new Error('Guild not linked');
        }

        await this.removeGuildLink(existingLink.id);
    }

    async createChannelLink({
        guildLinkId,
        discordChannelId,
        fluxerChannelId,
        discordWebhookId,
        discordWebhookToken,
        fluxerWebhookId,
        fluxerWebhookToken,
    }: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
    }) {
        const existingDiscordChannelLink =
            await this.channelRepo.findByDiscordChannelId(discordChannelId);
        if (existingDiscordChannelLink) {
            throw new Error('Discord channel already linked');
        }

        const existingFluxerChannelLink =
            await this.channelRepo.findByFluxerChannelId(fluxerChannelId);
        if (existingFluxerChannelLink) {
            throw new Error('Fluxer channel already linked');
        }

        return this.channelRepo.create({
            guildLinkId,
            discordChannelId,
            fluxerChannelId,
            discordWebhookId,
            discordWebhookToken,
            fluxerWebhookId,
            fluxerWebhookToken,
        });
    }

    private async removeChannelLink(channelLink: ChannelLink) {
        await this.messageRepo.deleteByChannelLinkId(channelLink.id);
        await this.threadRepo.deleteByChannelLinkId(channelLink.id);
        await this.channelRepo.deleteById(channelLink.id);
    }

    async removeChannelLinkForDiscord(discordGuildId: string, linkId: string) {
        const guildLink =
            await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        const channelLink = await this.channelRepo.findByGuildAndLinkId(
            guildLink.id,
            linkId
        );

        if (!channelLink) {
            throw new Error('Link not found');
        }

        await this.removeChannelLink(channelLink);

        return channelLink;
    }

    async removeChannelLinkForFluxer(fluxerGuildId: string, linkId: string) {
        const guildLink =
            await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        const channelLink = await this.channelRepo.findByGuildAndLinkId(
            guildLink.id,
            linkId
        );

        if (!channelLink) {
            throw new Error('Link not found');
        }

        await this.removeChannelLink(channelLink);

        return channelLink;
    }

    async setChannelAutoSyncThreads(channelLinkId: string, enabled: boolean) {
        return this.channelRepo.setAutoSyncThreads(channelLinkId, enabled);
    }

    async getChannelLinksForDiscordGuild(discordGuildId: string) {
        const guildLink =
            await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        return this.channelRepo.findAllByGuild(guildLink.id);
    }

    async getChannelLinksForFluxerGuild(fluxerGuildId: string) {
        const guildLink =
            await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        return this.channelRepo.findAllByGuild(guildLink.id);
    }

    async getChannelLinkById(id: string) {
        return this.channelRepo.findById(id);
    }

    async getChannelLinkByDiscordChannelId(discordChannelId: string) {
        return this.channelRepo.findByDiscordChannelId(discordChannelId);
    }

    async getChannelLinkByFluxerChannelId(fluxerChannelId: string) {
        return this.channelRepo.findByFluxerChannelId(fluxerChannelId);
    }

    // ---------------------------------------------------------------------
    // Thread links
    // ---------------------------------------------------------------------

    async getThreadLinkById(id: string) {
        return this.threadRepo.findById(id);
    }

    async getThreadLinkByDiscordThreadId(discordThreadId: string) {
        return this.threadRepo.findByDiscordThreadId(discordThreadId);
    }

    async getThreadLinkByFluxerThreadId(fluxerThreadId: string) {
        return this.threadRepo.findByFluxerThreadId(fluxerThreadId);
    }

    async getThreadLinksForChannelLink(channelLinkId: string) {
        return this.threadRepo.findAllByChannelLink(channelLinkId);
    }

    async getThreadLinksForGuildLink(guildLinkId: string) {
        return this.threadRepo.findAllByGuild(guildLinkId);
    }

    async createThreadLink({
        channelLinkId,
        discordThreadId,
        fluxerThreadId,
    }: {
        channelLinkId: string;
        discordThreadId: string;
        fluxerThreadId: string;
    }) {
        const channelLink = await this.channelRepo.findById(channelLinkId);
        if (!channelLink) {
            throw new Error('Channel link not found');
        }

        const existingDiscord =
            await this.threadRepo.findByDiscordThreadId(discordThreadId);
        if (existingDiscord) {
            throw new Error('Discord thread already linked');
        }

        const existingFluxer =
            await this.threadRepo.findByFluxerThreadId(fluxerThreadId);
        if (existingFluxer) {
            throw new Error('Fluxer thread already linked');
        }

        return this.threadRepo.create({
            guildLinkId: channelLink.guildLinkId,
            channelLinkId: channelLink.id,
            discordThreadId,
            fluxerThreadId,
        });
    }

    async removeThreadLink(threadLinkId: string) {
        const threadLink = await this.threadRepo.findById(threadLinkId);
        if (!threadLink) {
            throw new Error('Thread link not found');
        }

        await this.messageRepo.deleteByThreadLinkId(threadLink.id);
        await this.threadRepo.deleteById(threadLink.id);

        return threadLink;
    }

    /**
     * Resolves the bridge context for a Discord channel ID, which may be a
     * linked channel or a linked thread. Returns null when nothing is bridged.
     */
    async resolveDiscordContext(
        discordChannelId: string
    ): Promise<LinkContext | null> {
        const channelLink =
            await this.channelRepo.findByDiscordChannelId(discordChannelId);
        if (channelLink) return { channelLink, threadLink: null };

        const threadLink =
            await this.threadRepo.findByDiscordThreadId(discordChannelId);
        if (!threadLink) return null;

        const parentLink = await this.channelRepo.findById(
            threadLink.channelLinkId
        );
        if (!parentLink) return null;

        return { channelLink: parentLink, threadLink };
    }

    /**
     * Resolves the bridge context for a Fluxer channel ID, which may be a
     * linked channel or a linked thread. Returns null when nothing is bridged.
     */
    async resolveFluxerContext(
        fluxerChannelId: string
    ): Promise<LinkContext | null> {
        const channelLink =
            await this.channelRepo.findByFluxerChannelId(fluxerChannelId);
        if (channelLink) return { channelLink, threadLink: null };

        const threadLink =
            await this.threadRepo.findByFluxerThreadId(fluxerChannelId);
        if (!threadLink) return null;

        const parentLink = await this.channelRepo.findById(
            threadLink.channelLinkId
        );
        if (!parentLink) return null;

        return { channelLink: parentLink, threadLink };
    }

    /**
     * Resolves the context for an existing message link (channel link plus
     * the thread link if the message is inside a bridged thread).
     */
    async resolveContextForMessageLink(messageLink: {
        channelLinkId: string;
        threadLinkId: string | null;
    }): Promise<LinkContext | null> {
        const channelLink = await this.channelRepo.findById(
            messageLink.channelLinkId
        );
        if (!channelLink) return null;

        if (!messageLink.threadLinkId) {
            return { channelLink, threadLink: null };
        }

        const threadLink = await this.threadRepo.findById(
            messageLink.threadLinkId
        );
        // A message link pointing at a removed thread link is stale: treat the
        // whole message as unbridged rather than posting it into the parent.
        if (!threadLink) return null;

        return { channelLink, threadLink };
    }

    // ---------------------------------------------------------------------
    // Message links
    // ---------------------------------------------------------------------

    async getMessageLinkByDiscordMessageId(discordMessageId: string) {
        return this.messageRepo.getMessageLinkByDiscordMessageId(
            discordMessageId
        );
    }

    async getMessageLinkByFluxerMessageId(fluxerMessageId: string) {
        return this.messageRepo.getMessageLinkByFluxerMessageId(
            fluxerMessageId
        );
    }

    async createMessageLink({
        discordMessageId,
        fluxerMessageId,
        guildLinkId,
        channelLinkId,
        threadLinkId = null,
    }: {
        discordMessageId: string;
        fluxerMessageId: string;
        guildLinkId: string;
        channelLinkId: string;
        threadLinkId?: string | null;
    }) {
        return this.messageRepo.createMessageLink(
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId,
            threadLinkId
        );
    }

    async deleteMessageLink(id: string) {
        return this.messageRepo.deleteMessageLink(id);
    }
}
