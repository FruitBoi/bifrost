import { MessageLinkRepository } from '../db/repositories/MessageLinkRepository';
import {
    ChannelLinkRepository,
    CreateChannelLinkData,
} from '../db/repositories/ChannelLinkRepository';
import { GuildLinkRepository } from '../db/repositories/GuildLinkRepository';
import { ChannelLink } from '../db/entities/ChannelLink';

export class LinkService {
    constructor(
        private guildRepo: GuildLinkRepository,
        private channelRepo: ChannelLinkRepository,
        private messageRepo: MessageLinkRepository
    ) {}

    // ---------------------------------------------------------------------
    // Guild links
    // ---------------------------------------------------------------------

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

    /**
     * Removes a guild link and every channel/thread/message link under it.
     * Webhook cleanup is the caller's job (see LinkProvisioner.removeGuildLink).
     */
    async removeGuildLink(guildLinkId: string) {
        await this.messageRepo.deleteByGuildLinkId(guildLinkId);
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

    // ---------------------------------------------------------------------
    // Channel / thread links (one row per pair of locations)
    // ---------------------------------------------------------------------

    /**
     * Persists a link. Prefer LinkProvisioner.createLink, which also takes
     * care of webhooks; this only validates location uniqueness.
     */
    async createChannelLink(data: CreateChannelLinkData) {
        const discordLocation = data.discordThreadId ?? data.discordChannelId;
        const fluxerLocation = data.fluxerThreadId ?? data.fluxerChannelId;

        if (await this.channelRepo.findByDiscordLocation(discordLocation)) {
            throw new Error(
                data.discordThreadId
                    ? 'Discord thread already linked'
                    : 'Discord channel already linked'
            );
        }
        if (await this.channelRepo.findByFluxerLocation(fluxerLocation)) {
            throw new Error(
                data.fluxerThreadId
                    ? 'Fluxer thread already linked'
                    : 'Fluxer channel already linked'
            );
        }

        return this.channelRepo.create({
            ...data,
            discordThreadId: data.discordThreadId ?? null,
            fluxerThreadId: data.fluxerThreadId ?? null,
        });
    }

    /**
     * Removes a link row and its message links. Webhook cleanup is the
     * caller's job (see LinkProvisioner.removeLink).
     */
    async removeChannelLink(channelLinkId: string): Promise<ChannelLink> {
        const channelLink = await this.channelRepo.findById(channelLinkId);
        if (!channelLink) {
            throw new Error('Link not found');
        }
        await this.messageRepo.deleteByChannelLinkId(channelLink.id);
        await this.channelRepo.deleteById(channelLink.id);
        return channelLink;
    }

    async setChannelAutoSyncThreads(channelLinkId: string, enabled: boolean) {
        return this.channelRepo.setAutoSyncThreads(channelLinkId, enabled);
    }

    async getChannelLinksForGuildLink(guildLinkId: string) {
        return this.channelRepo.findAllByGuild(guildLinkId);
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

    async getChannelLinkByGuildAndLinkId(guildLinkId: string, linkId: string) {
        return this.channelRepo.findByGuildAndLinkId(guildLinkId, linkId);
    }

    /** The link whose Discord side is exactly this channel or thread ID. */
    async getChannelLinkByDiscordLocation(locationId: string) {
        return this.channelRepo.findByDiscordLocation(locationId);
    }

    /** The link whose Fluxer side is exactly this channel or thread ID. */
    async getChannelLinkByFluxerLocation(locationId: string) {
        return this.channelRepo.findByFluxerLocation(locationId);
    }

    /** Channel row plus thread rows whose Discord parent is this channel. */
    async getChannelLinksForDiscordChannel(discordChannelId: string) {
        return this.channelRepo.findAllByDiscordChannel(discordChannelId);
    }

    /** Channel row plus thread rows whose Fluxer parent is this channel. */
    async getChannelLinksForFluxerChannel(fluxerChannelId: string) {
        return this.channelRepo.findAllByFluxerChannel(fluxerChannelId);
    }

    async countLinksUsingDiscordWebhook(discordWebhookId: string) {
        return this.channelRepo.countByDiscordWebhookId(discordWebhookId);
    }

    async countLinksUsingFluxerWebhook(fluxerWebhookId: string) {
        return this.channelRepo.countByFluxerWebhookId(fluxerWebhookId);
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
    }: {
        discordMessageId: string;
        fluxerMessageId: string;
        guildLinkId: string;
        channelLinkId: string;
    }) {
        return this.messageRepo.createMessageLink(
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId
        );
    }

    async deleteMessageLink(id: string) {
        return this.messageRepo.deleteMessageLink(id);
    }
}
