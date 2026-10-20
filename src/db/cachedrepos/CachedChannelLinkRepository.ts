import NodeCache from 'node-cache';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../entities/ChannelLink';
import {
    ChannelLinkRepository,
    CreateChannelLinkData,
} from '../repositories/ChannelLinkRepository';

export class CachedChannelLinkRepository implements ChannelLinkRepository {
    private cache: NodeCache;

    constructor(
        private readonly repository: ChannelLinkRepository,
        ttlSeconds: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds });
    }

    private idKey(id: string) {
        return `id:${id}`;
    }

    private discordLocKey(discordLocation: string) {
        return `discordLoc:${discordLocation}`;
    }

    private fluxerLocKey(fluxerLocation: string) {
        return `fluxerLoc:${fluxerLocation}`;
    }

    private guildKey(guildLinkId: string, linkId: string) {
        return `guild:${guildLinkId}:link:${linkId}`;
    }

    private guildAllKey(guildLinkId: string) {
        return `guild:${guildLinkId}:all`;
    }

    private discordChannelAllKey(discordChannelId: string) {
        return `dchan:${discordChannelId}:all`;
    }

    private fluxerChannelAllKey(fluxerChannelId: string) {
        return `fchan:${fluxerChannelId}:all`;
    }

    private countKey() {
        return 'channel_links:count';
    }

    private primeCache(entity: ChannelLink) {
        this.cache.set(this.idKey(entity.id), entity);
        this.cache.set(this.discordLocKey(discordLocationId(entity)), entity);
        this.cache.set(this.fluxerLocKey(fluxerLocationId(entity)), entity);
        this.cache.set(
            this.guildKey(entity.guildLinkId, entity.linkId),
            entity
        );
    }

    private evictEntity(entity: ChannelLink) {
        this.cache.del(this.idKey(entity.id));
        this.cache.del(this.discordLocKey(discordLocationId(entity)));
        this.cache.del(this.fluxerLocKey(fluxerLocationId(entity)));
        this.cache.del(this.guildKey(entity.guildLinkId, entity.linkId));
    }

    private invalidateLists(entity: ChannelLink) {
        this.cache.del(this.guildAllKey(entity.guildLinkId));
        this.cache.del(this.discordChannelAllKey(entity.discordChannelId));
        this.cache.del(this.fluxerChannelAllKey(entity.fluxerChannelId));
        this.cache.del(this.countKey());
    }

    async create(data: CreateChannelLinkData): Promise<ChannelLink> {
        const created = await this.repository.create(data);

        this.primeCache(created);
        this.invalidateLists(created);

        return created;
    }

    async findByGuildAndLinkId(
        guildLinkId: string,
        linkId: string
    ): Promise<ChannelLink | null> {
        const key = this.guildKey(guildLinkId, linkId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByGuildAndLinkId(
            guildLinkId,
            linkId
        );

        if (result) this.primeCache(result);

        return result;
    }

    async findAllByGuild(guildLinkId: string): Promise<ChannelLink[]> {
        const key = this.guildAllKey(guildLinkId);

        const cached = this.cache.get<ChannelLink[]>(key);
        if (cached) return cached;

        const result = await this.repository.findAllByGuild(guildLinkId);

        this.cache.set(key, result);

        return result;
    }

    async findById(id: string): Promise<ChannelLink | null> {
        const key = this.idKey(id);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findById(id);
        if (result) this.primeCache(result);

        return result;
    }

    async findByDiscordLocation(
        locationId: string
    ): Promise<ChannelLink | null> {
        const key = this.discordLocKey(locationId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByDiscordLocation(locationId);
        if (result) this.primeCache(result);

        return result;
    }

    async findByFluxerLocation(
        locationId: string
    ): Promise<ChannelLink | null> {
        const key = this.fluxerLocKey(locationId);

        const cached = this.cache.get<ChannelLink>(key);
        if (cached) return cached;

        const result = await this.repository.findByFluxerLocation(locationId);
        if (result) this.primeCache(result);

        return result;
    }

    async findAllByDiscordChannel(
        discordChannelId: string
    ): Promise<ChannelLink[]> {
        const key = this.discordChannelAllKey(discordChannelId);

        const cached = this.cache.get<ChannelLink[]>(key);
        if (cached) return cached;

        const result =
            await this.repository.findAllByDiscordChannel(discordChannelId);

        this.cache.set(key, result);

        return result;
    }

    async findAllByFluxerChannel(
        fluxerChannelId: string
    ): Promise<ChannelLink[]> {
        const key = this.fluxerChannelAllKey(fluxerChannelId);

        const cached = this.cache.get<ChannelLink[]>(key);
        if (cached) return cached;

        const result =
            await this.repository.findAllByFluxerChannel(fluxerChannelId);

        this.cache.set(key, result);

        return result;
    }

    async countByDiscordWebhookId(discordWebhookId: string): Promise<number> {
        return this.repository.countByDiscordWebhookId(discordWebhookId);
    }

    async countByFluxerWebhookId(fluxerWebhookId: string): Promise<number> {
        return this.repository.countByFluxerWebhookId(fluxerWebhookId);
    }

    async setAutoSyncThreads(
        id: string,
        enabled: boolean
    ): Promise<ChannelLink> {
        const updated = await this.repository.setAutoSyncThreads(id, enabled);

        this.primeCache(updated);
        this.invalidateLists(updated);

        return updated;
    }

    async deleteById(id: string): Promise<void> {
        const existing = await this.repository.findById(id);
        if (!existing) return;

        await this.repository.deleteById(id);

        this.evictEntity(existing);
        this.invalidateLists(existing);
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        const existingLinks = await this.repository.findAllByGuild(guildLinkId);

        await this.repository.deleteByGuildLinkId(guildLinkId);

        existingLinks.forEach((link) => {
            this.evictEntity(link);
            this.invalidateLists(link);
        });
        this.cache.del(this.guildAllKey(guildLinkId));
        this.cache.del(this.countKey());
    }

    async getChannelLinksCount(): Promise<number> {
        const key = this.countKey();

        const cached = this.cache.get<number>(key);
        if (cached !== undefined) return cached;

        const count = await this.repository.getChannelLinksCount();
        this.cache.set(key, count);
        return count;
    }
}
