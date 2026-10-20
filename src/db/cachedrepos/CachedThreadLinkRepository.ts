import NodeCache from 'node-cache';
import { ThreadLink } from '../entities/ThreadLink';
import { ThreadLinkRepository } from '../repositories/ThreadLinkRepository';

export class CachedThreadLinkRepository implements ThreadLinkRepository {
    private cache: NodeCache;

    constructor(
        private readonly repository: ThreadLinkRepository,
        ttlSeconds: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds });
    }

    private idKey(id: string) {
        return `id:${id}`;
    }

    private discordKey(discordThreadId: string) {
        return `discord:${discordThreadId}`;
    }

    private fluxerKey(fluxerThreadId: string) {
        return `fluxer:${fluxerThreadId}`;
    }

    private channelAllKey(channelLinkId: string) {
        return `channel:${channelLinkId}:all`;
    }

    private guildAllKey(guildLinkId: string) {
        return `guild:${guildLinkId}:all`;
    }

    private countKey() {
        return 'thread_links:count';
    }

    private primeCache(entity: ThreadLink) {
        this.cache.set(this.idKey(entity.id), entity);
        this.cache.set(this.discordKey(entity.discordThreadId), entity);
        this.cache.set(this.fluxerKey(entity.fluxerThreadId), entity);
    }

    private evict(entity: ThreadLink) {
        this.cache.del(this.idKey(entity.id));
        this.cache.del(this.discordKey(entity.discordThreadId));
        this.cache.del(this.fluxerKey(entity.fluxerThreadId));
        this.cache.del(this.channelAllKey(entity.channelLinkId));
        this.cache.del(this.guildAllKey(entity.guildLinkId));
        this.cache.del(this.countKey());
    }

    async create(data: {
        guildLinkId: string;
        channelLinkId: string;
        discordThreadId: string;
        fluxerThreadId: string;
    }): Promise<ThreadLink> {
        const created = await this.repository.create(data);
        this.primeCache(created);
        this.cache.del(this.channelAllKey(created.channelLinkId));
        this.cache.del(this.guildAllKey(created.guildLinkId));
        this.cache.del(this.countKey());
        return created;
    }

    async findById(id: string): Promise<ThreadLink | null> {
        const key = this.idKey(id);
        const cached = this.cache.get<ThreadLink>(key);
        if (cached) return cached;

        const result = await this.repository.findById(id);
        if (result) this.primeCache(result);
        return result;
    }

    async findByDiscordThreadId(
        discordThreadId: string
    ): Promise<ThreadLink | null> {
        const key = this.discordKey(discordThreadId);
        const cached = this.cache.get<ThreadLink>(key);
        if (cached) return cached;

        const result =
            await this.repository.findByDiscordThreadId(discordThreadId);
        if (result) this.primeCache(result);
        return result;
    }

    async findByFluxerThreadId(
        fluxerThreadId: string
    ): Promise<ThreadLink | null> {
        const key = this.fluxerKey(fluxerThreadId);
        const cached = this.cache.get<ThreadLink>(key);
        if (cached) return cached;

        const result =
            await this.repository.findByFluxerThreadId(fluxerThreadId);
        if (result) this.primeCache(result);
        return result;
    }

    async findAllByChannelLink(channelLinkId: string): Promise<ThreadLink[]> {
        const key = this.channelAllKey(channelLinkId);
        const cached = this.cache.get<ThreadLink[]>(key);
        if (cached) return cached;

        const result =
            await this.repository.findAllByChannelLink(channelLinkId);
        this.cache.set(key, result);
        return result;
    }

    async findAllByGuild(guildLinkId: string): Promise<ThreadLink[]> {
        const key = this.guildAllKey(guildLinkId);
        const cached = this.cache.get<ThreadLink[]>(key);
        if (cached) return cached;

        const result = await this.repository.findAllByGuild(guildLinkId);
        this.cache.set(key, result);
        return result;
    }

    async deleteById(id: string): Promise<void> {
        const existing = await this.repository.findById(id);
        if (!existing) return;

        await this.repository.deleteById(id);
        this.evict(existing);
    }

    async deleteByChannelLinkId(channelLinkId: string): Promise<void> {
        const existing =
            await this.repository.findAllByChannelLink(channelLinkId);
        await this.repository.deleteByChannelLinkId(channelLinkId);
        existing.forEach((link) => this.evict(link));
        this.cache.del(this.channelAllKey(channelLinkId));
        this.cache.del(this.countKey());
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        const existing = await this.repository.findAllByGuild(guildLinkId);
        await this.repository.deleteByGuildLinkId(guildLinkId);
        existing.forEach((link) => this.evict(link));
        this.cache.del(this.guildAllKey(guildLinkId));
        this.cache.del(this.countKey());
    }

    async getThreadLinksCount(): Promise<number> {
        const key = this.countKey();
        const cached = this.cache.get<number>(key);
        if (cached !== undefined) return cached;

        const count = await this.repository.getThreadLinksCount();
        this.cache.set(key, count);
        return count;
    }
}
