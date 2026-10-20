import { vi } from 'vitest';
import { ChannelLink } from '../../src/db/entities/ChannelLink';
import { GuildLink } from '../../src/db/entities/GuildLink';
import { MessageLink } from '../../src/db/entities/MessageLink';
import { LinkService } from '../../src/services/LinkService';
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
        autoSyncThreads: false,
        createdAt: new Date(),
        ...overrides,
    };
}

/**
 * In-memory stand-in for the subset of LinkService used by ThreadSyncService
 * and LinkProvisioner. Everything is synchronous data behind async methods.
 */
export class FakeLinkService {
    links: ChannelLink[] = [];
    messageLinks: MessageLink[] = [];
    guildLinks: GuildLink[] = [guildLink];

    async getGuildLinkById(id: string) {
        return this.guildLinks.find((g) => g.id === id) ?? null;
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
        this.guildLinks = this.guildLinks.filter((g) => g.id !== id);
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
    }[] = [];
    removed: ChannelLink[] = [];
    failCreate: Error | null = null;

    constructor(private readonly links: FakeLinkService) {}

    async createLink(args: {
        guildLink: GuildLink;
        discord: LinkTarget;
        fluxer: LinkTarget;
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
        ...overrides,
    };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
