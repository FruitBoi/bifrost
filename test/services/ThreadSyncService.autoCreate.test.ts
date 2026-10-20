import { describe, expect, it, vi } from 'vitest';
import { TextChannel as DiscordTextChannel } from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import ThreadSyncService from '../../src/services/threadSync/ThreadSyncService';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import {
    FakeLinkProvisioner,
    FakeLinkService,
    fakeDiscordThread,
    fakeFluxerThread,
    flush,
    makeChannelLink,
} from '../helpers/fakes';

const DISCORD_BOT_ID = 'discord-bot';
const FLUXER_BOT_ID = 'fluxer-bot';

function setup() {
    const links = new FakeLinkService();
    const provisioner = new FakeLinkProvisioner(links);

    const createdFluxerThread = fakeFluxerThread({ ownerId: FLUXER_BOT_ID });
    const fluxerThreadsCreate = vi.fn(async () => createdFluxerThread);
    const fluxerTextChannel = {
        id: 'fchan',
        isText: () => true,
        threads: { create: fluxerThreadsCreate },
    };
    const fluxerStartThread = vi.fn(async () => createdFluxerThread);
    const fluxerClient = {
        user: { id: FLUXER_BOT_ID },
        channels: {
            fetch: vi.fn(async () => fluxerTextChannel),
            fetchMessage: vi.fn(async () => ({
                startThread: fluxerStartThread,
            })),
        },
    };

    const createdDiscordThread = fakeDiscordThread({
        ownerId: DISCORD_BOT_ID,
    });
    const discordThreadsCreate = vi.fn(async () => createdDiscordThread);
    const discordTextChannel = Object.assign(
        Object.create(DiscordTextChannel.prototype),
        { id: 'dchan', threads: { create: discordThreadsCreate } }
    );
    const discordStartThread = vi.fn(async () => createdDiscordThread);
    const discordClient = {
        user: { id: DISCORD_BOT_ID },
        channels: { fetch: vi.fn(async () => discordTextChannel) },
    };

    const discordResolver = {
        fetchThread: vi.fn(async () => null),
        fetchMessage: vi.fn(async () => ({
            hasThread: false,
            startThread: discordStartThread,
        })),
    };
    const fluxerResolver = { fetchThread: vi.fn(async () => null) };

    const service = new ThreadSyncService(
        links.asLinkService(),
        provisioner.asProvisioner(),
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );
    service.setDiscordClient(discordClient as unknown as DiscordClient);
    service.setFluxerClient(fluxerClient as unknown as FluxerClient);

    return {
        service,
        links,
        provisioner,
        fluxerThreadsCreate,
        fluxerStartThread,
        fluxerClient,
        createdFluxerThread,
        discordThreadsCreate,
        discordStartThread,
        discordClient,
        createdDiscordThread,
        discordResolver,
        fluxerResolver,
    };
}

function linkedParent(links: FakeLinkService, autoSyncThreads = true) {
    const parent = makeChannelLink({ autoSyncThreads });
    links.links.push(parent);
    return parent;
}

describe('ThreadSyncService.resolveDiscordThread (auto-create)', () => {
    it('creates a Fluxer counterpart under the parent link and persists both thread ids', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeDiscordThread();

        const link = await t.service.resolveDiscordThread(thread as never);

        expect(t.fluxerClient.channels.fetch).toHaveBeenCalledWith(
            parent.fluxerChannelId
        );
        expect(t.fluxerThreadsCreate).toHaveBeenCalledTimes(1);
        expect(t.fluxerThreadsCreate.mock.calls[0][0]).toMatchObject({
            name: thread.name,
            autoArchiveDuration: 1440,
        });
        expect(thread.join).toHaveBeenCalled();
        expect(t.createdFluxerThread.join).toHaveBeenCalled();

        expect(link).not.toBeNull();
        expect(link).toMatchObject({
            discordChannelId: parent.discordChannelId,
            discordThreadId: thread.id,
            fluxerChannelId: parent.fluxerChannelId,
            fluxerThreadId: t.createdFluxerThread.id,
        });
        expect(t.provisioner.created).toHaveLength(1);
        expect(t.links.links).toHaveLength(2);
    });

    it('returns null and creates nothing when the parent toggle is off', async () => {
        const t = setup();
        linkedParent(t.links, false);

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread() as never
        );

        expect(link).toBeNull();
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
        expect(t.provisioner.created).toHaveLength(0);
    });

    it('returns null when the parent channel is not linked', async () => {
        const t = setup();

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread({ parentId: 'unlinked' }) as never
        );

        expect(link).toBeNull();
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
    });

    it('returns null when the parent link is not a channel pair', async () => {
        const t = setup();
        // A channel↔thread link on the parent channel must not auto-sync.
        t.links.links.push(
            makeChannelLink({ autoSyncThreads: true, fluxerThreadId: 'ft-x' })
        );

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread() as never
        );

        expect(link).toBeNull();
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
    });

    it('ignores threads owned by the bot itself', async () => {
        const t = setup();
        linkedParent(t.links);

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread({ ownerId: DISCORD_BOT_ID }) as never
        );

        expect(link).toBeNull();
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
    });

    it('returns the existing link without creating anything', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const existing = makeChannelLink({
            discordThreadId: 'dt-existing',
            fluxerThreadId: 'ft-existing',
            guildLinkId: parent.guildLinkId,
        });
        t.links.links.push(existing);

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread({ id: 'dt-existing' }) as never
        );

        expect(link).toBe(existing);
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
    });

    it('does not create when autoCreate is "never"', async () => {
        const t = setup();
        linkedParent(t.links);

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread() as never,
            'never'
        );

        expect(link).toBeNull();
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
    });

    it('dedupes concurrent resolution of the same thread', async () => {
        const t = setup();
        linkedParent(t.links);
        const thread = fakeDiscordThread();
        t.fluxerThreadsCreate.mockImplementation(async () => {
            await flush();
            return t.createdFluxerThread;
        });

        const [a, b] = await Promise.all([
            t.service.resolveDiscordThread(thread as never),
            t.service.resolveDiscordThread(thread as never),
        ]);

        expect(t.fluxerThreadsCreate).toHaveBeenCalledTimes(1);
        expect(t.provisioner.created).toHaveLength(1);
        expect(a).not.toBeNull();
        expect(b).toBe(a);
    });

    it('attaches the counterpart to the bridged starter message when one exists', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeDiscordThread();
        t.links.messageLinks.push({
            id: 'ml',
            guildLinkId: parent.guildLinkId,
            channelLinkId: parent.id,
            discordMessageId: thread.id,
            fluxerMessageId: 'fm-1',
            createdAt: new Date(),
        });

        const link = await t.service.resolveDiscordThread(thread as never);

        expect(t.fluxerClient.channels.fetchMessage).toHaveBeenCalledWith(
            parent.fluxerChannelId,
            'fm-1'
        );
        expect(t.fluxerStartThread).toHaveBeenCalledTimes(1);
        expect(t.fluxerThreadsCreate).not.toHaveBeenCalled();
        expect(link?.fluxerThreadId).toBe(t.createdFluxerThread.id);
    });

    it('falls back to a standalone thread when starting from the message fails', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeDiscordThread();
        t.links.messageLinks.push({
            id: 'ml',
            guildLinkId: parent.guildLinkId,
            channelLinkId: parent.id,
            discordMessageId: thread.id,
            fluxerMessageId: 'fm-1',
            createdAt: new Date(),
        });
        t.fluxerStartThread.mockRejectedValueOnce(new Error('nope'));

        const link = await t.service.resolveDiscordThread(thread as never);

        expect(t.fluxerStartThread).toHaveBeenCalledTimes(1);
        expect(t.fluxerThreadsCreate).toHaveBeenCalledTimes(1);
        expect(link).not.toBeNull();
    });

    it('ignores the starter message when it belongs to a different link', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeDiscordThread();
        t.links.messageLinks.push({
            id: 'ml',
            guildLinkId: parent.guildLinkId,
            channelLinkId: 'some-other-link',
            discordMessageId: thread.id,
            fluxerMessageId: 'fm-1',
            createdAt: new Date(),
        });

        await t.service.resolveDiscordThread(thread as never);

        expect(t.fluxerStartThread).not.toHaveBeenCalled();
        expect(t.fluxerThreadsCreate).toHaveBeenCalledTimes(1);
    });

    it('returns null (and persists nothing) when creating the Fluxer thread fails', async () => {
        const t = setup();
        linkedParent(t.links);
        t.fluxerThreadsCreate.mockRejectedValueOnce(new Error('api down'));

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread() as never
        );

        expect(link).toBeNull();
        expect(t.provisioner.created).toHaveLength(0);
        expect(t.links.links).toHaveLength(1);
    });

    it('never bounces a counterpart it created back to Discord, even if persisting failed', async () => {
        const t = setup();
        linkedParent(t.links);
        t.provisioner.failCreate = new Error('db down');

        const link = await t.service.resolveDiscordThread(
            fakeDiscordThread() as never
        );
        expect(link).toBeNull();

        // The Fluxer THREAD_CREATE for the thread we just made arrives with a
        // non-bot owner (e.g. stale cache); it must still be ignored.
        const echo = fakeFluxerThread({
            id: t.createdFluxerThread.id,
            ownerId: 'someone-else',
        });
        const bounced = await t.service.resolveFluxerThread(echo as never);

        expect(bounced).toBeNull();
        expect(t.discordThreadsCreate).not.toHaveBeenCalled();
    });

    it('recovers the link when persisting races with the other side', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeDiscordThread();
        const raced = makeChannelLink({
            guildLinkId: parent.guildLinkId,
            discordThreadId: thread.id,
            fluxerThreadId: t.createdFluxerThread.id,
        });
        t.provisioner.failCreate = new Error('unique violation');
        t.fluxerThreadsCreate.mockImplementation(async () => {
            t.links.links.push(raced);
            return t.createdFluxerThread;
        });

        const link = await t.service.resolveDiscordThread(thread as never);

        expect(link).toBe(raced);
    });
});

describe('ThreadSyncService.resolveFluxerThread (auto-create)', () => {
    it('creates a Discord counterpart under the parent link and persists both thread ids', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeFluxerThread();

        const link = await t.service.resolveFluxerThread(thread as never);

        expect(t.discordClient.channels.fetch).toHaveBeenCalledWith(
            parent.discordChannelId
        );
        expect(t.discordThreadsCreate).toHaveBeenCalledTimes(1);
        expect(t.discordThreadsCreate.mock.calls[0][0]).toMatchObject({
            name: thread.name,
            autoArchiveDuration: 1440,
        });
        expect(thread.join).toHaveBeenCalled();
        expect(t.createdDiscordThread.join).toHaveBeenCalled();
        expect(link).toMatchObject({
            discordThreadId: t.createdDiscordThread.id,
            fluxerThreadId: thread.id,
            discordChannelId: parent.discordChannelId,
            fluxerChannelId: parent.fluxerChannelId,
        });
    });

    it('returns null when the toggle is off, parent unlinked, or owner is the bot', async () => {
        const t = setup();
        linkedParent(t.links, false);
        expect(
            await t.service.resolveFluxerThread(fakeFluxerThread() as never)
        ).toBeNull();

        t.links.links = [];
        expect(
            await t.service.resolveFluxerThread(fakeFluxerThread() as never)
        ).toBeNull();

        linkedParent(t.links, true);
        expect(
            await t.service.resolveFluxerThread(
                fakeFluxerThread({ ownerId: FLUXER_BOT_ID }) as never
            )
        ).toBeNull();

        expect(t.discordThreadsCreate).not.toHaveBeenCalled();
    });

    it('uses the bridged starter message on Discord when it exists and has no thread yet', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeFluxerThread();
        t.links.messageLinks.push({
            id: 'ml',
            guildLinkId: parent.guildLinkId,
            channelLinkId: parent.id,
            discordMessageId: 'dm-1',
            fluxerMessageId: thread.id,
            createdAt: new Date(),
        });

        const link = await t.service.resolveFluxerThread(thread as never);

        expect(t.discordResolver.fetchMessage).toHaveBeenCalledWith(
            'dguild',
            parent.discordChannelId,
            'dm-1'
        );
        expect(t.discordStartThread).toHaveBeenCalledTimes(1);
        expect(t.discordThreadsCreate).not.toHaveBeenCalled();
        expect(link?.discordThreadId).toBe(t.createdDiscordThread.id);
    });

    it('falls back to a standalone thread when the starter message already has one', async () => {
        const t = setup();
        const parent = linkedParent(t.links);
        const thread = fakeFluxerThread();
        t.links.messageLinks.push({
            id: 'ml',
            guildLinkId: parent.guildLinkId,
            channelLinkId: parent.id,
            discordMessageId: 'dm-1',
            fluxerMessageId: thread.id,
            createdAt: new Date(),
        });
        t.discordResolver.fetchMessage.mockResolvedValueOnce({
            hasThread: true,
            startThread: t.discordStartThread,
        });

        await t.service.resolveFluxerThread(thread as never);

        expect(t.discordStartThread).not.toHaveBeenCalled();
        expect(t.discordThreadsCreate).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent resolution of the same thread', async () => {
        const t = setup();
        linkedParent(t.links);
        const thread = fakeFluxerThread();
        t.discordThreadsCreate.mockImplementation(async () => {
            await flush();
            return t.createdDiscordThread;
        });

        const [a, b] = await Promise.all([
            t.service.resolveFluxerThread(thread as never),
            t.service.resolveFluxerThread(thread as never),
        ]);

        expect(t.discordThreadsCreate).toHaveBeenCalledTimes(1);
        expect(a).not.toBeNull();
        expect(b).toBe(a);
    });

    it('does not create when the parent link is channel↔thread', async () => {
        const t = setup();
        t.links.links.push(
            makeChannelLink({ autoSyncThreads: true, discordThreadId: 'dt-x' })
        );

        expect(
            await t.service.resolveFluxerThread(fakeFluxerThread() as never)
        ).toBeNull();
        expect(t.discordThreadsCreate).not.toHaveBeenCalled();
    });
});

describe('ThreadSyncService.normalizeThreadName', () => {
    it('trims, falls back for empty names and caps at 100 characters', () => {
        expect(ThreadSyncService.normalizeThreadName('  hi  ')).toBe('hi');
        expect(ThreadSyncService.normalizeThreadName('')).toBe('thread');
        expect(ThreadSyncService.normalizeThreadName(null)).toBe('thread');
        expect(
            ThreadSyncService.normalizeThreadName('x'.repeat(150))
        ).toHaveLength(100);
    });
});
