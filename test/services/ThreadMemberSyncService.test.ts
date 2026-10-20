import { describe, expect, it, vi } from 'vitest';
import { RESTJSONErrorCodes } from 'discord.js';
import ThreadMemberSyncService from '../../src/services/threadMemberSync/ThreadMemberSyncService';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import {
    FakeLinkService,
    fakeDiscordThread,
    fakeFluxerThread,
    guildLink,
    makeChannelLink,
} from '../helpers/fakes';

const DISCORD_USER = 'duser';
const FLUXER_USER = 'fuser';

type DiscordThreadFake = ReturnType<typeof fakeDiscordThread> & {
    members: { fetch: ReturnType<typeof vi.fn> };
};
type FluxerThreadFake = ReturnType<typeof fakeFluxerThread> & {
    members: {
        fetchOne: ReturnType<typeof vi.fn>;
        add: ReturnType<typeof vi.fn>;
    };
};

/** What discord.js throws when the user is not in the thread. */
function unknownMemberError(): Error {
    const err = new Error('Unknown Member') as Error & { code: number };
    err.code = RESTJSONErrorCodes.UnknownMember;
    return err;
}

function discordThread(
    id: string,
    opts: { member?: boolean; fetchError?: Error; name?: string } = {}
): DiscordThreadFake {
    const { member = true, fetchError, name } = opts;
    const fetch = vi.fn(async (userId: string) => {
        if (fetchError) throw fetchError;
        if (!member) throw unknownMemberError();
        return { id: userId };
    });
    return fakeDiscordThread({
        id,
        members: { fetch },
        ...(name !== undefined ? { name } : {}),
    }) as DiscordThreadFake;
}

function fluxerThread(
    id: string,
    opts: { member?: boolean; addError?: Error; name?: string } = {}
): FluxerThreadFake {
    const { member = false, addError, name } = opts;
    const fetchOne = vi.fn(async (userId: string) => {
        if (!member) throw new Error('Unknown member');
        return { id: userId };
    });
    const add = vi.fn(async () => {
        if (addError) throw addError;
    });
    return fakeFluxerThread({
        id,
        members: { fetchOne, add },
        ...(name !== undefined ? { name } : {}),
    }) as FluxerThreadFake;
}

function setup() {
    const links = new FakeLinkService();
    const discordThreads = new Map<string, DiscordThreadFake>();
    const fluxerThreads = new Map<string, FluxerThreadFake>();

    const discordResolver = {
        fetchThread: vi.fn(
            async (id: string) => discordThreads.get(id) ?? null
        ),
    };
    const fluxerResolver = {
        fetchThread: vi.fn(async (id: string) => fluxerThreads.get(id) ?? null),
    };

    const service = new ThreadMemberSyncService(
        links.asLinkService(),
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );

    /** Registers a bridged thread pair; either side may be omitted (missing). */
    const pair = (
        n: number,
        sides: {
            discord?: DiscordThreadFake | null;
            fluxer?: FluxerThreadFake | null;
        } = {}
    ) => {
        const discordThreadId = `dt-${n}`;
        const fluxerThreadId = `ft-${n}`;
        const discord =
            sides.discord === undefined
                ? discordThread(discordThreadId)
                : sides.discord;
        const fluxer =
            sides.fluxer === undefined
                ? fluxerThread(fluxerThreadId)
                : sides.fluxer;
        if (discord) discordThreads.set(discordThreadId, discord);
        if (fluxer) fluxerThreads.set(fluxerThreadId, fluxer);
        const link = makeChannelLink({ discordThreadId, fluxerThreadId });
        links.links.push(link);
        return { link, discord, fluxer, discordThreadId, fluxerThreadId };
    };

    const sync = () =>
        service.addFluxerUserToDiscordUsersThreads({
            guildLinkId: guildLink.id,
            discordUserId: DISCORD_USER,
            fluxerUserId: FLUXER_USER,
        });

    return {
        service,
        links,
        discordResolver,
        fluxerResolver,
        pair,
        sync,
    };
}

describe('ThreadMemberSyncService.addFluxerUserToDiscordUsersThreads', () => {
    it('returns an empty result when the guild has no bridged threads', async () => {
        const t = setup();

        const result = await t.sync();

        expect(result).toEqual({
            examined: 0,
            added: [],
            already: [],
            failed: [],
            unchecked: [],
        });
        expect(t.discordResolver.fetchThread).not.toHaveBeenCalled();
        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
    });

    it('only examines links where both sides are threads', async () => {
        const t = setup();
        // channel↔channel
        t.links.links.push(makeChannelLink());
        // channel↔thread and thread↔channel
        t.links.links.push(makeChannelLink({ fluxerThreadId: 'ft-only' }));
        t.links.links.push(makeChannelLink({ discordThreadId: 'dt-only' }));
        // a thread pair from a different guild link
        t.links.links.push(
            makeChannelLink({
                guildLinkId: 'other-guild-link',
                discordThreadId: 'dt-other',
                fluxerThreadId: 'ft-other',
            })
        );
        const p = t.pair(1);

        const result = await t.sync();

        expect(result.examined).toBe(1);
        expect(t.discordResolver.fetchThread).toHaveBeenCalledTimes(1);
        expect(t.discordResolver.fetchThread).toHaveBeenCalledWith(
            p.discordThreadId
        );
        expect(result.added).toHaveLength(1);
    });

    it('adds the Fluxer user when they are in the Discord thread but not the Fluxer one', async () => {
        const t = setup();
        const p = t.pair(1, {
            discord: discordThread('dt-1', { member: true }),
            fluxer: fluxerThread('ft-1', { member: false, name: 'ft name' }),
        });

        const result = await t.sync();

        expect(p.discord!.members.fetch).toHaveBeenCalledWith(DISCORD_USER);
        expect(t.fluxerResolver.fetchThread).toHaveBeenCalledWith(
            p.fluxerThreadId
        );
        expect(p.fluxer!.members.fetchOne).toHaveBeenCalledWith(FLUXER_USER);
        expect(p.fluxer!.members.add).toHaveBeenCalledTimes(1);
        expect(p.fluxer!.members.add).toHaveBeenCalledWith(FLUXER_USER);

        expect(result.examined).toBe(1);
        expect(result.added).toEqual([
            {
                discordThreadId: 'dt-1',
                fluxerThreadId: 'ft-1',
                name: 'ft name',
            },
        ]);
        expect(result.already).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(result.unchecked).toEqual([]);
    });

    it('reports "already" and does not add when the Fluxer user is in the thread', async () => {
        const t = setup();
        const p = t.pair(1, {
            fluxer: fluxerThread('ft-1', { member: true }),
        });

        const result = await t.sync();

        expect(p.fluxer!.members.fetchOne).toHaveBeenCalledWith(FLUXER_USER);
        expect(p.fluxer!.members.add).not.toHaveBeenCalled();
        expect(result.already).toHaveLength(1);
        expect(result.already[0]).toMatchObject({
            discordThreadId: 'dt-1',
            fluxerThreadId: 'ft-1',
        });
        expect(result.added).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(result.unchecked).toEqual([]);
    });

    it('does nothing when the Discord user is not a member (Unknown Member)', async () => {
        const t = setup();
        const p = t.pair(1, {
            discord: discordThread('dt-1', { member: false }),
        });

        const result = await t.sync();

        expect(p.discord!.members.fetch).toHaveBeenCalledWith(DISCORD_USER);
        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(p.fluxer!.members.fetchOne).not.toHaveBeenCalled();
        expect(p.fluxer!.members.add).not.toHaveBeenCalled();
        expect(result).toEqual({
            examined: 1,
            added: [],
            already: [],
            failed: [],
            unchecked: [],
        });
    });

    it('reports "unchecked" with the reason when the Discord membership check fails otherwise', async () => {
        const t = setup();
        const p = t.pair(1, {
            discord: discordThread('dt-1', {
                fetchError: new Error('Missing Access'),
            }),
        });

        const result = await t.sync();

        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(p.fluxer!.members.add).not.toHaveBeenCalled();
        expect(result.unchecked).toEqual([
            {
                thread: {
                    discordThreadId: 'dt-1',
                    fluxerThreadId: 'ft-1',
                    name: 'discord thread',
                },
                reason: 'Missing Access',
            },
        ]);
        expect(result.added).toEqual([]);
        expect(result.already).toEqual([]);
        expect(result.failed).toEqual([]);
    });

    it('treats a thrown error with a different code as unchecked, not as "not a member"', async () => {
        const t = setup();
        const err = new Error('Unknown Channel') as Error & { code: number };
        err.code = RESTJSONErrorCodes.UnknownChannel;
        t.pair(1, { discord: discordThread('dt-1', { fetchError: err }) });

        const result = await t.sync();

        expect(result.unchecked).toHaveLength(1);
        expect(result.unchecked[0].reason).toBe('Unknown Channel');
        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
    });

    it('reports "unchecked" when the Discord thread cannot be fetched', async () => {
        const t = setup();
        const p = t.pair(1, { discord: null });

        const result = await t.sync();

        expect(t.discordResolver.fetchThread).toHaveBeenCalledWith('dt-1');
        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(p.fluxer!.members.add).not.toHaveBeenCalled();
        expect(result.unchecked).toEqual([
            {
                thread: {
                    discordThreadId: 'dt-1',
                    fluxerThreadId: 'ft-1',
                    // No thread to take a name from: falls back to the ID.
                    name: 'ft-1',
                },
                reason: 'Discord thread not found',
            },
        ]);
        expect(result.examined).toBe(1);
        expect(result.failed).toEqual([]);
    });

    it('reports "failed" when the Fluxer thread cannot be fetched', async () => {
        const t = setup();
        t.pair(1, { fluxer: null });

        const result = await t.sync();

        expect(t.fluxerResolver.fetchThread).toHaveBeenCalledWith('ft-1');
        expect(result.failed).toEqual([
            {
                thread: {
                    discordThreadId: 'dt-1',
                    fluxerThreadId: 'ft-1',
                    name: 'discord thread',
                },
                reason: 'Fluxer thread not found',
            },
        ]);
        expect(result.added).toEqual([]);
        expect(result.already).toEqual([]);
        expect(result.unchecked).toEqual([]);
    });

    it('reports "failed" with the error message when adding rejects, and keeps going', async () => {
        const t = setup();
        const broken = t.pair(1, {
            fluxer: fluxerThread('ft-1', {
                addError: new Error('Missing Permissions'),
            }),
        });
        const fine = t.pair(2);

        const result = await t.sync();

        expect(broken.fluxer!.members.add).toHaveBeenCalledWith(FLUXER_USER);
        expect(fine.fluxer!.members.add).toHaveBeenCalledWith(FLUXER_USER);
        expect(result.examined).toBe(2);
        expect(result.failed).toEqual([
            {
                thread: expect.objectContaining({
                    discordThreadId: 'dt-1',
                    fluxerThreadId: 'ft-1',
                }),
                reason: 'Missing Permissions',
            },
        ]);
        expect(result.added).toEqual([
            expect.objectContaining({
                discordThreadId: 'dt-2',
                fluxerThreadId: 'ft-2',
            }),
        ]);
    });

    it('stringifies non-Error rejections in the failure reason', async () => {
        const t = setup();
        const fluxer = fluxerThread('ft-1');
        fluxer.members.add.mockRejectedValueOnce('nope');
        t.pair(1, { fluxer });

        const result = await t.sync();

        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].reason).toBe('nope');
    });

    it('processes every pair and buckets each outcome independently', async () => {
        const t = setup();
        const added = t.pair(1);
        const already = t.pair(2, {
            fluxer: fluxerThread('ft-2', { member: true }),
        });
        t.pair(3, { discord: discordThread('dt-3', { member: false }) });
        t.pair(4, { discord: null });
        t.pair(5, { fluxer: null });
        const last = t.pair(6);

        const result = await t.sync();

        expect(result.examined).toBe(6);
        expect(result.added.map((r) => r.fluxerThreadId)).toEqual([
            'ft-1',
            'ft-6',
        ]);
        expect(result.already.map((r) => r.fluxerThreadId)).toEqual(['ft-2']);
        expect(result.unchecked.map((u) => u.thread.fluxerThreadId)).toEqual([
            'ft-4',
        ]);
        expect(result.failed.map((f) => f.thread.fluxerThreadId)).toEqual([
            'ft-5',
        ]);
        expect(added.fluxer!.members.add).toHaveBeenCalledTimes(1);
        expect(already.fluxer!.members.add).not.toHaveBeenCalled();
        expect(last.fluxer!.members.add).toHaveBeenCalledTimes(1);
    });

    it('checks pairs one at a time rather than in parallel', async () => {
        const t = setup();
        const order: string[] = [];
        const first = discordThread('dt-1');
        first.members.fetch.mockImplementation(async () => {
            order.push('dt-1:start');
            await new Promise((r) => setTimeout(r, 5));
            order.push('dt-1:end');
            return { id: DISCORD_USER };
        });
        const second = discordThread('dt-2');
        second.members.fetch.mockImplementation(async () => {
            order.push('dt-2:start');
            return { id: DISCORD_USER };
        });
        t.pair(1, { discord: first });
        t.pair(2, { discord: second });

        await t.sync();

        expect(order).toEqual(['dt-1:start', 'dt-1:end', 'dt-2:start']);
    });

    describe('thread name in the result', () => {
        it('uses the Fluxer thread name when both are known', async () => {
            const t = setup();
            t.pair(1, {
                discord: discordThread('dt-1', { name: 'from discord' }),
                fluxer: fluxerThread('ft-1', { name: 'from fluxer' }),
            });

            const result = await t.sync();

            expect(result.added[0].name).toBe('from fluxer');
        });

        it('falls back to the Discord thread name when the Fluxer name is empty', async () => {
            const t = setup();
            t.pair(1, {
                discord: discordThread('dt-1', { name: 'from discord' }),
                fluxer: fluxerThread('ft-1', { name: '' }),
            });

            const result = await t.sync();

            expect(result.added[0].name).toBe('from discord');
        });

        it('falls back to the Fluxer thread ID when neither side has a name', async () => {
            const t = setup();
            t.pair(1, {
                discord: discordThread('dt-1', { name: '' }),
                fluxer: fluxerThread('ft-1', { name: '' }),
            });

            const result = await t.sync();

            expect(result.added[0].name).toBe('ft-1');
        });

        it('uses the Discord name for outcomes decided before the Fluxer thread is fetched', async () => {
            const t = setup();
            t.pair(1, {
                discord: discordThread('dt-1', {
                    name: 'from discord',
                    fetchError: new Error('boom'),
                }),
                fluxer: fluxerThread('ft-1', { name: 'from fluxer' }),
            });

            const result = await t.sync();

            expect(result.unchecked[0].thread.name).toBe('from discord');
        });
    });
});
