import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import CategorySyncService from '../../src/services/categorySync/CategorySyncService';
import { DEFAULT_BOT_CONFIG } from '../../src/config/BotConfig';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import {
    FakeLinkProvisioner,
    FakeLinkService,
    flush,
    guildLink,
    makeCategoryLink,
    makeChannelLink,
    nextId,
} from '../helpers/fakes';

const CATEGORY_ID = 'dcat';
const HOST_ID = 'fhost';

interface FakeTextChannel {
    type: ChannelType.GuildText;
    id: string;
    name: string;
    position: number;
    parentId: string | null;
}

interface FakeCategory {
    type: ChannelType.GuildCategory;
    id: string;
    name: string;
    children: { cache: Map<string, FakeTextChannel | { type: ChannelType }> };
}

function textChannel(
    overrides: Partial<FakeTextChannel> = {}
): FakeTextChannel {
    return {
        type: ChannelType.GuildText,
        id: nextId('dchan'),
        name: 'general',
        position: 0,
        parentId: CATEGORY_ID,
        ...overrides,
    };
}

function category(
    children: Array<FakeTextChannel | { type: ChannelType; id: string }>,
    overrides: Partial<Omit<FakeCategory, 'children'>> = {}
): FakeCategory {
    return {
        type: ChannelType.GuildCategory,
        id: CATEGORY_ID,
        name: 'Support',
        children: { cache: new Map(children.map((c) => [c.id, c])) },
        ...overrides,
    };
}

function setup() {
    const links = new FakeLinkService();
    const provisioner = new FakeLinkProvisioner(links);

    /** Discord channels by id (categories and text channels alike). */
    const discordChannels = new Map<string, unknown>();
    const discordResolver = {
        fetchChannel: vi.fn(
            async (_guildId: string, id: string) =>
                discordChannels.get(id) ?? null
        ),
        fetchThread: vi.fn(async () => null),
    };

    /** Fluxer threads created through the host channel, by id. */
    const fluxerThreads = new Map<
        string,
        { id: string; name: string; join: () => Promise<void>; edit: any }
    >();
    const threadsCreate = vi.fn(async ({ name }: { name: string }) => {
        const thread = {
            id: nextId('fthread'),
            name,
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => undefined),
        };
        fluxerThreads.set(thread.id, thread);
        return thread;
    });
    const fluxerHost = {
        id: HOST_ID,
        name: 'support-host',
        isText: () => true,
        threads: { create: threadsCreate },
    };
    const fluxerResolver = {
        fetchChannel: vi.fn(async (_guildId: string, id: string) =>
            id === HOST_ID ? fluxerHost : null
        ),
        fetchThread: vi.fn(
            async (id: string) => fluxerThreads.get(id) ?? null
        ),
    };
    const fluxerClient = {
        channels: { fetch: vi.fn(async () => fluxerHost) },
    };

    const service = new CategorySyncService(
        links.asLinkService(),
        provisioner.asProvisioner(),
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );
    service.setFluxerClient(fluxerClient as unknown as FluxerClient);

    return {
        service,
        links,
        provisioner,
        discordChannels,
        discordResolver,
        fluxerThreads,
        threadsCreate,
        fluxerHost,
        fluxerResolver,
        fluxerClient,
    };
}

/** Registers a category with the given children on the Discord side. */
function withCategory(
    t: ReturnType<typeof setup>,
    children: FakeTextChannel[] = [],
    overrides: Partial<Omit<FakeCategory, 'children'>> = {}
) {
    const cat = category(children, overrides);
    t.discordChannels.set(cat.id, cat);
    for (const c of children) t.discordChannels.set(c.id, c);
    return cat;
}

/** Persists a category link in the fake store (as if created earlier). */
function linkedCategory(t: ReturnType<typeof setup>) {
    const categoryLink = makeCategoryLink({
        discordCategoryId: CATEGORY_ID,
        fluxerChannelId: HOST_ID,
    });
    t.links.categoryLinks.push(categoryLink);
    return categoryLink;
}

describe('CategorySyncService.preview', () => {
    it('lists the text channels in position order with alreadyLinked flags', async () => {
        const t = setup();
        const b = textChannel({ id: 'd-b', name: 'bugs', position: 1 });
        const a = textChannel({ id: 'd-a', name: 'announcements', position: 0 });
        const voice = { type: ChannelType.GuildVoice, id: 'd-voice' };
        const cat = withCategory(t, [b, a]);
        cat.children.cache.set(voice.id, voice);
        t.links.links.push(makeChannelLink({ discordChannelId: 'd-b' }));

        const preview = await t.service.preview(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );

        expect(preview).toEqual({
            discordCategoryId: CATEGORY_ID,
            discordCategoryName: 'Support',
            fluxerChannelId: HOST_ID,
            fluxerChannelName: 'support-host',
            channels: [
                { id: 'd-a', name: 'announcements', alreadyLinked: false },
                { id: 'd-b', name: 'bugs', alreadyLinked: true },
            ],
        });
        expect(t.discordResolver.fetchChannel).toHaveBeenCalledWith(
            guildLink.discordGuildId,
            CATEGORY_ID
        );
        expect(t.fluxerResolver.fetchChannel).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            HOST_ID
        );
    });

    it('rejects a category that is already linked', async () => {
        const t = setup();
        withCategory(t);
        linkedCategory(t);

        await expect(
            t.service.preview(guildLink, CATEGORY_ID, HOST_ID)
        ).rejects.toThrow('Discord category already linked');
    });

    it('rejects an id that is not a category', async () => {
        const t = setup();
        const text = textChannel({ id: 'd-text' });
        t.discordChannels.set(text.id, text);

        await expect(
            t.service.preview(guildLink, 'd-text', HOST_ID)
        ).rejects.toThrow('Discord category not found');
        await expect(
            t.service.preview(guildLink, 'missing', HOST_ID)
        ).rejects.toThrow('Discord category not found');
    });

    it('rejects a Fluxer channel that is missing or not a text channel', async () => {
        const t = setup();
        withCategory(t);
        t.fluxerResolver.fetchChannel.mockResolvedValueOnce({
            ...t.fluxerHost,
            isText: () => false,
        });

        await expect(
            t.service.preview(guildLink, CATEGORY_ID, HOST_ID)
        ).rejects.toThrow('Fluxer channel not found or not a text channel');
        await expect(
            t.service.preview(guildLink, CATEGORY_ID, 'nope')
        ).rejects.toThrow('Fluxer channel not found or not a text channel');
    });
});

describe('CategorySyncService.createCategoryLink', () => {
    it('persists the mapping and bridges every text channel to a new thread', async () => {
        const t = setup();
        const a = textChannel({ id: 'd-a', name: 'alpha', position: 0 });
        const b = textChannel({ id: 'd-b', name: 'beta', position: 1 });
        withCategory(t, [a, b]);

        const { categoryLink, result } = await t.service.createCategoryLink(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );

        expect(t.links.categoryLinks).toEqual([categoryLink]);
        expect(categoryLink).toMatchObject({
            guildLinkId: guildLink.id,
            discordCategoryId: CATEGORY_ID,
            fluxerChannelId: HOST_ID,
        });

        expect(t.fluxerClient.channels.fetch).toHaveBeenCalledWith(HOST_ID);
        expect(t.threadsCreate).toHaveBeenCalledTimes(2);
        expect(t.threadsCreate.mock.calls.map((c) => c[0].name)).toEqual([
            'alpha',
            'beta',
        ]);
        for (const thread of t.fluxerThreads.values()) {
            expect(thread.join).toHaveBeenCalled();
        }

        expect(result.linked.map((i) => i.channelId)).toEqual(['d-a', 'd-b']);
        expect(result.skipped).toEqual([]);
        expect(result.failed).toEqual([]);

        expect(t.provisioner.created).toHaveLength(2);
        const [threadA] = [...t.fluxerThreads.values()];
        expect(t.provisioner.created[0]).toEqual({
            guildLink,
            discord: { channelId: 'd-a', threadId: null },
            fluxer: { channelId: HOST_ID, threadId: threadA.id },
            categoryLinkId: categoryLink.id,
        });
        expect(result.linked[0].threadId).toBe(threadA.id);

        const stored = await t.links.getChannelLinksForCategoryLink(
            categoryLink.id
        );
        expect(stored).toHaveLength(2);
        expect(stored[0]).toMatchObject({
            discordChannelId: 'd-a',
            discordThreadId: null,
            fluxerChannelId: HOST_ID,
            fluxerThreadId: threadA.id,
            categoryLinkId: categoryLink.id,
        });
    });

    it('skips channels that are already linked', async () => {
        const t = setup();
        const a = textChannel({ id: 'd-a', name: 'alpha', position: 0 });
        const b = textChannel({ id: 'd-b', name: 'beta', position: 1 });
        withCategory(t, [a, b]);
        const existing = makeChannelLink({ discordChannelId: 'd-a' });
        t.links.links.push(existing);

        const { result } = await t.service.createCategoryLink(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );

        expect(result.skipped).toEqual([
            { channelId: 'd-a', channelName: 'alpha', reason: 'already linked' },
        ]);
        expect(result.linked.map((i) => i.channelId)).toEqual(['d-b']);
        expect(t.threadsCreate).toHaveBeenCalledTimes(1);
        // The pre-existing link is left alone.
        expect(t.links.links).toContain(existing);
        expect(existing.categoryLinkId).toBeNull();
    });

    it('records a per-channel failure when thread creation throws and keeps going', async () => {
        const t = setup();
        const a = textChannel({ id: 'd-a', name: 'alpha', position: 0 });
        const b = textChannel({ id: 'd-b', name: 'beta', position: 1 });
        withCategory(t, [a, b]);
        t.threadsCreate.mockRejectedValueOnce(new Error('api down'));

        const { categoryLink, result } = await t.service.createCategoryLink(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );

        expect(result.failed).toEqual([
            { channelId: 'd-a', channelName: 'alpha', reason: 'api down' },
        ]);
        expect(result.linked.map((i) => i.channelId)).toEqual(['d-b']);
        expect(t.provisioner.created).toHaveLength(1);
        expect(t.links.links).toHaveLength(1);
        // The mapping is still persisted so a later sync can retry.
        expect(t.links.categoryLinks).toEqual([categoryLink]);
    });

    it('does not persist a mapping when validation fails', async () => {
        const t = setup();
        withCategory(t);
        linkedCategory(t);

        await expect(
            t.service.createCategoryLink(guildLink, CATEGORY_ID, HOST_ID)
        ).rejects.toThrow('Discord category already linked');

        expect(t.links.categoryLinks).toHaveLength(1);
        expect(t.threadsCreate).not.toHaveBeenCalled();
    });
});

describe('CategorySyncService.syncCategory', () => {
    it('is idempotent: a second run skips everything and creates nothing', async () => {
        const t = setup();
        withCategory(t, [
            textChannel({ id: 'd-a', name: 'alpha' }),
            textChannel({ id: 'd-b', name: 'beta', position: 1 }),
        ]);
        const { categoryLink } = await t.service.createCategoryLink(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );
        expect(t.threadsCreate).toHaveBeenCalledTimes(2);

        const again = await t.service.syncCategory(categoryLink);

        expect(again.linked).toEqual([]);
        expect(again.failed).toEqual([]);
        expect(again.skipped.map((i) => i.channelId)).toEqual(['d-a', 'd-b']);
        expect(t.threadsCreate).toHaveBeenCalledTimes(2);
        expect(t.links.links).toHaveLength(2);
    });

    it('bridges channels added since the last run', async () => {
        const t = setup();
        const cat = withCategory(t, [textChannel({ id: 'd-a', name: 'alpha' })]);
        const { categoryLink } = await t.service.createCategoryLink(
            guildLink,
            CATEGORY_ID,
            HOST_ID
        );
        const added = textChannel({ id: 'd-new', name: 'new', position: 1 });
        cat.children.cache.set(added.id, added);

        const result = await t.service.syncCategory(categoryLink);

        expect(result.linked.map((i) => i.channelId)).toEqual(['d-new']);
        expect(result.skipped.map((i) => i.channelId)).toEqual(['d-a']);
        expect(t.links.links).toHaveLength(2);
    });

    it('throws when the guild link is gone', async () => {
        const t = setup();
        withCategory(t);
        const categoryLink = makeCategoryLink({ guildLinkId: 'missing' });

        await expect(t.service.syncCategory(categoryLink)).rejects.toThrow(
            'Guild link not found'
        );
    });
});

describe('CategorySyncService.handleDiscordChannelCreate', () => {
    it('bridges a text channel created inside a linked category', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const channel = textChannel({ id: 'd-new', name: 'fresh' });

        await t.service.handleDiscordChannelCreate(channel as never);

        expect(t.threadsCreate).toHaveBeenCalledTimes(1);
        expect(t.threadsCreate.mock.calls[0][0].name).toBe('fresh');
        expect(t.links.links).toHaveLength(1);
        expect(t.links.links[0]).toMatchObject({
            discordChannelId: 'd-new',
            discordThreadId: null,
            fluxerChannelId: HOST_ID,
            categoryLinkId: categoryLink.id,
        });
    });

    it('ignores channels outside a linked category, without a parent, or of other types', async () => {
        const t = setup();
        linkedCategory(t);

        await t.service.handleDiscordChannelCreate(
            textChannel({ parentId: 'other-cat' }) as never
        );
        await t.service.handleDiscordChannelCreate(
            textChannel({ parentId: null }) as never
        );
        await t.service.handleDiscordChannelCreate({
            type: ChannelType.GuildVoice,
            id: 'd-voice',
            name: 'voice',
            parentId: CATEGORY_ID,
        } as never);

        expect(t.threadsCreate).not.toHaveBeenCalled();
        expect(t.links.links).toHaveLength(0);
    });

    it('creates exactly one thread for two concurrent events on the same channel', async () => {
        const t = setup();
        linkedCategory(t);
        const channel = textChannel({ id: 'd-new', name: 'fresh' });
        t.threadsCreate.mockImplementationOnce(async ({ name }) => {
            await flush();
            const thread = {
                id: nextId('fthread'),
                name,
                join: vi.fn(async () => undefined),
                edit: vi.fn(async () => undefined),
            };
            t.fluxerThreads.set(thread.id, thread);
            return thread;
        });

        await Promise.all([
            t.service.handleDiscordChannelCreate(channel as never),
            t.service.handleDiscordChannelCreate(channel as never),
        ]);

        expect(t.threadsCreate).toHaveBeenCalledTimes(1);
        expect(t.provisioner.created).toHaveLength(1);
        expect(t.links.links).toHaveLength(1);
    });
});

describe('CategorySyncService.handleDiscordChannelUpdate', () => {
    it('bridges a text channel moved into a linked category', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const before = textChannel({ id: 'd-m', name: 'moved', parentId: null });
        const after = { ...before, parentId: CATEGORY_ID };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.threadsCreate).toHaveBeenCalledTimes(1);
        expect(t.links.links[0]).toMatchObject({
            discordChannelId: 'd-m',
            categoryLinkId: categoryLink.id,
        });
    });

    it('removes the link of a bridged channel moved out of its category', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const link = makeChannelLink({
            discordChannelId: 'd-m',
            fluxerChannelId: HOST_ID,
            fluxerThreadId: 'ft-m',
            categoryLinkId: categoryLink.id,
        });
        t.links.links.push(link);
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'elsewhere' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([link]);
        expect(t.links.links).toHaveLength(0);
        expect(t.threadsCreate).not.toHaveBeenCalled();
        // The mapping itself survives.
        expect(t.links.categoryLinks).toEqual([categoryLink]);
    });

    it('moves a bridged channel from one linked category to another', async () => {
        const t = setup();
        const source = linkedCategory(t);
        const target = makeCategoryLink({
            discordCategoryId: 'dcat-2',
            fluxerChannelId: 'fhost-2',
        });
        t.links.categoryLinks.push(target);
        const link = makeChannelLink({
            discordChannelId: 'd-m',
            fluxerChannelId: HOST_ID,
            fluxerThreadId: 'ft-m',
            categoryLinkId: source.id,
        });
        t.links.links.push(link);
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'dcat-2' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([link]);
        expect(t.fluxerClient.channels.fetch).toHaveBeenCalledWith('fhost-2');
        expect(t.links.links).toHaveLength(1);
        expect(t.links.links[0]).toMatchObject({
            discordChannelId: 'd-m',
            categoryLinkId: target.id,
        });
    });

    it('leaves a manually created link alone when its channel changes category', async () => {
        const t = setup();
        linkedCategory(t);
        const manual = makeChannelLink({ discordChannelId: 'd-m' });
        t.links.links.push(manual);
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: null };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([manual]);
    });

    it('renames the Fluxer thread when a bridged channel is renamed', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const thread = {
            id: 'ft-r',
            name: 'old-name',
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => undefined),
        };
        t.fluxerThreads.set(thread.id, thread);
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'd-r',
                fluxerChannelId: HOST_ID,
                fluxerThreadId: thread.id,
                categoryLinkId: categoryLink.id,
            })
        );
        const before = textChannel({ id: 'd-r', name: 'old-name' });
        const after = { ...before, name: 'new-name' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.fluxerResolver.fetchThread).toHaveBeenCalledWith('ft-r');
        expect(thread.edit).toHaveBeenCalledTimes(1);
        expect(thread.edit).toHaveBeenCalledWith({ name: 'new-name' });
        expect(t.threadsCreate).not.toHaveBeenCalled();
    });

    it('does not edit the thread when its name already matches', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const thread = {
            id: 'ft-r',
            name: 'new-name',
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => undefined),
        };
        t.fluxerThreads.set(thread.id, thread);
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'd-r',
                fluxerChannelId: HOST_ID,
                fluxerThreadId: thread.id,
                categoryLinkId: categoryLink.id,
            })
        );
        const before = textChannel({ id: 'd-r', name: 'old-name' });
        const after = { ...before, name: 'new-name' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(thread.edit).not.toHaveBeenCalled();
    });

    it('ignores a rename of a channel whose link has no categoryLinkId', async () => {
        const t = setup();
        const thread = {
            id: 'ft-r',
            name: 'old-name',
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => undefined),
        };
        t.fluxerThreads.set(thread.id, thread);
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'd-r',
                fluxerChannelId: HOST_ID,
                fluxerThreadId: thread.id,
                categoryLinkId: null,
            })
        );
        const before = textChannel({ id: 'd-r', name: 'old-name' });
        const after = { ...before, name: 'new-name' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(thread.edit).not.toHaveBeenCalled();
    });

    it('swallows a failing thread rename', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const thread = {
            id: 'ft-r',
            name: 'old-name',
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => {
                throw new Error('api down');
            }),
        };
        t.fluxerThreads.set(thread.id, thread);
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'd-r',
                fluxerThreadId: thread.id,
                categoryLinkId: categoryLink.id,
            })
        );
        const before = textChannel({ id: 'd-r', name: 'old-name' });
        const after = { ...before, name: 'new-name' };

        await expect(
            t.service.handleDiscordChannelUpdate(
                before as never,
                after as never
            )
        ).resolves.toBeUndefined();
        expect(thread.edit).toHaveBeenCalledTimes(1);
    });
});

describe('CategorySyncService.handleDiscordChannelDelete', () => {
    it('removes only the mapping when the category itself is deleted', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const link = makeChannelLink({
            discordChannelId: 'd-a',
            fluxerThreadId: 'ft-a',
            categoryLinkId: categoryLink.id,
        });
        t.links.links.push(link);

        await t.service.handleDiscordChannelDelete({
            type: ChannelType.GuildCategory,
            id: CATEGORY_ID,
            name: 'Support',
        } as never);

        expect(t.links.categoryLinks).toEqual([]);
        expect(t.links.links).toEqual([link]);
        expect(t.provisioner.removed).toEqual([]);
    });

    it('ignores the deletion of an unlinked category', async () => {
        const t = setup();
        linkedCategory(t);

        await t.service.handleDiscordChannelDelete({
            type: ChannelType.GuildCategory,
            id: 'other-cat',
            name: 'Other',
        } as never);

        expect(t.links.categoryLinks).toHaveLength(1);
    });

    it('removes the link of a deleted bridged text channel', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const link = makeChannelLink({
            discordChannelId: 'd-a',
            fluxerThreadId: 'ft-a',
            categoryLinkId: categoryLink.id,
        });
        const other = makeChannelLink({
            discordChannelId: 'd-b',
            fluxerThreadId: 'ft-b',
            categoryLinkId: categoryLink.id,
        });
        t.links.links.push(link, other);

        await t.service.handleDiscordChannelDelete(
            textChannel({ id: 'd-a' }) as never
        );

        expect(t.provisioner.removed).toEqual([link]);
        expect(t.links.links).toEqual([other]);
        expect(t.links.categoryLinks).toEqual([categoryLink]);
    });

    it('leaves a thread-side row untouched', async () => {
        const t = setup();
        const threadRow = makeChannelLink({
            discordChannelId: 'd-parent',
            discordThreadId: 'dt-1',
            fluxerThreadId: 'ft-1',
        });
        t.links.links.push(threadRow);

        await t.service.handleDiscordChannelDelete(
            textChannel({ id: 'dt-1' }) as never
        );

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([threadRow]);
    });

    it('does nothing for an unlinked channel', async () => {
        const t = setup();
        await t.service.handleDiscordChannelDelete(
            textChannel({ id: 'd-unknown' }) as never
        );
        expect(t.provisioner.removed).toEqual([]);
    });
});

describe('CategorySyncService.handleFluxerChannelDelete', () => {
    it('removes the channel link and every category link targeting the channel, with their links', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const second = makeCategoryLink({
            discordCategoryId: 'dcat-2',
            fluxerChannelId: HOST_ID,
        });
        t.links.categoryLinks.push(second);
        const unrelatedCategory = makeCategoryLink({
            discordCategoryId: 'dcat-3',
            fluxerChannelId: 'fhost-other',
        });
        t.links.categoryLinks.push(unrelatedCategory);

        const own = makeChannelLink({
            discordChannelId: 'd-own',
            fluxerChannelId: HOST_ID,
        });
        const bridgedA = makeChannelLink({
            discordChannelId: 'd-a',
            fluxerChannelId: HOST_ID,
            fluxerThreadId: 'ft-a',
            categoryLinkId: categoryLink.id,
        });
        const bridgedB = makeChannelLink({
            discordChannelId: 'd-b',
            fluxerChannelId: HOST_ID,
            fluxerThreadId: 'ft-b',
            categoryLinkId: second.id,
        });
        const unrelated = makeChannelLink({
            discordChannelId: 'd-u',
            fluxerChannelId: 'fhost-other',
            fluxerThreadId: 'ft-u',
            categoryLinkId: unrelatedCategory.id,
        });
        t.links.links.push(own, bridgedA, bridgedB, unrelated);

        await t.service.handleFluxerChannelDelete(HOST_ID);

        expect(t.provisioner.removed).toEqual(
            expect.arrayContaining([own, bridgedA, bridgedB])
        );
        expect(t.provisioner.removed).toHaveLength(3);
        expect(t.links.links).toEqual([unrelated]);
        expect(t.links.categoryLinks).toEqual([unrelatedCategory]);
    });

    it('does not remove a thread row whose parent is the deleted channel on its own', async () => {
        const t = setup();
        // A thread<->thread link under the Fluxer channel is not "the
        // channel's own link"; nothing here should touch it.
        const threadRow = makeChannelLink({
            discordChannelId: 'd-p',
            discordThreadId: 'dt-1',
            fluxerChannelId: HOST_ID,
            fluxerThreadId: 'ft-1',
        });
        t.links.links.push(threadRow);

        await t.service.handleFluxerChannelDelete(HOST_ID);

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([threadRow]);
    });

    it('is a no-op for an unknown channel', async () => {
        const t = setup();
        linkedCategory(t);

        await t.service.handleFluxerChannelDelete('nope');

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.categoryLinks).toHaveLength(1);
    });
});

describe('CategorySyncService.removeCategoryLink', () => {
    it('removes every child link and the mapping, leaving other links alone', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const a = makeChannelLink({
            discordChannelId: 'd-a',
            fluxerThreadId: 'ft-a',
            categoryLinkId: categoryLink.id,
        });
        const b = makeChannelLink({
            discordChannelId: 'd-b',
            fluxerThreadId: 'ft-b',
            categoryLinkId: categoryLink.id,
        });
        const manual = makeChannelLink({ discordChannelId: 'd-manual' });
        t.links.links.push(a, b, manual);

        const { removedLinks } = await t.service.removeCategoryLink(
            categoryLink
        );

        expect(removedLinks).toBe(2);
        expect(t.provisioner.removed).toEqual([a, b]);
        expect(t.links.links).toEqual([manual]);
        expect(t.links.categoryLinks).toEqual([]);
        expect(
            await t.service.getChannelLinksForCategory(categoryLink)
        ).toEqual([]);
    });

    it('still removes the mapping when a child link fails to be removed', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        const a = makeChannelLink({
            discordChannelId: 'd-a',
            fluxerThreadId: 'ft-a',
            categoryLinkId: categoryLink.id,
        });
        const b = makeChannelLink({
            discordChannelId: 'd-b',
            fluxerThreadId: 'ft-b',
            categoryLinkId: categoryLink.id,
        });
        t.links.links.push(a, b);
        const realRemove = t.provisioner.removeLink.bind(t.provisioner);
        t.provisioner.removeLink = vi.fn(async (link) => {
            if (link.id === a.id) throw new Error('webhook gone');
            await realRemove(link);
        });

        const { removedLinks } = await t.service.removeCategoryLink(
            categoryLink
        );

        expect(removedLinks).toBe(1);
        expect(t.links.links).toEqual([a]);
        expect(t.links.categoryLinks).toEqual([]);
    });
});

describe('CategorySyncService bot config', () => {
    const unlinkOff = () => ({
        ...DEFAULT_BOT_CONFIG,
        categories: { mirrorChannelRenames: true, unlinkWhenChannelLeaves: false },
    });
    const renamesOff = () => ({
        ...DEFAULT_BOT_CONFIG,
        categories: { mirrorChannelRenames: false, unlinkWhenChannelLeaves: true },
    });

    /** A category-bridged channel link plus the thread it points at. */
    function bridged(t: ReturnType<typeof setup>, channelId: string) {
        const categoryLink = linkedCategory(t);
        const thread = {
            id: `ft-${channelId}`,
            name: 'old-name',
            join: vi.fn(async () => undefined),
            edit: vi.fn(async () => undefined),
        };
        t.fluxerThreads.set(thread.id, thread);
        const link = makeChannelLink({
            discordChannelId: channelId,
            fluxerChannelId: HOST_ID,
            fluxerThreadId: thread.id,
            categoryLinkId: categoryLink.id,
        });
        t.links.links.push(link);
        return { categoryLink, thread, link };
    }

    it('keeps the link of a channel moved out of its category when unlinkWhenChannelLeaves is off', async () => {
        const t = setup();
        const { link, categoryLink } = bridged(t, 'd-m');
        t.service.setBotConfig(unlinkOff());
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'elsewhere' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([link]);
        expect(link.categoryLinkId).toBe(categoryLink.id);
        expect(t.threadsCreate).not.toHaveBeenCalled();
    });

    it('keeps the link when the channel moves to another linked category and unlinking is off', async () => {
        const t = setup();
        const { link } = bridged(t, 'd-m');
        t.links.categoryLinks.push(
            makeCategoryLink({
                discordCategoryId: 'dcat-2',
                fluxerChannelId: 'fhost-2',
            })
        );
        t.service.setBotConfig(unlinkOff());
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'dcat-2' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        // The existing link survives and no second thread is created for it.
        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([link]);
        expect(t.threadsCreate).not.toHaveBeenCalled();
    });

    it('still bridges a channel moved into a linked category when unlinking is off', async () => {
        const t = setup();
        const categoryLink = linkedCategory(t);
        t.service.setBotConfig(unlinkOff());
        const before = textChannel({ id: 'd-m', name: 'moved', parentId: null });
        const after = { ...before, parentId: CATEGORY_ID };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.threadsCreate).toHaveBeenCalledTimes(1);
        expect(t.links.links[0]).toMatchObject({
            discordChannelId: 'd-m',
            categoryLinkId: categoryLink.id,
        });
    });

    it('does not fetch or edit the thread on rename when mirrorChannelRenames is off', async () => {
        const t = setup();
        const { thread } = bridged(t, 'd-r');
        t.service.setBotConfig(renamesOff());
        const before = textChannel({ id: 'd-r', name: 'old-name' });
        const after = { ...before, name: 'new-name' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(thread.edit).not.toHaveBeenCalled();
    });

    it('still unlinks on leave when only renames are off', async () => {
        const t = setup();
        const { link } = bridged(t, 'd-m');
        t.service.setBotConfig(renamesOff());
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'elsewhere' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([link]);
        expect(t.links.links).toHaveLength(0);
    });

    it('behaves as before with the defaults applied explicitly', async () => {
        const t = setup();
        const { thread, link } = bridged(t, 'd-x');
        t.service.setBotConfig(DEFAULT_BOT_CONFIG);

        const before = textChannel({ id: 'd-x', name: 'old-name' });
        await t.service.handleDiscordChannelUpdate(
            before as never,
            { ...before, name: 'new-name' } as never
        );
        expect(t.fluxerResolver.fetchThread).toHaveBeenCalledWith(thread.id);
        expect(thread.edit).toHaveBeenCalledWith({ name: 'new-name' });

        await t.service.handleDiscordChannelUpdate(
            before as never,
            { ...before, parentId: 'elsewhere' } as never
        );
        expect(t.provisioner.removed).toEqual([link]);
        expect(t.links.links).toHaveLength(0);
    });

    it('keeps a copy of the config, so later mutation has no effect', async () => {
        const t = setup();
        const { link } = bridged(t, 'd-m');
        const config = unlinkOff();
        t.service.setBotConfig(config);
        config.categories.unlinkWhenChannelLeaves = true;
        const before = textChannel({ id: 'd-m', parentId: CATEGORY_ID });
        const after = { ...before, parentId: 'elsewhere' };

        await t.service.handleDiscordChannelUpdate(
            before as never,
            after as never
        );

        expect(t.provisioner.removed).toEqual([]);
        expect(t.links.links).toEqual([link]);
    });
});
