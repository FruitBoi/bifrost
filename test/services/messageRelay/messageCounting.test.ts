import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType as DiscordMessageType } from 'discord.js';
import { MessageType as FluxerMessageType } from '@fluxerjs/core';

// The relays import MessageQueueService (for toSerializable), which imports
// the queued_messages model; keep the database out of these tests.
vi.mock('../../../src/db/models/QueuedMessageModel', () => ({
    QueuedMessageModel: {},
}));

import DiscordToFluxerMessageRelay from '../../../src/services/messageRelay/DiscordToFluxerMessageRelay';
import FluxerToDiscordMessageRelay from '../../../src/services/messageRelay/FluxerToDiscordMessageRelay';
import type MessageCountService from '../../../src/services/messageCount/MessageCountService';
import type MessageQueueService from '../../../src/services/MessageQueueService';
import type { WebhookService } from '../../../src/services/WebhookService';
import type FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import type DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import type ThreadSyncService from '../../../src/services/threadSync/ThreadSyncService';
import type MessageTransformer from '../../../src/services/messageTransformer/MessageTransformer';
import { markFluxerApiOk } from '../../../src/utils/fluxerApiGuard';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

const PAYLOAD = { content: 'hello', username: 'dave', avatarURL: '' };

function fakeWebhookService() {
    const sendFluxer = vi.fn(async () => ({ messageId: 'f-sent' }));
    const sendDiscord = vi.fn(async () => ({ messageId: 'd-sent' }));
    const service = {
        getFluxerWebhook: vi.fn(async () => ({ id: 'fwh' })),
        getDiscordWebhook: vi.fn(async () => ({ id: 'dwh' })),
        sendMessageViaFluxerWebhook: sendFluxer,
        sendMessageViaDiscordWebhook: sendDiscord,
    };
    return {
        service: service as unknown as WebhookService,
        sendFluxer,
        sendDiscord,
    };
}

function fakeCounter(
    record: (
        guildLinkId: string,
        source: string
    ) => Promise<void> = async () => {}
) {
    const counter = { record: vi.fn(record) };
    return {
        counter,
        service: counter as unknown as MessageCountService,
    };
}

function fakeQueue() {
    const queue = { enqueue: vi.fn(async () => {}) };
    return { queue, service: queue as unknown as MessageQueueService };
}

const transformer = {
    transformMessage: vi.fn(async () => ({ ...PAYLOAD })),
} as unknown as MessageTransformer<never, never>;

const bot = {
    user: { username: 'Bifröst', avatarURL: () => '' },
};

function discordMessage(
    overrides: Record<string, unknown> = {}
): Parameters<DiscordToFluxerMessageRelay['relayMessage']>[0] {
    return {
        id: 'dmsg-1',
        type: DiscordMessageType.Default,
        channelId: 'dchan',
        webhookId: null,
        author: { id: 'duser-1', username: 'dave' },
        channel: { isThread: () => false },
        client: bot,
        ...overrides,
    } as never;
}

function fluxerMessage(
    overrides: Record<string, unknown> = {}
): Parameters<FluxerToDiscordMessageRelay['relayMessage']>[0] {
    return {
        id: 'fmsg-1',
        type: FluxerMessageType.Default,
        channelId: 'fchan',
        webhookId: null,
        author: { id: 'fuser-1', username: 'dave', discriminator: '0001' },
        channel: { isThread: () => false },
        client: bot,
        ...overrides,
    } as never;
}

describe('DiscordToFluxerMessageRelay message counting', () => {
    let links: FakeLinkService;
    let channelLink: ReturnType<typeof makeChannelLink>;

    beforeEach(() => {
        markFluxerApiOk();
        links = new FakeLinkService();
        channelLink = makeChannelLink();
        links.links.push(channelLink);
    });

    function setup(record?: Parameters<typeof fakeCounter>[0]) {
        const webhooks = fakeWebhookService();
        const counter = fakeCounter(record);
        const queue = fakeQueue();
        const relay = new DiscordToFluxerMessageRelay({
            linkService: links.asLinkService(),
            webhookService: webhooks.service,
            messageTransformer: transformer,
            queueService: queue.service,
            messageCountService: counter.service,
            fluxerEntityResolver: {
                fetchEmojis: vi.fn(async () => []),
            } as unknown as FluxerEntityResolver,
            threadSyncService: {} as unknown as ThreadSyncService,
        });
        return {
            relay,
            webhooks,
            counter: counter.counter,
            queue: queue.queue,
        };
    }

    it('counts a relayed message once, from discord, for its guild link', async () => {
        const { relay, webhooks, counter } = setup();

        await relay.relayMessage(discordMessage());

        expect(webhooks.sendFluxer).toHaveBeenCalledTimes(1);
        expect(counter.record).toHaveBeenCalledTimes(1);
        expect(counter.record).toHaveBeenCalledWith(guildLink.id, 'discord');
        expect(links.messageLinks).toHaveLength(1);
    });

    it('does not count join notices', async () => {
        const { relay, webhooks, counter } = setup();

        await relay.relayMessage(
            discordMessage({ type: DiscordMessageType.UserJoin })
        );

        expect(webhooks.sendFluxer).toHaveBeenCalledTimes(1);
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('does not count a message whose send fails (it is queued instead)', async () => {
        const { relay, webhooks, counter, queue } = setup();
        webhooks.sendFluxer.mockRejectedValueOnce(new Error('fluxer down'));

        await relay.relayMessage(discordMessage());

        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('does not count a message queued while the Fluxer API is blocked', async () => {
        const { relay, webhooks, counter, queue } = setup();
        webhooks.sendFluxer.mockRejectedValueOnce({ code: 'IP_BANNED' });
        await relay.relayMessage(discordMessage({ id: 'dmsg-a' }));
        queue.enqueue.mockClear();

        await relay.relayMessage(discordMessage({ id: 'dmsg-b' }));

        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(webhooks.sendFluxer).toHaveBeenCalledTimes(1);
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('a failing counter never queues an already delivered message', async () => {
        const { relay, webhooks, queue, counter } = setup(async () => {
            throw new Error('db down');
        });

        await relay.relayMessage(discordMessage());

        expect(counter.record).toHaveBeenCalledTimes(1);
        expect(webhooks.sendFluxer).toHaveBeenCalledTimes(1);
        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(links.messageLinks).toHaveLength(1);
    });

    it('a synchronously throwing counter never queues either', async () => {
        const { relay, queue, counter } = setup();
        counter.record.mockImplementation(() => {
            throw new Error('boom');
        });

        await relay.relayMessage(discordMessage());

        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(links.messageLinks).toHaveLength(1);
    });

    it('relays without a counter configured', async () => {
        const webhooks = fakeWebhookService();
        const relay = new DiscordToFluxerMessageRelay({
            linkService: links.asLinkService(),
            webhookService: webhooks.service,
            messageTransformer: transformer,
            fluxerEntityResolver: {
                fetchEmojis: vi.fn(async () => []),
            } as unknown as FluxerEntityResolver,
            threadSyncService: {} as unknown as ThreadSyncService,
        });

        await relay.relayMessage(discordMessage());

        expect(webhooks.sendFluxer).toHaveBeenCalledTimes(1);
    });
});

describe('FluxerToDiscordMessageRelay message counting', () => {
    let links: FakeLinkService;
    let channelLink: ReturnType<typeof makeChannelLink>;

    beforeEach(() => {
        links = new FakeLinkService();
        channelLink = makeChannelLink();
        links.links.push(channelLink);
    });

    function setup(record?: Parameters<typeof fakeCounter>[0]) {
        const webhooks = fakeWebhookService();
        const counter = fakeCounter(record);
        const queue = fakeQueue();
        const relay = new FluxerToDiscordMessageRelay({
            linkService: links.asLinkService(),
            webhookService: webhooks.service,
            messageTransformer: transformer,
            queueService: queue.service,
            messageCountService: counter.service,
            discordEntityResolver: {
                fetchEmojis: vi.fn(async () => []),
            } as unknown as DiscordEntityResolver,
            threadSyncService: {} as unknown as ThreadSyncService,
        });
        return {
            relay,
            webhooks,
            counter: counter.counter,
            queue: queue.queue,
        };
    }

    it('counts a relayed message once, from fluxer, for its guild link', async () => {
        const { relay, webhooks, counter } = setup();

        await relay.relayMessage(fluxerMessage());

        expect(webhooks.sendDiscord).toHaveBeenCalledTimes(1);
        expect(counter.record).toHaveBeenCalledTimes(1);
        expect(counter.record).toHaveBeenCalledWith(guildLink.id, 'fluxer');
        expect(links.messageLinks).toHaveLength(1);
    });

    it('does not count join notices', async () => {
        const { relay, webhooks, counter } = setup();

        await relay.relayMessage(
            fluxerMessage({ type: FluxerMessageType.UserJoin })
        );

        expect(webhooks.sendDiscord).toHaveBeenCalledTimes(1);
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('does not count a message whose send fails (it is queued instead)', async () => {
        const { relay, webhooks, counter, queue } = setup();
        webhooks.sendDiscord.mockRejectedValueOnce(new Error('discord down'));

        await relay.relayMessage(fluxerMessage());

        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('does not count when the Discord webhook is gone', async () => {
        const { relay, webhooks, counter } = setup();
        (
            webhooks.service.getDiscordWebhook as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce(null);

        await relay.relayMessage(fluxerMessage());

        expect(webhooks.sendDiscord).not.toHaveBeenCalled();
        expect(counter.record).not.toHaveBeenCalled();
    });

    it('a failing counter never queues an already delivered message', async () => {
        const { relay, webhooks, queue, counter } = setup(async () => {
            throw new Error('db down');
        });

        await relay.relayMessage(fluxerMessage());

        expect(counter.record).toHaveBeenCalledTimes(1);
        expect(webhooks.sendDiscord).toHaveBeenCalledTimes(1);
        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(links.messageLinks).toHaveLength(1);
    });
});
