import { describe, expect, it, vi } from 'vitest';
import PinBridgeService, {
    PinSyncError,
} from '../../../src/services/pinBridge/PinBridgeService';
import DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import MetricsService from '../../../src/services/MetricsService';
import type DiscordToFluxerMessageRelay from '../../../src/services/messageRelay/DiscordToFluxerMessageRelay';
import type FluxerToDiscordMessageRelay from '../../../src/services/messageRelay/FluxerToDiscordMessageRelay';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

let clock = 1_700_000_000_000;

type FakeMessage = ReturnType<typeof makeMessage>;

function makeMessage(
    side: FakeSide,
    id: string,
    {
        webhookId = null as string | null,
        type = 0,
        authorId = `author-of-${id}`,
    } = {}
) {
    const message = {
        id,
        pinned: false,
        webhookId,
        type,
        content: `content of ${id}`,
        author: { id: authorId },
        pin: vi.fn(async () => {
            side.pin(id);
        }),
        unpin: vi.fn(async () => {
            side.unpin(id);
        }),
    };
    return message;
}

/** One platform's channel: its messages and which are pinned (and when). */
class FakeSide {
    readonly messages = new Map<string, FakeMessage>();
    readonly pinTimes = new Map<string, number>();

    add(id: string, opts: Parameters<typeof makeMessage>[2] = {}) {
        const message = makeMessage(this, id, opts);
        this.messages.set(id, message);
        return message;
    }

    /** Pins without going through the spied `pin()` (a user's action). */
    pin(id: string) {
        const message = this.messages.get(id)!;
        message.pinned = true;
        this.pinTimes.set(id, ++clock);
    }

    unpin(id: string) {
        const message = this.messages.get(id)!;
        message.pinned = false;
        this.pinTimes.delete(id);
    }

    /** Pinned messages, newest pin first (as both APIs return them). */
    pinned() {
        return [...this.pinTimes.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id, at]) => ({ message: this.messages.get(id)!, at }));
    }

    async fetchMessage(id: string) {
        const message = this.messages.get(id);
        if (!message)
            throw Object.assign(new Error('Unknown'), { status: 404 });
        return message;
    }
}

function setup({ delayMs = 0 }: { delayMs?: number } = {}) {
    const links = new FakeLinkService();
    const channelLink = makeChannelLink();
    links.links.push(channelLink);

    const discord = new FakeSide();
    const fluxer = new FakeSide();

    const discordChannel = {
        isTextBased: () => true,
        messages: {
            // The service always asks the API (`force: true`) for Discord.
            fetch: vi.fn(async ({ message }: { message: string }) =>
                discord.fetchMessage(message)
            ),
            fetchPins: vi.fn(async () => ({
                items: discord.pinned().map(({ message, at }) => ({
                    pinnedTimestamp: at,
                    message,
                })),
                hasMore: false,
            })),
        },
    };
    const fluxerChannel = {
        fetchPinnedMessagesPage: vi.fn(async () => {
            const pinned = fluxer.pinned();
            return {
                messages: pinned.map((p) => p.message),
                pinnedAt: pinned.map((p) => new Date(p.at).toISOString()),
                hasMore: false,
            };
        }),
    };

    const discordResolver = {
        fetchChannel: vi.fn(async (_guild: string, id: string) =>
            id === channelLink.discordChannelId ? discordChannel : null
        ),
    };
    const fluxerResolver = {
        fetchChannel: vi.fn(async (_guild: string, id: string) =>
            id === channelLink.fluxerChannelId ? fluxerChannel : null
        ),
        fetchMessage: vi.fn(async (_g: string, _c: string, id: string) =>
            fluxer.fetchMessage(id)
        ),
    };
    const metrics = {
        pinsRelayed: { inc: vi.fn() },
        pinRelayErrors: { inc: vi.fn() },
    };

    let copies = 0;
    const discordRelay = {
        buildPayload: vi.fn(async (message: FakeMessage) => ({
            content: message.content,
        })),
        sendPayload: vi.fn(async () => {
            const id = `fcopy-${++copies}`;
            fluxer.add(id, { webhookId: channelLink.fluxerWebhookId });
            return { messageId: id };
        }),
    };
    const fluxerRelay = {
        buildPayload: vi.fn(async (message: FakeMessage) => ({
            content: message.content,
        })),
        sendPayload: vi.fn(async () => {
            const id = `dcopy-${++copies}`;
            discord.add(id, { webhookId: channelLink.discordWebhookId });
            return { messageId: id };
        }),
    };

    const service = new PinBridgeService({
        linkService: links.asLinkService(),
        discordEntityResolver:
            discordResolver as unknown as DiscordEntityResolver,
        fluxerEntityResolver: fluxerResolver as unknown as FluxerEntityResolver,
        metricsService: metrics as unknown as MetricsService,
        delayMs,
    });
    service.setDiscordRelay(
        discordRelay as unknown as DiscordToFluxerMessageRelay
    );
    service.setFluxerRelay(
        fluxerRelay as unknown as FluxerToDiscordMessageRelay
    );

    /** A message on both sides plus the link between them. */
    const bridge = (discordId: string, fluxerId: string) => {
        const d = discord.add(discordId);
        const f = fluxer.add(fluxerId, {
            webhookId: channelLink.fluxerWebhookId,
        });
        links.createMessageLink({
            discordMessageId: discordId,
            fluxerMessageId: fluxerId,
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'discord',
        });
        return { d, f };
    };

    return {
        service,
        links,
        channelLink,
        discord,
        fluxer,
        discordChannel,
        fluxerChannel,
        discordResolver,
        fluxerResolver,
        discordRelay,
        fluxerRelay,
        metrics,
        bridge,
    };
}

describe('live pin events', () => {
    it('pins the Fluxer copy when a bridged Discord message is pinned', async () => {
        const t = setup();
        const { d, f } = t.bridge('d1', 'f1');

        t.discord.pin('d1');
        await t.service.handleDiscordPinsUpdate('dchan');

        expect(d.pin).not.toHaveBeenCalled();
        expect(f.pin).toHaveBeenCalledTimes(1);
        expect(f.pinned).toBe(true);
        expect(t.fluxerResolver.fetchMessage).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            t.channelLink.fluxerChannelId,
            'f1'
        );
        expect(t.metrics.pinsRelayed.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });

    it('pins the Discord copy when a bridged Fluxer message is pinned', async () => {
        const t = setup();
        const { d } = t.bridge('d1', 'f1');

        t.fluxer.pin('f1');
        await t.service.handleFluxerPinsUpdate('fchan');

        expect(d.pin).toHaveBeenCalledTimes(1);
        expect(d.pinned).toBe(true);
        expect(t.metrics.pinsRelayed.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
    });

    it('unpins the counterpart once a snapshot exists', async () => {
        const t = setup();
        const { f } = t.bridge('d1', 'f1');

        t.discord.pin('d1');
        await t.service.handleDiscordPinsUpdate('dchan');
        expect(f.pinned).toBe(true);

        t.discord.unpin('d1');
        await t.service.handleDiscordPinsUpdate('dchan');

        expect(f.unpin).toHaveBeenCalledTimes(1);
        expect(f.pinned).toBe(false);
    });

    it('does not unpin anything on the first event since start', async () => {
        const t = setup();
        const { f } = t.bridge('d1', 'f1');
        t.fluxer.pin('f1');

        // d1 is not pinned on Discord, but without a snapshot we cannot
        // tell whether it was just unpinned or never pinned.
        await t.service.handleDiscordPinsUpdate('dchan');

        expect(f.unpin).not.toHaveBeenCalled();
        expect(f.pinned).toBe(true);
    });

    it('does not pin again when the counterpart is already pinned', async () => {
        const t = setup();
        const { f } = t.bridge('d1', 'f1');
        t.fluxer.pin('f1');
        t.discord.pin('d1');

        await t.service.handleDiscordPinsUpdate('dchan');

        expect(f.pin).not.toHaveBeenCalled();
    });

    it('ignores pins of unbridged messages', async () => {
        const t = setup();
        t.discord.add('lonely');
        t.discord.pin('lonely');

        await t.service.handleDiscordPinsUpdate('dchan');

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.discordRelay.sendPayload).not.toHaveBeenCalled();
        expect(t.metrics.pinRelayErrors.inc).not.toHaveBeenCalled();
    });

    it('does not bounce the bot’s own pin back', async () => {
        const t = setup();
        const { d, f } = t.bridge('d1', 'f1');

        // Establish both snapshots, as after a while of running.
        await t.service.handleDiscordPinsUpdate('dchan');
        await t.service.handleFluxerPinsUpdate('fchan');

        t.discord.pin('d1');
        await t.service.handleDiscordPinsUpdate('dchan');
        expect(f.pin).toHaveBeenCalledTimes(1);
        t.discordChannel.messages.fetch.mockClear();
        t.fluxerResolver.fetchMessage.mockClear();

        // The Fluxer event caused by the bot's own pin.
        await t.service.handleFluxerPinsUpdate('fchan');

        expect(t.discordChannel.messages.fetch).not.toHaveBeenCalled();
        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(d.pin).not.toHaveBeenCalled();
        expect(d.unpin).not.toHaveBeenCalled();
    });

    it('does not re-pin what a user unpinned before the echo arrived', async () => {
        const t = setup();
        const { d, f } = t.bridge('d1', 'f1');
        await t.service.handleDiscordPinsUpdate('dchan');
        await t.service.handleFluxerPinsUpdate('fchan');

        t.discord.pin('d1');
        await t.service.handleDiscordPinsUpdate('dchan');
        // A Discord user unpins again before Fluxer's echo is processed.
        t.discord.unpin('d1');
        await t.service.handleFluxerPinsUpdate('fchan');
        await t.service.handleDiscordPinsUpdate('dchan');

        expect(d.pin).not.toHaveBeenCalled();
        expect(f.unpin).toHaveBeenCalledTimes(1);
        expect(f.pinned).toBe(false);
    });

    it('serializes concurrent events of one link', async () => {
        const t = setup();
        const { f } = t.bridge('d1', 'f1');
        t.discord.pin('d1');

        await Promise.all([
            t.service.handleDiscordPinsUpdate('dchan'),
            t.service.handleDiscordPinsUpdate('dchan'),
        ]);

        expect(f.pin).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an unlinked channel', async () => {
        const t = setup();

        await t.service.handleDiscordPinsUpdate('elsewhere');
        await t.service.handleFluxerPinsUpdate('elsewhere');

        expect(t.discordResolver.fetchChannel).not.toHaveBeenCalled();
        expect(t.fluxerResolver.fetchChannel).not.toHaveBeenCalled();
    });

    it('logs and counts errors instead of throwing', async () => {
        const t = setup();
        t.discordChannel.messages.fetchPins.mockRejectedValueOnce(
            new Error('boom')
        );

        await expect(
            t.service.handleDiscordPinsUpdate('dchan')
        ).resolves.toBeUndefined();
        expect(t.metrics.pinRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });

    it('keeps going when one counterpart fails to pin', async () => {
        const t = setup();
        const one = t.bridge('d1', 'f1');
        const two = t.bridge('d2', 'f2');
        one.f.pin.mockRejectedValueOnce(new Error('nope'));
        t.discord.pin('d1');
        t.discord.pin('d2');

        await t.service.handleDiscordPinsUpdate('dchan');

        expect(two.f.pinned).toBe(true);
        expect(t.metrics.pinRelayErrors.inc).toHaveBeenCalledTimes(1);
    });

    it('treats a deleted counterpart as nothing to do', async () => {
        const t = setup();
        t.bridge('d1', 'f1');
        t.fluxer.messages.delete('f1');
        t.discord.pin('d1');

        await t.service.handleDiscordPinsUpdate('dchan');

        expect(t.metrics.pinRelayErrors.inc).not.toHaveBeenCalled();
    });
});

describe('syncPastPins', () => {
    it('pins bridged one-sided pins on the other side, both ways', async () => {
        const t = setup();
        const a = t.bridge('d1', 'f1');
        const b = t.bridge('d2', 'f2');
        const c = t.bridge('d3', 'f3');
        t.discord.pin('d1');
        t.fluxer.pin('f2');
        t.discord.pin('d3');
        t.fluxer.pin('f3');

        const result = await t.service.syncPastPins(t.channelLink);

        expect(a.f.pin).toHaveBeenCalledTimes(1);
        expect(b.d.pin).toHaveBeenCalledTimes(1);
        expect(c.d.pin).not.toHaveBeenCalled();
        expect(c.f.pin).not.toHaveBeenCalled();
        expect(result).toEqual({
            pinnedOnDiscord: 1,
            pinnedOnFluxer: 1,
            copiedToDiscord: 0,
            copiedToFluxer: 0,
            alreadyInSync: 1,
            failed: 0,
            skipped: 0,
        });
    });

    it('copies unbridged pins over, links and pins the copies', async () => {
        const t = setup();
        t.discord.add('dorig', { authorId: 'alice' });
        t.discord.pin('dorig');
        t.fluxer.add('forig', { authorId: 'bob' });
        t.fluxer.pin('forig');

        const result = await t.service.syncPastPins(t.channelLink);

        expect(t.discordRelay.buildPayload).toHaveBeenCalledWith(
            t.discord.messages.get('dorig'),
            guildLink
        );
        expect(t.discordRelay.sendPayload).toHaveBeenCalledWith(t.channelLink, {
            content: 'content of dorig',
        });
        expect(t.fluxerRelay.sendPayload).toHaveBeenCalledTimes(1);

        expect(t.links.messageLinks).toEqual([
            expect.objectContaining({
                discordMessageId: 'dorig',
                fluxerMessageId: 'fcopy-1',
                channelLinkId: t.channelLink.id,
                sourcePlatform: 'discord',
                sourceAuthorId: 'alice',
            }),
            expect.objectContaining({
                discordMessageId: 'dcopy-2',
                fluxerMessageId: 'forig',
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'bob',
            }),
        ]);
        expect(t.fluxer.messages.get('fcopy-1')!.pinned).toBe(true);
        expect(t.discord.messages.get('dcopy-2')!.pinned).toBe(true);
        expect(result).toMatchObject({
            copiedToFluxer: 1,
            copiedToDiscord: 1,
            failed: 0,
        });
    });

    it('replays pins oldest first', async () => {
        const t = setup();
        t.fluxer.add('fnew');
        t.discord.add('dold');
        t.discord.pin('dold');
        t.fluxer.pin('fnew');

        await t.service.syncPastPins(t.channelLink);

        const order = [
            ...t.discordRelay.sendPayload.mock.invocationCallOrder,
            ...t.fluxerRelay.sendPayload.mock.invocationCallOrder,
        ];
        expect(order[0]).toBeLessThan(order[1]);
    });

    it('skips copies posted by its own webhooks and system messages', async () => {
        const t = setup();
        t.discord.add('orphan', { webhookId: t.channelLink.discordWebhookId });
        t.discord.pin('orphan');
        t.fluxer.add('system', { type: 6 });
        t.fluxer.pin('system');

        const result = await t.service.syncPastPins(t.channelLink);

        expect(t.discordRelay.sendPayload).not.toHaveBeenCalled();
        expect(t.fluxerRelay.sendPayload).not.toHaveBeenCalled();
        expect(result).toMatchObject({ skipped: 2, failed: 0 });
    });

    it('counts unbridged pins as failed when no relay is set', async () => {
        const t = setup();
        const service = new PinBridgeService({
            linkService: t.links.asLinkService(),
            discordEntityResolver:
                t.discordResolver as unknown as DiscordEntityResolver,
            fluxerEntityResolver:
                t.fluxerResolver as unknown as FluxerEntityResolver,
            delayMs: 0,
        });
        t.discord.add('dorig');
        t.discord.pin('dorig');

        const result = await service.syncPastPins(t.channelLink);

        expect(result).toMatchObject({ copiedToFluxer: 0, failed: 1 });
    });

    it('counts per-message errors as failed and carries on', async () => {
        const t = setup();
        const a = t.bridge('d1', 'f1');
        const b = t.bridge('d2', 'f2');
        a.f.pin.mockRejectedValueOnce(new Error('nope'));
        t.discord.pin('d1');
        t.discord.pin('d2');

        const result = await t.service.syncPastPins(t.channelLink);

        expect(b.f.pinned).toBe(true);
        expect(result).toMatchObject({ pinnedOnFluxer: 1, failed: 1 });
    });

    it('leaves snapshots behind so its own pins are not echoed', async () => {
        const t = setup();
        const { d } = t.bridge('d1', 'f1');
        t.fluxer.pin('f1');

        await t.service.syncPastPins(t.channelLink);
        expect(d.pinned).toBe(true);
        t.fluxerResolver.fetchMessage.mockClear();

        await t.service.handleDiscordPinsUpdate('dchan');

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('refuses a second sync of the same link while one runs', async () => {
        const t = setup({ delayMs: 20 });
        t.discord.add('dorig');
        t.discord.pin('dorig');

        const first = t.service.syncPastPins(t.channelLink);
        const second = t.service.syncPastPins(t.channelLink);

        await expect(second).rejects.toBeInstanceOf(PinSyncError);
        await expect(second).rejects.toMatchObject({
            reason: 'already_running',
        });
        await expect(first).resolves.toMatchObject({ copiedToFluxer: 1 });

        // Once done, the link can be synced again.
        await expect(
            t.service.syncPastPins(t.channelLink)
        ).resolves.toMatchObject({ alreadyInSync: 1 });
    });

    it('reports a Fluxer API block', async () => {
        const t = setup();
        t.fluxerChannel.fetchPinnedMessagesPage.mockRejectedValueOnce(
            Object.assign(new Error('blocked'), { code: 'IP_BANNED' })
        );

        await expect(
            t.service.syncPastPins(t.channelLink)
        ).rejects.toMatchObject({ reason: 'fluxer_blocked' });

        // The block also short-circuits the next attempt.
        await expect(
            t.service.syncPastPins(t.channelLink)
        ).rejects.toMatchObject({ reason: 'fluxer_blocked' });
        const { markFluxerApiOk } =
            await import('../../../src/utils/fluxerApiGuard');
        markFluxerApiOk();
    });
});
