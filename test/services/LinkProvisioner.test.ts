import { describe, expect, it, vi } from 'vitest';
import { ChannelType as DiscordChannelType } from 'discord.js';
import LinkProvisioner from '../../src/services/LinkProvisioner';
import { WebhookService } from '../../src/services/WebhookService';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import { FakeLinkService, guildLink, makeChannelLink } from '../helpers/fakes';

function setup() {
    const links = new FakeLinkService();
    let n = 0;
    const webhooks = {
        createDiscordWebhook: vi.fn(async () => ({
            id: `dwh-new-${++n}`,
            token: 'dt',
        })),
        createFluxerWebhook: vi.fn(async () => ({
            id: `fwh-new-${++n}`,
            token: 'ft',
        })),
        deleteDiscordWebhook: vi.fn(async () => undefined),
        deleteFluxerWebhook: vi.fn(async () => undefined),
    };
    const discordResolver = {
        fetchThread: vi.fn(async () => null as unknown),
        fetchChannel: vi.fn(async () => null as unknown),
    };
    const fluxerResolver = {
        fetchThread: vi.fn(async () => null as unknown),
        fetchChannel: vi.fn(async () => null as unknown),
    };
    const provisioner = new LinkProvisioner(
        links.asLinkService(),
        webhooks as unknown as WebhookService,
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );
    return { provisioner, links, webhooks, discordResolver, fluxerResolver };
}

const channel = (channelId: string) => ({ channelId, threadId: null });
const thread = (channelId: string, threadId: string) => ({
    channelId,
    threadId,
});

describe('LinkProvisioner.createLink', () => {
    it('creates webhooks on both channels for the first link', async () => {
        const t = setup();

        const link = await t.provisioner.createLink({
            guildLink,
            discord: channel('dchan'),
            fluxer: channel('fchan'),
        });

        expect(t.webhooks.createDiscordWebhook).toHaveBeenCalledWith(
            'dchan',
            expect.any(String)
        );
        expect(t.webhooks.createFluxerWebhook).toHaveBeenCalledWith(
            'fchan',
            expect.any(String)
        );
        expect(link).toMatchObject({
            discordChannelId: 'dchan',
            discordThreadId: null,
            fluxerChannelId: 'fchan',
            fluxerThreadId: null,
            discordWebhookId: 'dwh-new-1',
            fluxerWebhookId: 'fwh-new-2',
        });
    });

    it('reuses the parent channel webhooks for a thread link under a linked channel', async () => {
        const t = setup();
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'dchan',
                fluxerChannelId: 'fchan',
                discordWebhookId: 'dwh-parent',
                fluxerWebhookId: 'fwh-parent',
            })
        );

        const link = await t.provisioner.createLink({
            guildLink,
            discord: thread('dchan', 'dt-1'),
            fluxer: thread('fchan', 'ft-1'),
        });

        expect(t.webhooks.createDiscordWebhook).not.toHaveBeenCalled();
        expect(t.webhooks.createFluxerWebhook).not.toHaveBeenCalled();
        expect(link).toMatchObject({
            discordThreadId: 'dt-1',
            fluxerThreadId: 'ft-1',
            discordWebhookId: 'dwh-parent',
            fluxerWebhookId: 'fwh-parent',
        });
    });

    it('creates webhooks for a thread link whose parents are not linked', async () => {
        const t = setup();

        const link = await t.provisioner.createLink({
            guildLink,
            discord: thread('dchan', 'dt-1'),
            fluxer: thread('fchan', 'ft-1'),
        });

        expect(t.webhooks.createDiscordWebhook).toHaveBeenCalledTimes(1);
        expect(t.webhooks.createFluxerWebhook).toHaveBeenCalledTimes(1);
        expect(link.discordThreadId).toBe('dt-1');
    });

    it('shares webhooks between sibling thread links and a later channel link', async () => {
        const t = setup();
        await t.provisioner.createLink({
            guildLink,
            discord: thread('dchan', 'dt-1'),
            fluxer: thread('fchan', 'ft-1'),
        });
        const second = await t.provisioner.createLink({
            guildLink,
            discord: thread('dchan', 'dt-2'),
            fluxer: channel('fother'),
        });
        const channelLink = await t.provisioner.createLink({
            guildLink,
            discord: channel('dchan'),
            fluxer: channel('fchan'),
        });

        expect(t.webhooks.createDiscordWebhook).toHaveBeenCalledTimes(1);
        // fchan once (first link), fother once (second link)
        expect(t.webhooks.createFluxerWebhook).toHaveBeenCalledTimes(2);
        expect(second.discordWebhookId).toBe(channelLink.discordWebhookId);
        expect(channelLink.fluxerWebhookId).toBe(
            t.links.links[0].fluxerWebhookId
        );
    });

    it('rejects a location that is already linked', async () => {
        const t = setup();
        t.links.links.push(makeChannelLink({ discordThreadId: 'dt-1' }));

        await expect(
            t.provisioner.createLink({
                guildLink,
                discord: thread('dchan', 'dt-1'),
                fluxer: channel('fother'),
            })
        ).rejects.toThrow('Discord thread already linked');
        await expect(
            t.provisioner.createLink({
                guildLink,
                discord: channel('dother'),
                fluxer: channel('fchan'),
            })
        ).rejects.toThrow('Fluxer channel already linked');
        expect(t.webhooks.createDiscordWebhook).not.toHaveBeenCalled();
    });

    it('deletes a webhook it just created when the other side fails', async () => {
        const t = setup();
        t.webhooks.createFluxerWebhook.mockRejectedValueOnce(
            new Error('missing permissions')
        );

        await expect(
            t.provisioner.createLink({
                guildLink,
                discord: channel('dchan'),
                fluxer: channel('fchan'),
            })
        ).rejects.toThrow('missing permissions');

        expect(t.webhooks.deleteDiscordWebhook).toHaveBeenCalledWith(
            'dwh-new-1',
            'dt'
        );
        expect(t.links.links).toHaveLength(0);
    });

    it('deletes created webhooks (but not reused ones) when persisting fails', async () => {
        const t = setup();
        t.links.links.push(
            makeChannelLink({
                discordChannelId: 'dchan',
                fluxerChannelId: 'fx',
                discordWebhookId: 'dwh-parent',
            })
        );
        t.links.createChannelLink = vi.fn(async () => {
            throw new Error('db down');
        });

        await expect(
            t.provisioner.createLink({
                guildLink,
                discord: thread('dchan', 'dt-1'),
                fluxer: channel('fchan'),
            })
        ).rejects.toThrow('db down');

        expect(t.webhooks.deleteDiscordWebhook).not.toHaveBeenCalled();
        expect(t.webhooks.deleteFluxerWebhook).toHaveBeenCalledTimes(1);
    });
});

describe('LinkProvisioner.removeLink', () => {
    it('deletes webhooks only when no other link uses them', async () => {
        const t = setup();
        const parent = makeChannelLink({
            discordWebhookId: 'dwh-shared',
            fluxerWebhookId: 'fwh-shared',
        });
        const child = makeChannelLink({
            discordThreadId: 'dt-1',
            fluxerThreadId: 'ft-1',
            discordWebhookId: 'dwh-shared',
            fluxerWebhookId: 'fwh-shared',
        });
        t.links.links.push(parent, child);

        await t.provisioner.removeLink(child);
        expect(t.webhooks.deleteDiscordWebhook).not.toHaveBeenCalled();
        expect(t.webhooks.deleteFluxerWebhook).not.toHaveBeenCalled();
        expect(t.links.links).toEqual([parent]);

        await t.provisioner.removeLink(parent);
        expect(t.webhooks.deleteDiscordWebhook).toHaveBeenCalledWith(
            'dwh-shared',
            parent.discordWebhookToken
        );
        expect(t.webhooks.deleteFluxerWebhook).toHaveBeenCalledWith(
            'fwh-shared',
            parent.fluxerWebhookToken
        );
        expect(t.links.links).toHaveLength(0);
    });

    it('still removes the row when webhook deletion fails', async () => {
        const t = setup();
        const link = makeChannelLink();
        t.links.links.push(link);
        t.webhooks.deleteDiscordWebhook.mockRejectedValueOnce(new Error('404'));

        await expect(t.provisioner.removeLink(link)).resolves.toBeUndefined();
        expect(t.links.links).toHaveLength(0);
    });
});

describe('LinkProvisioner.removeGuildLink', () => {
    it('removes every link and deletes each distinct webhook once', async () => {
        const t = setup();
        t.links.links.push(
            makeChannelLink({
                discordWebhookId: 'dwh-a',
                fluxerWebhookId: 'fwh-a',
            }),
            makeChannelLink({
                discordThreadId: 'dt-1',
                fluxerThreadId: 'ft-1',
                discordWebhookId: 'dwh-a',
                fluxerWebhookId: 'fwh-a',
            }),
            makeChannelLink({
                discordChannelId: 'd2',
                fluxerChannelId: 'f2',
                discordWebhookId: 'dwh-b',
                fluxerWebhookId: 'fwh-b',
            })
        );

        await t.provisioner.removeGuildLink(guildLink);

        expect(t.links.links).toHaveLength(0);
        expect(t.links.guildLinks).toHaveLength(0);
        expect(t.webhooks.deleteDiscordWebhook).toHaveBeenCalledTimes(2);
        expect(t.webhooks.deleteFluxerWebhook).toHaveBeenCalledTimes(2);
    });
});

describe('LinkProvisioner target resolution', () => {
    it('resolves a Discord thread of a text channel', async () => {
        const t = setup();
        t.discordResolver.fetchThread.mockResolvedValueOnce({
            id: 'dt-1',
            guildId: 'dguild',
            parentId: 'dchan',
            name: 'thread',
            parent: { type: DiscordChannelType.GuildText, name: 'general' },
        });

        expect(
            await t.provisioner.resolveDiscordTarget('dguild', 'dt-1')
        ).toEqual({
            kind: 'thread',
            channelId: 'dchan',
            threadId: 'dt-1',
            name: 'thread',
            parentName: 'general',
        });
    });

    it('resolves a Discord text channel and rejects other channel types', async () => {
        const t = setup();
        t.discordResolver.fetchChannel.mockResolvedValueOnce({
            id: 'dchan',
            name: 'general',
            type: DiscordChannelType.GuildText,
        });
        expect(
            await t.provisioner.resolveDiscordTarget('dguild', 'dchan')
        ).toEqual({
            kind: 'channel',
            channelId: 'dchan',
            threadId: null,
            name: 'general',
            parentName: null,
        });

        t.discordResolver.fetchChannel.mockResolvedValueOnce({
            id: 'voice',
            name: 'voice',
            type: DiscordChannelType.GuildVoice,
        });
        expect(
            await t.provisioner.resolveDiscordTarget('dguild', 'voice')
        ).toBeNull();
    });

    it('rejects a Discord thread from another guild or a forum post', async () => {
        const t = setup();
        t.discordResolver.fetchThread.mockResolvedValueOnce({
            id: 'dt-1',
            guildId: 'other',
            parentId: 'dchan',
            name: 'x',
            parent: null,
        });
        expect(
            await t.provisioner.resolveDiscordTarget('dguild', 'dt-1')
        ).toBeNull();

        t.discordResolver.fetchThread.mockResolvedValueOnce({
            id: 'post',
            guildId: 'dguild',
            parentId: 'forum',
            name: 'x',
            parent: { type: DiscordChannelType.GuildForum, name: 'forum' },
        });
        expect(
            await t.provisioner.resolveDiscordTarget('dguild', 'post')
        ).toBeNull();
    });

    it('resolves Fluxer threads and text channels', async () => {
        const t = setup();
        t.fluxerResolver.fetchThread.mockResolvedValueOnce({
            id: 'ft-1',
            guildId: 'fguild',
            parentId: 'fchan',
            name: 'thread',
        });
        t.fluxerResolver.fetchChannel.mockResolvedValueOnce({
            id: 'fchan',
            name: 'general',
            isText: () => true,
        });
        expect(
            await t.provisioner.resolveFluxerTarget('fguild', 'ft-1')
        ).toEqual({
            kind: 'thread',
            channelId: 'fchan',
            threadId: 'ft-1',
            name: 'thread',
            parentName: 'general',
        });

        t.fluxerResolver.fetchChannel.mockResolvedValueOnce({
            id: 'fchan',
            name: 'general',
            isText: () => true,
        });
        expect(
            await t.provisioner.resolveFluxerTarget('fguild', 'fchan')
        ).toEqual({
            kind: 'channel',
            channelId: 'fchan',
            threadId: null,
            name: 'general',
            parentName: null,
        });

        t.fluxerResolver.fetchChannel.mockResolvedValueOnce({
            id: 'v',
            name: 'voice',
            isText: () => false,
        });
        expect(
            await t.provisioner.resolveFluxerTarget('fguild', 'v')
        ).toBeNull();
    });
});
