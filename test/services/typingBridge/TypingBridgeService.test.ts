import { beforeEach, describe, expect, it, vi } from 'vitest';
import TypingBridgeService from '../../../src/services/typingBridge/TypingBridgeService';
import {
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../../src/utils/fluxerApiGuard';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

vi.mock('../../../src/utils/fluxerApiGuard', () => ({
    isFluxerApiBlocked: vi.fn(() => false),
    isFluxerApiBlockError: vi.fn(
        (err: unknown) => (err as { code?: string })?.code === 'IP_BANNED'
    ),
    markFluxerApiBlocked: vi.fn(() => 0),
}));

const THROTTLE_MS = 8000;

function fakeChannel(id: string) {
    return { id, sendTyping: vi.fn(async () => {}) };
}

type FakeChannel = ReturnType<typeof fakeChannel>;

/** Resolver whose channels/threads are created on demand and cached by ID. */
function fakeResolver() {
    const channels = new Map<string, FakeChannel>();
    const get = (id: string) => {
        let channel = channels.get(id);
        if (!channel) {
            channel = fakeChannel(id);
            channels.set(id, channel);
        }
        return channel;
    };
    return {
        channels,
        get,
        fetchChannel: vi.fn(
            async (_guildId: string, channelId: string): Promise<unknown> =>
                get(channelId)
        ),
        fetchThread: vi.fn(
            async (threadId: string): Promise<unknown> => get(threadId)
        ),
    };
}

function setup() {
    const linkService = new FakeLinkService();
    const discordEntityResolver = fakeResolver();
    const fluxerEntityResolver = fakeResolver();
    let time = 1_000_000;
    const service = new TypingBridgeService({
        linkService: linkService as never,
        discordEntityResolver: discordEntityResolver as never,
        fluxerEntityResolver: fluxerEntityResolver as never,
        throttleMs: THROTTLE_MS,
        now: () => time,
    });
    return {
        service,
        linkService,
        discord: discordEntityResolver,
        fluxer: fluxerEntityResolver,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

beforeEach(() => {
    vi.mocked(isFluxerApiBlocked).mockReturnValue(false);
    vi.mocked(markFluxerApiBlocked).mockClear();
});

describe('TypingBridgeService Discord → Fluxer', () => {
    it('triggers typing in the linked Fluxer channel', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(makeChannelLink());

        await service.handleDiscordTyping('dchan');

        expect(fluxer.fetchChannel).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            'fchan'
        );
        expect(fluxer.fetchThread).not.toHaveBeenCalled();
        expect(fluxer.get('fchan').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('triggers typing in the linked Fluxer thread', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(
            makeChannelLink({
                discordThreadId: 'dthread',
                fluxerThreadId: 'fthread',
            })
        );

        await service.handleDiscordTyping('dthread');

        expect(fluxer.fetchThread).toHaveBeenCalledWith('fthread');
        expect(fluxer.fetchChannel).not.toHaveBeenCalled();
        expect(fluxer.get('fthread').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an unlinked channel', async () => {
        const { service, fluxer, discord } = setup();

        await service.handleDiscordTyping('unlinked');

        expect(fluxer.fetchChannel).not.toHaveBeenCalled();
        expect(fluxer.fetchThread).not.toHaveBeenCalled();
        expect(discord.fetchChannel).not.toHaveBeenCalled();
    });

    it('skips Fluxer while the Fluxer API is blocked', async () => {
        const { service, linkService, fluxer, advance } = setup();
        linkService.links.push(makeChannelLink());
        vi.mocked(isFluxerApiBlocked).mockReturnValue(true);

        await service.handleDiscordTyping('dchan');

        expect(fluxer.fetchChannel).not.toHaveBeenCalled();
        expect(fluxer.fetchThread).not.toHaveBeenCalled();

        // A blocked attempt does not consume the throttle window.
        vi.mocked(isFluxerApiBlocked).mockReturnValue(false);
        advance(1);
        await service.handleDiscordTyping('dchan');
        expect(fluxer.get('fchan').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('marks the Fluxer API blocked when the send hits a block error', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(makeChannelLink());
        fluxer
            .get('fchan')
            .sendTyping.mockRejectedValueOnce({ code: 'IP_BANNED' });

        await expect(
            service.handleDiscordTyping('dchan')
        ).resolves.toBeUndefined();
        expect(markFluxerApiBlocked).toHaveBeenCalledTimes(1);
    });
});

describe('TypingBridgeService Fluxer → Discord', () => {
    it('triggers typing in the linked Discord channel', async () => {
        const { service, linkService, discord } = setup();
        linkService.links.push(makeChannelLink());

        await service.handleFluxerTyping('fchan');

        expect(discord.fetchChannel).toHaveBeenCalledWith(
            guildLink.discordGuildId,
            'dchan'
        );
        expect(discord.fetchThread).not.toHaveBeenCalled();
        expect(discord.get('dchan').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('triggers typing in the linked Discord thread', async () => {
        const { service, linkService, discord } = setup();
        linkService.links.push(
            makeChannelLink({
                discordThreadId: 'dthread',
                fluxerThreadId: 'fthread',
            })
        );

        await service.handleFluxerTyping('fthread');

        expect(discord.fetchThread).toHaveBeenCalledWith('dthread');
        expect(discord.fetchChannel).not.toHaveBeenCalled();
        expect(discord.get('dthread').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an unlinked channel', async () => {
        const { service, fluxer, discord } = setup();

        await service.handleFluxerTyping('unlinked');

        expect(discord.fetchChannel).not.toHaveBeenCalled();
        expect(discord.fetchThread).not.toHaveBeenCalled();
        expect(fluxer.fetchChannel).not.toHaveBeenCalled();
    });

    it('still works while the Fluxer API is blocked', async () => {
        const { service, linkService, discord } = setup();
        linkService.links.push(makeChannelLink());
        vi.mocked(isFluxerApiBlocked).mockReturnValue(true);

        await service.handleFluxerTyping('fchan');

        expect(discord.get('dchan').sendTyping).toHaveBeenCalledTimes(1);
    });
});

describe('TypingBridgeService throttling', () => {
    it('sends once per throttle window and again after it passes', async () => {
        const { service, linkService, fluxer, advance } = setup();
        linkService.links.push(makeChannelLink());
        const typing = fluxer.get('fchan').sendTyping;

        await service.handleDiscordTyping('dchan');
        advance(THROTTLE_MS - 1);
        await service.handleDiscordTyping('dchan');
        expect(typing).toHaveBeenCalledTimes(1);
        expect(fluxer.fetchChannel).toHaveBeenCalledTimes(1);

        advance(1);
        await service.handleDiscordTyping('dchan');
        expect(typing).toHaveBeenCalledTimes(2);
    });

    it('throttles different target channels independently', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(
            makeChannelLink(),
            makeChannelLink({
                discordChannelId: 'dchan2',
                fluxerChannelId: 'fchan2',
            })
        );

        await service.handleDiscordTyping('dchan');
        await service.handleDiscordTyping('dchan2');

        expect(fluxer.get('fchan').sendTyping).toHaveBeenCalledTimes(1);
        expect(fluxer.get('fchan2').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('throttles each direction independently', async () => {
        const { service, linkService, fluxer, discord } = setup();
        linkService.links.push(makeChannelLink());

        await service.handleDiscordTyping('dchan');
        await service.handleFluxerTyping('fchan');

        expect(fluxer.get('fchan').sendTyping).toHaveBeenCalledTimes(1);
        expect(discord.get('dchan').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('sends once for concurrent events on the same channel', async () => {
        const { service, linkService, fluxer, discord } = setup();
        linkService.links.push(makeChannelLink());

        await Promise.all([
            service.handleDiscordTyping('dchan'),
            service.handleDiscordTyping('dchan'),
            service.handleDiscordTyping('dchan'),
        ]);
        await Promise.all([
            service.handleFluxerTyping('fchan'),
            service.handleFluxerTyping('fchan'),
        ]);

        expect(fluxer.fetchChannel).toHaveBeenCalledTimes(1);
        expect(fluxer.get('fchan').sendTyping).toHaveBeenCalledTimes(1);
        expect(discord.get('dchan').sendTyping).toHaveBeenCalledTimes(1);
    });

    it('swallows send failures and keeps throttling afterwards', async () => {
        const { service, linkService, discord, advance } = setup();
        linkService.links.push(makeChannelLink());
        const typing = discord.get('dchan').sendTyping;
        typing.mockRejectedValue(new Error('Missing Permissions'));

        await expect(
            service.handleFluxerTyping('fchan')
        ).resolves.toBeUndefined();
        expect(typing).toHaveBeenCalledTimes(1);

        advance(1000);
        await expect(
            service.handleFluxerTyping('fchan')
        ).resolves.toBeUndefined();
        expect(typing).toHaveBeenCalledTimes(1);

        advance(THROTTLE_MS);
        await service.handleFluxerTyping('fchan');
        expect(typing).toHaveBeenCalledTimes(2);
    });

    it('prunes expired entries without affecting active throttles', async () => {
        const { service, linkService, fluxer, advance } = setup();
        for (let i = 0; i < 600; i++) {
            linkService.links.push(
                makeChannelLink({
                    discordChannelId: `d${i}`,
                    fluxerChannelId: `f${i}`,
                })
            );
        }

        for (let i = 0; i < 300; i++)
            await service.handleDiscordTyping(`d${i}`);
        advance(THROTTLE_MS);
        for (let i = 300; i < 600; i++) {
            await service.handleDiscordTyping(`d${i}`);
        }
        const map = (
            service as unknown as { lastTriggered: Map<string, number> }
        ).lastTriggered;
        expect(map.size).toBeLessThanOrEqual(500);

        // Recent entries are still throttled.
        await service.handleDiscordTyping('d599');
        expect(fluxer.get('f599').sendTyping).toHaveBeenCalledTimes(1);
    });
});

describe('TypingBridgeService failure handling', () => {
    it('does not throw when the resolver returns null', async () => {
        const { service, linkService, fluxer, discord } = setup();
        linkService.links.push(makeChannelLink());
        fluxer.fetchChannel.mockResolvedValue(null);
        discord.fetchChannel.mockResolvedValue(null);

        await expect(
            service.handleDiscordTyping('dchan')
        ).resolves.toBeUndefined();
        await expect(
            service.handleFluxerTyping('fchan')
        ).resolves.toBeUndefined();
    });

    it('does not throw when the channel cannot send typing', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(makeChannelLink());
        fluxer.fetchChannel.mockResolvedValue({ id: 'fchan' });

        await expect(
            service.handleDiscordTyping('dchan')
        ).resolves.toBeUndefined();
    });

    it('does not throw when the guild link is missing', async () => {
        const { service, linkService, fluxer } = setup();
        linkService.links.push(makeChannelLink());
        linkService.guildLinks = [];

        await expect(
            service.handleDiscordTyping('dchan')
        ).resolves.toBeUndefined();
        expect(fluxer.fetchChannel).not.toHaveBeenCalled();
    });

    it('does not throw when the link lookup fails', async () => {
        const { service, linkService } = setup();
        vi.spyOn(
            linkService,
            'getChannelLinkByFluxerLocation'
        ).mockRejectedValue(new Error('db down'));

        await expect(
            service.handleFluxerTyping('fchan')
        ).resolves.toBeUndefined();
    });
});
