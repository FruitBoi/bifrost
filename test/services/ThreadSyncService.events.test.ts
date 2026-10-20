import { describe, expect, it, vi } from 'vitest';
import ThreadSyncService from '../../src/services/threadSync/ThreadSyncService';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import {
    FakeLinkProvisioner,
    FakeLinkService,
    fakeDiscordThread,
    fakeFluxerThread,
    makeChannelLink,
} from '../helpers/fakes';

function setup() {
    const links = new FakeLinkService();
    const provisioner = new FakeLinkProvisioner(links);
    const discordThread = fakeDiscordThread({ id: 'dt-1', name: 'old' });
    const fluxerThread = fakeFluxerThread({ id: 'ft-1', name: 'old' });
    const discordResolver = {
        fetchThread: vi.fn(async (id: string) =>
            id === discordThread.id ? discordThread : null
        ),
    };
    const fluxerResolver = {
        fetchThread: vi.fn(async (id: string) =>
            id === fluxerThread.id ? fluxerThread : null
        ),
    };
    const service = new ThreadSyncService(
        links.asLinkService(),
        provisioner.asProvisioner(),
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );
    return {
        service,
        links,
        provisioner,
        discordThread,
        fluxerThread,
        discordResolver,
        fluxerResolver,
    };
}

const threadPair = () =>
    makeChannelLink({ discordThreadId: 'dt-1', fluxerThreadId: 'ft-1' });

describe('rename mirroring', () => {
    it('renames the Fluxer thread when a Discord thread in a thread↔thread link is renamed', async () => {
        const t = setup();
        t.links.links.push(threadPair());

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'new name' }) as never
        );

        expect(t.fluxerThread.edit).toHaveBeenCalledWith({ name: 'new name' });
    });

    it('renames the Discord thread when a Fluxer thread in a thread↔thread link is renamed', async () => {
        const t = setup();
        t.links.links.push(threadPair());

        await t.service.handleFluxerThreadUpdate(
            fakeFluxerThread({ id: 'ft-1', name: 'old' }) as never,
            fakeFluxerThread({ id: 'ft-1', name: 'renamed' }) as never
        );

        expect(t.discordThread.setName).toHaveBeenCalledWith(
            'renamed',
            expect.any(String)
        );
    });

    it('does nothing when the name did not change', async () => {
        const t = setup();
        t.links.links.push(threadPair());

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'same' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'same' }) as never
        );
        await t.service.handleFluxerThreadUpdate(
            fakeFluxerThread({ id: 'ft-1', name: 'same' }) as never,
            fakeFluxerThread({ id: 'ft-1', name: 'same' }) as never
        );

        expect(t.fluxerThread.edit).not.toHaveBeenCalled();
        expect(t.discordThread.setName).not.toHaveBeenCalled();
    });

    it('treats an update that already matches the counterpart name as an echo', async () => {
        const t = setup();
        t.links.links.push(threadPair());
        t.fluxerThread.name = 'already';

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'already' }) as never
        );

        expect(t.fluxerThread.edit).not.toHaveBeenCalled();
    });

    it('does not rename across a thread↔channel link', async () => {
        const t = setup();
        t.links.links.push(
            makeChannelLink({ discordThreadId: 'dt-1', fluxerThreadId: null })
        );

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'new' }) as never
        );

        expect(t.fluxerResolver.fetchThread).not.toHaveBeenCalled();
        expect(t.fluxerThread.edit).not.toHaveBeenCalled();
    });

    it('ignores renames of unlinked threads', async () => {
        const t = setup();

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'new' }) as never
        );

        expect(t.fluxerThread.edit).not.toHaveBeenCalled();
    });

    it('normalises mirrored names to at most 100 characters', async () => {
        const t = setup();
        t.links.links.push(threadPair());

        await t.service.handleDiscordThreadUpdate(
            fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
            fakeDiscordThread({ id: 'dt-1', name: 'y'.repeat(120) }) as never
        );

        expect(t.fluxerThread.edit).toHaveBeenCalledWith({
            name: 'y'.repeat(100),
        });
    });

    it('survives a failing rename call', async () => {
        const t = setup();
        t.links.links.push(threadPair());
        t.fluxerThread.edit.mockRejectedValueOnce(new Error('403'));

        await expect(
            t.service.handleDiscordThreadUpdate(
                fakeDiscordThread({ id: 'dt-1', name: 'old' }) as never,
                fakeDiscordThread({ id: 'dt-1', name: 'new' }) as never
            )
        ).resolves.toBeUndefined();
    });
});

describe('thread deletion', () => {
    it('removes the link when a linked Discord thread is deleted', async () => {
        const t = setup();
        const link = threadPair();
        t.links.links.push(link);

        await t.service.handleDiscordThreadDelete('dt-1');

        expect(t.provisioner.removed).toEqual([link]);
        expect(t.links.links).toHaveLength(0);
    });

    it('removes the link when a linked Fluxer thread is deleted', async () => {
        const t = setup();
        const link = threadPair();
        t.links.links.push(link);

        await t.service.handleFluxerThreadDelete('ft-1');

        expect(t.provisioner.removed).toEqual([link]);
    });

    it('does not touch a channel-side link whose channel id matches', async () => {
        const t = setup();
        const channelLink = makeChannelLink({ discordChannelId: 'dchan' });
        t.links.links.push(channelLink);

        await t.service.handleDiscordThreadDelete('dchan');

        expect(t.provisioner.removed).toHaveLength(0);
        expect(t.links.links).toHaveLength(1);
    });

    it('ignores deletion of unlinked threads', async () => {
        const t = setup();

        await t.service.handleDiscordThreadDelete('nope');
        await t.service.handleFluxerThreadDelete('nope');

        expect(t.provisioner.removed).toHaveLength(0);
    });
});
