import { vi } from 'vitest';
import { CategoryLink } from '../../src/db/entities/CategoryLink';
import { ChannelLink } from '../../src/db/entities/ChannelLink';
import { GuildLink } from '../../src/db/entities/GuildLink';
import {
    MessageLink,
    MessagePlatform,
} from '../../src/db/entities/MessageLink';
import { VoiceLink } from '../../src/db/entities/VoiceLink';
import { UserLink } from '../../src/db/entities/UserLink';
import {
    LinkService,
    SetUserLinkResult,
    VoiceLinkListener,
} from '../../src/services/LinkService';
import LinkProvisioner, {
    LinkTarget,
} from '../../src/services/LinkProvisioner';

let counter = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++counter}`;

export const guildLink: GuildLink = {
    id: 'guild-link-1',
    discordGuildId: 'dguild',
    fluxerGuildId: 'fguild',
    createdAt: new Date(),
};

export function makeChannelLink(
    overrides: Partial<ChannelLink> = {}
): ChannelLink {
    return {
        id: nextId('link'),
        guildLinkId: guildLink.id,
        discordChannelId: 'dchan',
        discordThreadId: null,
        fluxerChannelId: 'fchan',
        fluxerThreadId: null,
        discordWebhookId: 'dwh',
        discordWebhookToken: 'dwt',
        fluxerWebhookId: 'fwh',
        fluxerWebhookToken: 'fwt',
        linkId: nextId('lnk'),
        categoryLinkId: null,
        autoSyncThreads: false,
        createdAt: new Date(),
        ...overrides,
    };
}

export function makeCategoryLink(
    overrides: Partial<CategoryLink> = {}
): CategoryLink {
    return {
        id: nextId('catlink'),
        guildLinkId: guildLink.id,
        discordCategoryId: 'dcat',
        fluxerChannelId: 'fhost',
        createdAt: new Date(),
        ...overrides,
    };
}

export function makeUserLink(overrides: Partial<UserLink> = {}): UserLink {
    return {
        id: nextId('userlink'),
        guildLinkId: guildLink.id,
        discordUserId: 'duser',
        fluxerUserId: 'fuser',
        createdAt: new Date(),
        ...overrides,
    };
}

export function makeVoiceLink(overrides: Partial<VoiceLink> = {}): VoiceLink {
    return {
        id: nextId('voicelink'),
        guildLinkId: guildLink.id,
        discordChannelId: 'dvoice',
        fluxerChannelId: 'fvoice',
        enabled: true,
        createdAt: new Date(),
        ...overrides,
    };
}

/**
 * In-memory stand-in for the subset of LinkService used by ThreadSyncService,
 * CategorySyncService, LinkProvisioner and the voice bridge. Everything is
 * synchronous data behind async methods.
 */
export class FakeLinkService {
    links: ChannelLink[] = [];
    messageLinks: MessageLink[] = [];
    guildLinks: GuildLink[] = [guildLink];
    categoryLinks: CategoryLink[] = [];
    voiceLinks: VoiceLink[] = [];
    userLinks: UserLink[] = [];
    voiceLinkListener: VoiceLinkListener | null = null;

    setVoiceLinkListener(listener: VoiceLinkListener | null) {
        this.voiceLinkListener = listener;
    }

    async getGuildLinkById(id: string) {
        return this.guildLinks.find((g) => g.id === id) ?? null;
    }

    async getGuildLinkForDiscordGuild(discordGuildId: string) {
        return (
            this.guildLinks.find((g) => g.discordGuildId === discordGuildId) ??
            null
        );
    }

    async getGuildLinkForFluxerGuild(fluxerGuildId: string) {
        return (
            this.guildLinks.find((g) => g.fluxerGuildId === fluxerGuildId) ??
            null
        );
    }

    async getChannelLinkById(id: string) {
        return this.links.find((l) => l.id === id) ?? null;
    }

    async getChannelLinkByDiscordLocation(id: string) {
        return (
            this.links.find(
                (l) =>
                    l.discordThreadId === id ||
                    (l.discordChannelId === id && l.discordThreadId === null)
            ) ?? null
        );
    }

    async getChannelLinkByFluxerLocation(id: string) {
        return (
            this.links.find(
                (l) =>
                    l.fluxerThreadId === id ||
                    (l.fluxerChannelId === id && l.fluxerThreadId === null)
            ) ?? null
        );
    }

    async getChannelLinksForDiscordChannel(id: string) {
        return this.links.filter((l) => l.discordChannelId === id);
    }

    async getChannelLinksForFluxerChannel(id: string) {
        return this.links.filter((l) => l.fluxerChannelId === id);
    }

    async getChannelLinksForGuildLink(id: string) {
        return this.links.filter((l) => l.guildLinkId === id);
    }

    async getChannelLinksForCategoryLink(categoryLinkId: string) {
        return this.links.filter((l) => l.categoryLinkId === categoryLinkId);
    }

    async countLinksUsingDiscordWebhook(id: string) {
        return this.links.filter((l) => l.discordWebhookId === id).length;
    }

    async countLinksUsingFluxerWebhook(id: string) {
        return this.links.filter((l) => l.fluxerWebhookId === id).length;
    }

    async createChannelLink(data: {
        guildLinkId: string;
        discordChannelId: string;
        discordThreadId?: string | null;
        fluxerChannelId: string;
        fluxerThreadId?: string | null;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
        categoryLinkId?: string | null;
    }) {
        const discordLocation = data.discordThreadId ?? data.discordChannelId;
        const fluxerLocation = data.fluxerThreadId ?? data.fluxerChannelId;
        if (await this.getChannelLinkByDiscordLocation(discordLocation)) {
            throw new Error('Discord location already linked');
        }
        if (await this.getChannelLinkByFluxerLocation(fluxerLocation)) {
            throw new Error('Fluxer location already linked');
        }
        const link = makeChannelLink({
            ...data,
            discordThreadId: data.discordThreadId ?? null,
            fluxerThreadId: data.fluxerThreadId ?? null,
            categoryLinkId: data.categoryLinkId ?? null,
        });
        this.links.push(link);
        return link;
    }

    async removeChannelLink(id: string) {
        const link = await this.getChannelLinkById(id);
        if (!link) throw new Error('Link not found');
        this.links = this.links.filter((l) => l.id !== id);
        this.messageLinks = this.messageLinks.filter(
            (m) => m.channelLinkId !== id
        );
        return link;
    }

    async removeGuildLink(id: string) {
        this.links = this.links.filter((l) => l.guildLinkId !== id);
        this.categoryLinks = this.categoryLinks.filter(
            (c) => c.guildLinkId !== id
        );
        const voiceLinks = this.voiceLinks.filter((v) => v.guildLinkId === id);
        this.voiceLinks = this.voiceLinks.filter((v) => v.guildLinkId !== id);
        for (const voiceLink of voiceLinks) {
            this.voiceLinkListener?.onVoiceLinkChanged(voiceLink.id, null);
        }
        this.userLinks = this.userLinks.filter((u) => u.guildLinkId !== id);
        this.guildLinks = this.guildLinks.filter((g) => g.id !== id);
    }

    // User links

    async getUserLinkForDiscordUser(
        guildLinkId: string,
        discordUserId: string
    ) {
        return (
            this.userLinks.find(
                (u) =>
                    u.guildLinkId === guildLinkId &&
                    u.discordUserId === discordUserId
            ) ?? null
        );
    }

    async getUserLinkForFluxerUser(guildLinkId: string, fluxerUserId: string) {
        return (
            this.userLinks.find(
                (u) =>
                    u.guildLinkId === guildLinkId &&
                    u.fluxerUserId === fluxerUserId
            ) ?? null
        );
    }

    async getUserLinksForGuildLink(guildLinkId: string) {
        return this.userLinks.filter((u) => u.guildLinkId === guildLinkId);
    }

    async setUserLink(data: {
        guildLinkId: string;
        discordUserId: string;
        fluxerUserId: string;
    }): Promise<SetUserLinkResult> {
        // Mirrors LinkService.setUserLink over the in-memory rows.
        const byDiscord = await this.getUserLinkForDiscordUser(
            data.guildLinkId,
            data.discordUserId
        );
        const byFluxer = await this.getUserLinkForFluxerUser(
            data.guildLinkId,
            data.fluxerUserId
        );
        const existing: UserLink[] = [];
        for (const row of [byDiscord, byFluxer]) {
            if (row && !existing.some((r) => r.id === row.id))
                existing.push(row);
        }
        const same = existing.find(
            (row) =>
                row.discordUserId === data.discordUserId &&
                row.fluxerUserId === data.fluxerUserId
        );
        if (same) {
            return { link: same, unchanged: true, replaced: [] };
        }
        this.userLinks = this.userLinks.filter(
            (u) => !existing.some((r) => r.id === u.id)
        );
        const link = makeUserLink(data);
        this.userLinks.push(link);
        return { link, unchanged: false, replaced: existing };
    }

    async removeUserLink(id: string) {
        const link = this.userLinks.find((u) => u.id === id);
        if (!link) throw new Error('User link not found');
        this.userLinks = this.userLinks.filter((u) => u.id !== id);
        return link;
    }

    // Category links

    async getCategoryLinkById(id: string) {
        return this.categoryLinks.find((c) => c.id === id) ?? null;
    }

    async getCategoryLinkByDiscordCategoryId(discordCategoryId: string) {
        return (
            this.categoryLinks.find(
                (c) => c.discordCategoryId === discordCategoryId
            ) ?? null
        );
    }

    async getCategoryLinksForFluxerChannel(fluxerChannelId: string) {
        return this.categoryLinks.filter(
            (c) => c.fluxerChannelId === fluxerChannelId
        );
    }

    async getCategoryLinksForGuildLink(guildLinkId: string) {
        return this.categoryLinks.filter((c) => c.guildLinkId === guildLinkId);
    }

    async createCategoryLink(data: {
        guildLinkId: string;
        discordCategoryId: string;
        fluxerChannelId: string;
    }) {
        if (
            await this.getCategoryLinkByDiscordCategoryId(
                data.discordCategoryId
            )
        ) {
            throw new Error('Discord category already linked');
        }
        const categoryLink = makeCategoryLink(data);
        this.categoryLinks.push(categoryLink);
        return categoryLink;
    }

    async removeCategoryLink(id: string) {
        const categoryLink = await this.getCategoryLinkById(id);
        if (!categoryLink) throw new Error('Category link not found');
        this.categoryLinks = this.categoryLinks.filter((c) => c.id !== id);
        return categoryLink;
    }

    // Voice links

    async getVoiceLinkById(id: string) {
        return this.voiceLinks.find((v) => v.id === id) ?? null;
    }

    async getVoiceLinkForDiscordChannel(discordChannelId: string) {
        return (
            this.voiceLinks.find(
                (v) => v.discordChannelId === discordChannelId
            ) ?? null
        );
    }

    async getVoiceLinkForFluxerChannel(fluxerChannelId: string) {
        return (
            this.voiceLinks.find(
                (v) => v.fluxerChannelId === fluxerChannelId
            ) ?? null
        );
    }

    async getVoiceLinksForGuildLink(guildLinkId: string) {
        return this.voiceLinks.filter((v) => v.guildLinkId === guildLinkId);
    }

    async getAllVoiceLinks() {
        return [...this.voiceLinks];
    }

    async getVoiceLinksCount() {
        return this.voiceLinks.length;
    }

    async createVoiceLink(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        enabled?: boolean;
    }) {
        if (await this.getVoiceLinkForDiscordChannel(data.discordChannelId)) {
            throw new Error('Discord voice channel already linked');
        }
        if (await this.getVoiceLinkForFluxerChannel(data.fluxerChannelId)) {
            throw new Error('Fluxer voice channel already linked');
        }
        const voiceLink = makeVoiceLink({
            ...data,
            enabled: data.enabled ?? true,
        });
        this.voiceLinks.push(voiceLink);
        this.voiceLinkListener?.onVoiceLinkChanged(voiceLink.id, voiceLink);
        return voiceLink;
    }

    async setVoiceLinkEnabled(id: string, enabled: boolean) {
        const voiceLink = await this.getVoiceLinkById(id);
        if (!voiceLink) throw new Error('Voice link not found');
        voiceLink.enabled = enabled;
        this.voiceLinkListener?.onVoiceLinkChanged(voiceLink.id, voiceLink);
        return voiceLink;
    }

    async removeVoiceLink(id: string) {
        const voiceLink = await this.getVoiceLinkById(id);
        if (!voiceLink) throw new Error('Voice link not found');
        this.voiceLinks = this.voiceLinks.filter((v) => v.id !== id);
        this.voiceLinkListener?.onVoiceLinkChanged(voiceLink.id, null);
        return voiceLink;
    }

    async createMessageLink(data: {
        discordMessageId: string;
        fluxerMessageId: string;
        guildLinkId: string;
        channelLinkId: string;
        sourcePlatform?: MessagePlatform;
        sourceAuthorId?: string;
    }) {
        this.messageLinks.push({
            id: `ml-${this.messageLinks.length + 1}`,
            guildLinkId: data.guildLinkId,
            channelLinkId: data.channelLinkId,
            discordMessageId: data.discordMessageId,
            fluxerMessageId: data.fluxerMessageId,
            sourcePlatform: data.sourcePlatform ?? null,
            sourceAuthorId: data.sourceAuthorId ?? null,
            createdAt: new Date(),
        });
    }

    async getMessageLinkByDiscordMessageId(id: string) {
        return this.messageLinks.find((m) => m.discordMessageId === id) ?? null;
    }

    async getMessageLinkByFluxerMessageId(id: string) {
        return this.messageLinks.find((m) => m.fluxerMessageId === id) ?? null;
    }

    asLinkService(): LinkService {
        return this as unknown as LinkService;
    }
}

/** Records provisioner calls and persists links into the fake link service. */
export class FakeLinkProvisioner {
    created: {
        guildLink: GuildLink;
        discord: LinkTarget;
        fluxer: LinkTarget;
        categoryLinkId?: string | null;
    }[] = [];
    removed: ChannelLink[] = [];
    failCreate: Error | null = null;

    constructor(private readonly links: FakeLinkService) {}

    async createLink(args: {
        guildLink: GuildLink;
        discord: LinkTarget;
        fluxer: LinkTarget;
        categoryLinkId?: string | null;
    }) {
        this.created.push(args);
        if (this.failCreate) throw this.failCreate;
        return this.links.createChannelLink({
            guildLinkId: args.guildLink.id,
            discordChannelId: args.discord.channelId,
            discordThreadId: args.discord.threadId,
            fluxerChannelId: args.fluxer.channelId,
            fluxerThreadId: args.fluxer.threadId,
            discordWebhookId: 'dwh',
            discordWebhookToken: 'dwt',
            fluxerWebhookId: 'fwh',
            fluxerWebhookToken: 'fwt',
            categoryLinkId: args.categoryLinkId ?? null,
        });
    }

    async removeLink(link: ChannelLink) {
        this.removed.push(link);
        await this.links.removeChannelLink(link.id);
    }

    asProvisioner(): LinkProvisioner {
        return this as unknown as LinkProvisioner;
    }
}

/** A Discord-looking thread object with spies for the calls the bridge makes. */
export function fakeDiscordThread(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId('dthread'),
        name: 'discord thread',
        parentId: 'dchan',
        ownerId: 'user-1',
        guildId: 'dguild',
        autoArchiveDuration: 1440,
        join: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

/** A Fluxer-looking thread object with spies for the calls the bridge makes. */
export function fakeFluxerThread(overrides: Record<string, unknown> = {}) {
    return {
        id: nextId('fthread'),
        name: 'fluxer thread',
        parentId: 'fchan',
        ownerId: 'user-2',
        guildId: 'fguild',
        autoArchiveDuration: 1440,
        join: vi.fn().mockResolvedValue(undefined),
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
