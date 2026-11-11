import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import logger from '../../src/utils/logging/logger';

vi.mock('../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/utils/fluxerApiGuard', () => ({
    isFluxerApiBlocked: vi.fn(() => false),
    isFluxerApiBlockError: vi.fn(() => false),
    markFluxerApiBlocked: vi.fn(() => 0),
}));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('DiscordEntityResolver.findMembersByUsername', () => {
    function setup(search: ReturnType<typeof vi.fn>) {
        const resolver = new DiscordEntityResolver();
        resolver.setDiscordClient({
            guilds: { fetch: vi.fn(async () => ({ members: { search } })) },
        } as unknown as DiscordClient);
        return resolver;
    }
    const m = (id: string, username: string, bot = false) =>
        [id, { id, user: { username, bot } }] as const;

    it('returns exact case-insensitive matches only, with bot flag', async () => {
        const search = vi.fn(
            async () =>
                new Map([
                    m('1', 'Alice'),
                    m('2', 'alice_two'),
                    m('3', 'ALICE', true),
                ])
        );
        const out = await setup(search).findMembersByUsername('g', 'alice');
        expect(out).toEqual([
            { id: '1', username: 'Alice', bot: false },
            { id: '3', username: 'ALICE', bot: true },
        ]);
        expect(search).toHaveBeenCalledWith({ query: 'alice', limit: 100 });
    });

    it('caches results, including empty ones', async () => {
        const search = vi.fn(async () => new Map());
        const resolver = setup(search);
        expect(await resolver.findMembersByUsername('g', 'Bob')).toEqual([]);
        await resolver.findMembersByUsername('g', 'bob');
        expect(search).toHaveBeenCalledTimes(1);
    });

    it('returns [] and warns on failure', async () => {
        const search = vi.fn(async () => {
            throw new Error('Missing Access');
        });
        const resolver = setup(search);
        expect(await resolver.findMembersByUsername('g', 'bob')).toEqual([]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        await resolver.findMembersByUsername('g', 'bob');
        expect(search).toHaveBeenCalledTimes(1);
    });
});

describe('FluxerEntityResolver.findMembersByUsername', () => {
    const hit = (userId: string, username: string, member: unknown = null) => ({
        id: userId,
        guildId: 'g',
        userId,
        username,
        member,
    });

    function setup(
        search: ReturnType<typeof vi.fn>,
        cache: Map<string, unknown> = new Map()
    ) {
        const resolver = new FluxerEntityResolver();
        const members = Object.assign(cache, { search });
        resolver.setFluxerClient({
            guilds: { fetch: vi.fn(async () => ({ members })) },
        } as unknown as FluxerClient);
        return resolver;
    }

    it('returns exact case-insensitive matches only, with bot flag', async () => {
        const search = vi.fn(async () => ({
            guildId: 'g',
            members: [
                hit('1', 'Alice'),
                hit('2', 'alice2'),
                hit('3', 'ALICE', { user: { bot: true } }),
            ],
        }));
        const out = await setup(search).findMembersByUsername('g', 'alice');
        expect(out).toEqual([
            { id: '1', username: 'Alice', bot: false },
            { id: '3', username: 'ALICE', bot: true },
        ]);
        expect(search).toHaveBeenCalledWith({ query: 'alice', limit: 100 });
    });

    it('caches results', async () => {
        const search = vi.fn(async () => ({ guildId: 'g', members: [] }));
        const resolver = setup(search);
        await resolver.findMembersByUsername('g', 'bob');
        await resolver.findMembersByUsername('g', 'BOB');
        expect(search).toHaveBeenCalledTimes(1);
    });

    it('falls back to cached members when search fails', async () => {
        const search = vi.fn(async () => {
            throw new Error('Missing Permissions');
        });
        const cache = new Map<string, unknown>([
            ['1', { id: '1', user: { username: 'Bob', bot: true } }],
            ['2', { id: '2', user: { username: 'bobby', bot: false } }],
        ]);
        const out = await setup(search, cache).findMembersByUsername(
            'g',
            'bob'
        );
        expect(out).toEqual([{ id: '1', username: 'Bob', bot: true }]);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('returns [] and warns when the guild cannot be fetched', async () => {
        const resolver = new FluxerEntityResolver();
        resolver.setFluxerClient({
            guilds: {
                fetch: vi.fn(async () => {
                    throw new Error('boom');
                }),
            },
        } as unknown as FluxerClient);
        expect(await resolver.findMembersByUsername('g', 'bob')).toEqual([]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});
