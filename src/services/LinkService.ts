import { MessageLinkRepository } from '../db/repositories/MessageLinkRepository';
import {
    ChannelLinkRepository,
    CreateChannelLinkData,
} from '../db/repositories/ChannelLinkRepository';
import { GuildLinkRepository } from '../db/repositories/GuildLinkRepository';
import { CategoryLinkRepository } from '../db/repositories/CategoryLinkRepository';
import { VoiceLinkRepository } from '../db/repositories/VoiceLinkRepository';
import { UserLinkRepository } from '../db/repositories/UserLinkRepository';
import { HistoryMessageRepository } from '../db/repositories/HistoryMessageRepository';
import { ChannelLink } from '../db/entities/ChannelLink';
import { CategoryLink } from '../db/entities/CategoryLink';
import { MessagePlatform } from '../db/entities/MessageLink';
import { VoiceLink } from '../db/entities/VoiceLink';
import { UserLink } from '../db/entities/UserLink';

/**
 * Notified after a voice link is created, enabled/disabled or removed, so the
 * live bridge can react. `link` is null when the link was removed.
 */
export interface VoiceLinkListener {
    onVoiceLinkChanged(voiceLinkId: string, link: VoiceLink | null): void;
}

/** Options for {@link LinkService.setUserLink}. */
export interface SetUserLinkOptions {
    /**
     * When false, an existing mapping of either account blocks the call
     * instead of being replaced. Defaults to true.
     */
    replaceExisting?: boolean;
}

/** Outcome of {@link LinkService.setUserLink}. */
export interface SetUserLinkResult {
    /**
     * The row holding the mapping; null when `replaceExisting: false` and
     * another mapping was in the way.
     */
    link: UserLink | null;
    /** True when this exact mapping already existed and nothing changed. */
    unchanged: boolean;
    /**
     * Rows removed to keep the mapping one-to-one (at most two; only with
     * `replaceExisting`).
     */
    replaced: UserLink[];
    /**
     * Rows that blocked the mapping (only with `replaceExisting: false`; at
     * most two).
     */
    conflicting: UserLink[];
}

export class LinkService {
    constructor(
        private guildRepo: GuildLinkRepository,
        private channelRepo: ChannelLinkRepository,
        private messageRepo: MessageLinkRepository,
        private categoryRepo: CategoryLinkRepository,
        private voiceRepo: VoiceLinkRepository,
        private userRepo: UserLinkRepository
    ) {}

    private voiceLinkListener: VoiceLinkListener | null = null;
    private historyRepo: HistoryMessageRepository | null = null;

    setVoiceLinkListener(listener: VoiceLinkListener | null) {
        this.voiceLinkListener = listener;
    }

    /**
     * Optional: history transfer rows (issue #16) are forgotten together with
     * the link they belong to. SQLite does not enforce the foreign keys here,
     * hence the explicit deletes in removeGuildLink/removeChannelLink.
     */
    setHistoryMessageRepository(repo: HistoryMessageRepository | null) {
        this.historyRepo = repo;
    }

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
        await this.historyRepo?.deleteByGuildLinkId(guildLinkId);
        await this.channelRepo.deleteByGuildLinkId(guildLinkId);
        await this.categoryRepo.deleteByGuildLinkId(guildLinkId);
        const voiceLinks = await this.voiceRepo.findAllByGuild(guildLinkId);
        await this.voiceRepo.deleteByGuildLinkId(guildLinkId);
        await this.userRepo.deleteByGuildLinkId(guildLinkId);
        await this.guildRepo.deleteById(guildLinkId);
        for (const voiceLink of voiceLinks) {
            this.voiceLinkListener?.onVoiceLinkChanged(voiceLink.id, null);
        }
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
            categoryLinkId: data.categoryLinkId ?? null,
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
        await this.historyRepo?.deleteByChannelLinkId(channelLink.id);
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

    /** Links created on behalf of a category link. */
    async getChannelLinksForCategoryLink(categoryLinkId: string) {
        return this.channelRepo.findAllByCategoryLink(categoryLinkId);
    }

    // ---------------------------------------------------------------------
    // Category links (Discord category -> threads in one Fluxer channel)
    // ---------------------------------------------------------------------

    async getCategoryLinkById(id: string) {
        return this.categoryRepo.findById(id);
    }

    async getCategoryLinkByDiscordCategoryId(discordCategoryId: string) {
        return this.categoryRepo.findByDiscordCategoryId(discordCategoryId);
    }

    async getCategoryLinksForFluxerChannel(fluxerChannelId: string) {
        return this.categoryRepo.findAllByFluxerChannelId(fluxerChannelId);
    }

    async getCategoryLinksForGuildLink(guildLinkId: string) {
        return this.categoryRepo.findAllByGuild(guildLinkId);
    }

    /**
     * Persists a category link. Prefer CategorySyncService.createCategoryLink,
     * which validates both sides and bridges the existing channels.
     */
    async createCategoryLink(data: {
        guildLinkId: string;
        discordCategoryId: string;
        fluxerChannelId: string;
    }): Promise<CategoryLink> {
        if (
            await this.categoryRepo.findByDiscordCategoryId(
                data.discordCategoryId
            )
        ) {
            throw new Error('Discord category already linked');
        }
        return this.categoryRepo.create(data);
    }

    /** Removes the mapping row only; the caller decides what happens to its links. */
    async removeCategoryLink(id: string): Promise<CategoryLink> {
        const categoryLink = await this.categoryRepo.findById(id);
        if (!categoryLink) {
            throw new Error('Category link not found');
        }
        await this.categoryRepo.deleteById(id);
        return categoryLink;
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

    /**
     * Records a bridged message pair. `sourcePlatform`/`sourceAuthorId` say
     * which side holds the original message and who wrote it, so replies to
     * the copy can ping the author. Leave `sourceAuthorId` out when the
     * original was posted by a webhook (nobody to ping), and both out when
     * the source is unknown.
     */
    async createMessageLink({
        discordMessageId,
        fluxerMessageId,
        guildLinkId,
        channelLinkId,
        sourcePlatform,
        sourceAuthorId,
    }: {
        discordMessageId: string;
        fluxerMessageId: string;
        guildLinkId: string;
        channelLinkId: string;
        sourcePlatform?: MessagePlatform;
        sourceAuthorId?: string;
    }) {
        return this.messageRepo.createMessageLink(
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId,
            sourcePlatform
                ? { platform: sourcePlatform, authorId: sourceAuthorId ?? null }
                : undefined
        );
    }

    async deleteMessageLink(id: string) {
        return this.messageRepo.deleteMessageLink(id);
    }

    // ---------------------------------------------------------------------
    // Voice links (one row per pair of voice channels, no webhooks)
    // ---------------------------------------------------------------------

    async getVoiceLinkById(id: string) {
        return this.voiceRepo.findById(id);
    }

    async getVoiceLinkForDiscordChannel(discordChannelId: string) {
        return this.voiceRepo.findByDiscordChannelId(discordChannelId);
    }

    async getVoiceLinkForFluxerChannel(fluxerChannelId: string) {
        return this.voiceRepo.findByFluxerChannelId(fluxerChannelId);
    }

    async getVoiceLinksForGuildLink(guildLinkId: string) {
        return this.voiceRepo.findAllByGuild(guildLinkId);
    }

    async getAllVoiceLinks() {
        return this.voiceRepo.findAll();
    }

    async getVoiceLinksCount() {
        return this.voiceRepo.getVoiceLinksCount();
    }

    /**
     * Persists a voice link. Each voice channel can be linked once; callers
     * validate that both IDs really are voice channels of the linked guilds.
     */
    async createVoiceLink(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        enabled?: boolean;
    }): Promise<VoiceLink> {
        if (
            await this.voiceRepo.findByDiscordChannelId(data.discordChannelId)
        ) {
            throw new Error('Discord voice channel already linked');
        }
        if (await this.voiceRepo.findByFluxerChannelId(data.fluxerChannelId)) {
            throw new Error('Fluxer voice channel already linked');
        }
        const link = await this.voiceRepo.create(data);
        this.voiceLinkListener?.onVoiceLinkChanged(link.id, link);
        return link;
    }

    async setVoiceLinkEnabled(
        voiceLinkId: string,
        enabled: boolean
    ): Promise<VoiceLink> {
        const link = await this.voiceRepo.setEnabled(voiceLinkId, enabled);
        if (!link) {
            throw new Error('Voice link not found');
        }
        this.voiceLinkListener?.onVoiceLinkChanged(link.id, link);
        return link;
    }

    async removeVoiceLink(voiceLinkId: string): Promise<VoiceLink> {
        const link = await this.voiceRepo.findById(voiceLinkId);
        if (!link) {
            throw new Error('Voice link not found');
        }
        await this.voiceRepo.deleteById(link.id);
        this.voiceLinkListener?.onVoiceLinkChanged(link.id, null);
        return link;
    }

    // ---------------------------------------------------------------------
    // User links (Discord account <-> Fluxer account, per guild link)
    // ---------------------------------------------------------------------

    async getUserLinkForDiscordUser(
        guildLinkId: string,
        discordUserId: string
    ) {
        return this.userRepo.findByDiscordUser(guildLinkId, discordUserId);
    }

    async getUserLinkForFluxerUser(guildLinkId: string, fluxerUserId: string) {
        return this.userRepo.findByFluxerUser(guildLinkId, fluxerUserId);
    }

    async getUserLinksForGuildLink(guildLinkId: string) {
        return this.userRepo.findAllByGuild(guildLinkId);
    }

    async getUserLinksCount() {
        return this.userRepo.getUserLinksCount();
    }

    /**
     * Maps a Discord user to a Fluxer user inside a guild link. The mapping is
     * one-to-one. When the exact pair is already recorded nothing is written
     * and the row comes back as `unchanged`. Otherwise any existing row for
     * either user is removed first and returned as `replaced`, unless
     * `replaceExisting` is false: then those rows are returned as
     * `conflicting`, `link` is null and nothing changes.
     */
    async setUserLink(
        data: {
            guildLinkId: string;
            discordUserId: string;
            fluxerUserId: string;
        },
        options: SetUserLinkOptions = {}
    ): Promise<SetUserLinkResult> {
        const existing = await this.findUserLinksForPair(data);

        const same = existing.find(
            (row) =>
                row.discordUserId === data.discordUserId &&
                row.fluxerUserId === data.fluxerUserId
        );
        if (same) {
            return {
                link: same,
                unchanged: true,
                replaced: [],
                conflicting: [],
            };
        }

        if (existing.length > 0 && options.replaceExisting === false) {
            return {
                link: null,
                unchanged: false,
                replaced: [],
                conflicting: existing,
            };
        }

        for (const stale of existing) {
            await this.userRepo.deleteById(stale.id);
        }
        const link = await this.userRepo.create(data);
        return { link, unchanged: false, replaced: existing, conflicting: [] };
    }

    /**
     * The rows already holding either account of a pair inside a guild link,
     * de-duplicated by id (both lookups may hit the same row). At most two.
     */
    private async findUserLinksForPair(data: {
        guildLinkId: string;
        discordUserId: string;
        fluxerUserId: string;
    }): Promise<UserLink[]> {
        const [byDiscord, byFluxer] = await Promise.all([
            this.userRepo.findByDiscordUser(
                data.guildLinkId,
                data.discordUserId
            ),
            this.userRepo.findByFluxerUser(data.guildLinkId, data.fluxerUserId),
        ]);
        const rows: UserLink[] = [];
        for (const row of [byDiscord, byFluxer]) {
            if (row && !rows.some((r) => r.id === row.id)) rows.push(row);
        }
        return rows;
    }

    async removeUserLink(userLinkId: string): Promise<UserLink> {
        const link = await this.userRepo.findById(userLinkId);
        if (!link) {
            throw new Error('User link not found');
        }
        await this.userRepo.deleteById(link.id);
        return link;
    }
}
