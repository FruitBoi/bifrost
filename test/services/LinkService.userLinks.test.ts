import { beforeEach, describe, expect, it } from 'vitest';
import { LinkService } from '../../src/services/LinkService';
import { UserLink } from '../../src/db/entities/UserLink';
import {
    CreateUserLinkData,
    UserLinkRepository,
} from '../../src/db/repositories/UserLinkRepository';
import { GuildLinkRepository } from '../../src/db/repositories/GuildLinkRepository';
import { ChannelLinkRepository } from '../../src/db/repositories/ChannelLinkRepository';
import { MessageLinkRepository } from '../../src/db/repositories/MessageLinkRepository';
import { CategoryLinkRepository } from '../../src/db/repositories/CategoryLinkRepository';
import { VoiceLinkRepository } from '../../src/db/repositories/VoiceLinkRepository';

/** In-memory UserLinkRepository with the same uniqueness rules as the table. */
class MemoryUserLinkRepository implements UserLinkRepository {
    rows: UserLink[] = [];
    private seq = 0;

    async create(data: CreateUserLinkData): Promise<UserLink> {
        if (
            this.rows.some(
                (r) =>
                    r.guildLinkId === data.guildLinkId &&
                    (r.discordUserId === data.discordUserId ||
                        r.fluxerUserId === data.fluxerUserId)
            )
        ) {
            throw new Error('unique constraint');
        }
        const row = { id: `ul-${++this.seq}`, ...data, createdAt: new Date() };
        this.rows.push(row);
        return row;
    }
    async findById(id: string) {
        return this.rows.find((r) => r.id === id) ?? null;
    }
    async findByDiscordUser(guildLinkId: string, discordUserId: string) {
        return (
            this.rows.find(
                (r) =>
                    r.guildLinkId === guildLinkId &&
                    r.discordUserId === discordUserId
            ) ?? null
        );
    }
    async findByFluxerUser(guildLinkId: string, fluxerUserId: string) {
        return (
            this.rows.find(
                (r) =>
                    r.guildLinkId === guildLinkId &&
                    r.fluxerUserId === fluxerUserId
            ) ?? null
        );
    }
    async findAllByGuild(guildLinkId: string) {
        return this.rows.filter((r) => r.guildLinkId === guildLinkId);
    }
    async deleteById(id: string) {
        this.rows = this.rows.filter((r) => r.id !== id);
    }
    async deleteByGuildLinkId(guildLinkId: string) {
        this.rows = this.rows.filter((r) => r.guildLinkId !== guildLinkId);
    }
    async getUserLinksCount() {
        return this.rows.length;
    }
}

const unused = () => {
    throw new Error('not used by this test');
};
const stub = <T>() => new Proxy({}, { get: () => unused }) as T;

describe('LinkService user links', () => {
    let users: MemoryUserLinkRepository;
    let service: LinkService;

    beforeEach(() => {
        users = new MemoryUserLinkRepository();
        service = new LinkService(
            stub<GuildLinkRepository>(),
            stub<ChannelLinkRepository>(),
            stub<MessageLinkRepository>(),
            stub<CategoryLinkRepository>(),
            stub<VoiceLinkRepository>(),
            users
        );
    });

    it('creates a mapping and finds it from either side', async () => {
        const result = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });

        expect(result.unchanged).toBe(false);
        expect(result.replaced).toEqual([]);
        expect(result.conflicting).toEqual([]);
        expect(result.link).toMatchObject({
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        expect(
            await service.getUserLinkForDiscordUser('g1', 'd1')
        ).toMatchObject({
            fluxerUserId: 'f1',
        });
        expect(
            await service.getUserLinkForFluxerUser('g1', 'f1')
        ).toMatchObject({
            discordUserId: 'd1',
        });
        expect(await service.getUserLinkForDiscordUser('g2', 'd1')).toBeNull();
        expect(await service.getUserLinksCount()).toBe(1);
    });

    it('reports an identical mapping as unchanged', async () => {
        const first = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        const again = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });

        expect(again.unchanged).toBe(true);
        expect(again.link?.id).toBe(first.link!.id);
        expect(again.replaced).toEqual([]);
        expect(again.conflicting).toEqual([]);
        expect(users.rows).toHaveLength(1);
    });

    it('replaces the old mapping when a Discord user is mapped to another Fluxer user', async () => {
        const old = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        const result = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f2',
        });

        expect(result.unchanged).toBe(false);
        expect(result.replaced.map((r) => r.id)).toEqual([old.link!.id]);
        expect(result.conflicting).toEqual([]);
        expect(await service.getUserLinkForFluxerUser('g1', 'f1')).toBeNull();
        expect(
            await service.getUserLinkForFluxerUser('g1', 'f2')
        ).toMatchObject({
            discordUserId: 'd1',
        });
        expect(users.rows).toHaveLength(1);
    });

    it('replaces both stale rows when the pair crosses two existing mappings', async () => {
        const a = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        const b = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd2',
            fluxerUserId: 'f2',
        });
        const result = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f2',
        });

        expect(result.replaced.map((r) => r.id).sort()).toEqual(
            [a.link!.id, b.link!.id].sort()
        );
        expect(result.conflicting).toEqual([]);
        expect(await service.getUserLinksForGuildLink('g1')).toHaveLength(1);
        expect(await service.getUserLinkForDiscordUser('g1', 'd2')).toBeNull();
        expect(await service.getUserLinkForFluxerUser('g1', 'f1')).toBeNull();
    });

    it('keeps mappings of different guild links apart', async () => {
        await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });
        const other = await service.setUserLink({
            guildLinkId: 'g2',
            discordUserId: 'd1',
            fluxerUserId: 'f9',
        });

        expect(other.replaced).toEqual([]);
        expect(await service.getUserLinksCount()).toBe(2);
    });

    describe('with replaceExisting: false', () => {
        const keep = { replaceExisting: false };

        it('creates the mapping when both accounts are free', async () => {
            const result = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );

            expect(result.link).toMatchObject({
                discordUserId: 'd1',
                fluxerUserId: 'f1',
            });
            expect(result.unchanged).toBe(false);
            expect(result.replaced).toEqual([]);
            expect(result.conflicting).toEqual([]);
            expect(users.rows).toHaveLength(1);
        });

        it('reports an identical mapping as unchanged without re-creating it', async () => {
            const first = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );
            const same = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );

            expect(same.unchanged).toBe(true);
            expect(same.link?.id).toBe(first.link!.id);
            expect(same.replaced).toEqual([]);
            expect(same.conflicting).toEqual([]);
            expect(users.rows).toHaveLength(1);
        });

        it('refuses when the Discord user is already mapped', async () => {
            const first = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );
            const result = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f2' },
                keep
            );

            expect(result.link).toBeNull();
            expect(result.unchanged).toBe(false);
            expect(result.replaced).toEqual([]);
            expect(result.conflicting.map((c) => c.id)).toEqual([
                first.link!.id,
            ]);
            expect(users.rows).toEqual([first.link]);
        });

        it('refuses when the Fluxer user is already mapped', async () => {
            const first = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );
            const result = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd2', fluxerUserId: 'f1' },
                keep
            );

            expect(result.link).toBeNull();
            expect(result.unchanged).toBe(false);
            expect(result.replaced).toEqual([]);
            expect(result.conflicting.map((c) => c.id)).toEqual([
                first.link!.id,
            ]);
            expect(users.rows).toEqual([first.link]);
        });

        it('reports both rows when the pair crosses two existing mappings', async () => {
            const a = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );
            const b = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd2', fluxerUserId: 'f2' },
                keep
            );
            const crossed = await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f2' },
                keep
            );

            expect(crossed.link).toBeNull();
            expect(crossed.replaced).toEqual([]);
            expect(crossed.conflicting.map((c) => c.id).sort()).toEqual(
                [a.link!.id, b.link!.id].sort()
            );
            expect(users.rows.map((r) => r.id).sort()).toEqual(
                [a.link!.id, b.link!.id].sort()
            );
        });

        it('keeps mappings of different guild links apart', async () => {
            await service.setUserLink(
                { guildLinkId: 'g1', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );
            const other = await service.setUserLink(
                { guildLinkId: 'g2', discordUserId: 'd1', fluxerUserId: 'f1' },
                keep
            );

            expect(other.link).toMatchObject({ guildLinkId: 'g2' });
            expect(other.conflicting).toEqual([]);
            expect(await service.getUserLinksCount()).toBe(2);
        });
    });

    it('removes a mapping by id', async () => {
        const { link } = await service.setUserLink({
            guildLinkId: 'g1',
            discordUserId: 'd1',
            fluxerUserId: 'f1',
        });

        expect(await service.removeUserLink(link!.id)).toMatchObject({
            id: link!.id,
        });
        expect(await service.getUserLinkForDiscordUser('g1', 'd1')).toBeNull();
        await expect(service.removeUserLink(link!.id)).rejects.toThrow(
            'User link not found'
        );
    });
});
