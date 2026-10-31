import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType } from 'discord.js';

// The relay imports MessageQueueService (for toSerializable), which imports
// the queued_messages model; keep the database out of these tests.
vi.mock('../../../src/db/models/QueuedMessageModel', () => ({
    QueuedMessageModel: {},
}));

import DiscordToFluxerMessageRelay from '../../../src/services/messageRelay/DiscordToFluxerMessageRelay';
import type MessageQueueService from '../../../src/services/MessageQueueService';
import type {
    WebhookMessageData,
    WebhookService,
} from '../../../src/services/WebhookService';
import type FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import type ThreadSyncService from '../../../src/services/threadSync/ThreadSyncService';
import type MessageTransformer from '../../../src/services/messageTransformer/MessageTransformer';
import { markFluxerApiOk } from '../../../src/utils/fluxerApiGuard';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

const TENOR_LINK = 'https://tenor.com/view/dancing-cat-gif-12345';

const REAL_FILE = {
    url: 'https://cdn.discordapp.com/attachments/1/2/real.png',
    name: 'real.png',
    spoiler: false,
};
const GIF_FILE = {
    url: 'https://media.tenor.com/abcAAAAC/dancing-cat.gif',
    name: 'dancing-cat.gif',
    spoiler: false,
    fromLink: true,
};

function linkedPayload(): WebhookMessageData {
    return {
        content: '',
        linkFallbackContent: TENOR_LINK,
        username: 'dave',
        avatarURL: '',
        attachments: [REAL_FILE, GIF_FILE],
    };
}

function discordMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dmsg-1',
        type: MessageType.Default,
        channelId: 'dchan',
        webhookId: null,
        content: TENOR_LINK,
        embeds: [],
        createdTimestamp: Date.now(),
        author: { id: 'duser-1', username: 'dave' },
        channel: { isThread: () => false },
        client: { user: { username: 'Bifröst', avatarURL: () => '' } },
        ...overrides,
    } as never;
}

const tenorEmbed = {
    data: { type: 'gifv' },
    url: TENOR_LINK,
    video: { url: 'https://media.tenor.com/abcAAAPo/dancing-cat.mp4' },
    image: null,
    thumbnail: null,
};

describe('DiscordToFluxerMessageRelay linked media', () => {
    let links: FakeLinkService;

    beforeEach(() => {
        markFluxerApiOk();
        links = new FakeLinkService();
        links.links.push(makeChannelLink());
    });

    function setup(payload: () => WebhookMessageData = linkedPayload) {
        const sendFluxer =
            vi.fn<
                (
                    webhook: unknown,
                    data: WebhookMessageData
                ) => Promise<{ messageId: string }>
            >();
        sendFluxer.mockResolvedValue({ messageId: 'f-sent' });
        const webhookService = {
            getFluxerWebhook: vi.fn(async () => ({ id: 'fwh' })),
            sendMessageViaFluxerWebhook: sendFluxer,
        } as unknown as WebhookService;
        const enqueue = vi.fn<(...args: unknown[]) => Promise<void>>();
        enqueue.mockResolvedValue(undefined);
        const transformMessage =
            vi.fn<(message: unknown) => Promise<WebhookMessageData>>();
        transformMessage.mockImplementation(async () => payload());
        const relay = new DiscordToFluxerMessageRelay({
            linkService: links.asLinkService(),
            webhookService,
            messageTransformer: {
                transformMessage,
            } as unknown as MessageTransformer<never, never>,
            queueService: { enqueue } as unknown as MessageQueueService,
            fluxerEntityResolver: {
                fetchEmojis: vi.fn(async () => []),
            } as unknown as FluxerEntityResolver,
            threadSyncService: {} as unknown as ThreadSyncService,
            unfurlRetryDelayMs: 0,
        });
        return { relay, sendFluxer, enqueue, transformMessage };
    }

    it('sends the uploads as they are when that works', async () => {
        const { relay, sendFluxer, enqueue } = setup();

        await relay.relayMessage(discordMessage({ embeds: [tenorEmbed] }));

        expect(sendFluxer).toHaveBeenCalledTimes(1);
        expect(sendFluxer.mock.calls[0][1].attachments).toHaveLength(2);
        expect(enqueue).not.toHaveBeenCalled();
        expect(links.messageLinks).toHaveLength(1);
    });

    it('retries with the links when the upload fails', async () => {
        const { relay, sendFluxer, enqueue } = setup();
        sendFluxer.mockRejectedValueOnce(new Error('download failed'));

        await relay.relayMessage(discordMessage({ embeds: [tenorEmbed] }));

        expect(sendFluxer).toHaveBeenCalledTimes(2);
        const retry = sendFluxer.mock.calls[1][1];
        expect(retry.content).toBe(TENOR_LINK);
        expect(retry.attachments).toEqual([REAL_FILE]);
        expect(retry.linkFallbackContent).toBeUndefined();
        expect(enqueue).not.toHaveBeenCalled();
        expect(links.messageLinks).toHaveLength(1);
    });

    it('queues the link-only version when the retry fails too', async () => {
        const { relay, sendFluxer, enqueue } = setup();
        sendFluxer.mockRejectedValue(new Error('fluxer down'));

        await relay.relayMessage(discordMessage({ embeds: [tenorEmbed] }));

        expect(sendFluxer).toHaveBeenCalledTimes(2);
        expect(enqueue).toHaveBeenCalledTimes(1);
        const queued = enqueue.mock.calls[0][3] as WebhookMessageData;
        expect(queued.content).toBe(TENOR_LINK);
        expect(queued.attachments).toEqual([REAL_FILE]);
        expect(queued.linkFallbackContent).toBeUndefined();
    });

    it('does not retry a Fluxer API block, and queues the link-only version', async () => {
        const { relay, sendFluxer, enqueue } = setup();
        sendFluxer.mockRejectedValueOnce({ code: 'IP_BANNED' });

        await relay.relayMessage(discordMessage({ embeds: [tenorEmbed] }));

        expect(sendFluxer).toHaveBeenCalledTimes(1);
        const queued = enqueue.mock.calls[0][3] as WebhookMessageData;
        expect(queued.content).toBe(TENOR_LINK);
        expect(queued.attachments).toEqual([REAL_FILE]);
    });

    it('does not retry a payload without linked media', async () => {
        const { relay, sendFluxer, enqueue } = setup(() => ({
            content: 'hello',
            username: 'dave',
            avatarURL: '',
            attachments: [REAL_FILE],
        }));
        sendFluxer.mockRejectedValueOnce(new Error('fluxer down'));

        await relay.relayMessage(discordMessage({ content: 'hello' }));

        expect(sendFluxer).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('re-fetches the message until its gif link has unfurled', async () => {
        const unfurled = discordMessage({ embeds: [tenorEmbed] });
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(discordMessage())
            .mockResolvedValueOnce(unfurled);
        const { relay, transformMessage } = setup();

        await relay.buildPayload(discordMessage({ fetch }), guildLink);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledWith(true);
        expect(transformMessage.mock.calls[0][0]).toBe(unfurled);
    });

    it('gives up after three re-fetches', async () => {
        const fetch = vi.fn(async () => discordMessage());
        const { relay } = setup();

        await relay.buildPayload(discordMessage({ fetch }), guildLink);

        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('relays the original when re-fetching fails', async () => {
        const original = discordMessage({
            fetch: vi.fn(async () => {
                throw new Error('gone');
            }),
        });
        const { relay, transformMessage } = setup();

        await relay.buildPayload(original, guildLink);

        expect(transformMessage.mock.calls[0][0]).toBe(original);
    });

    it('does not re-fetch an unfurled or old message', async () => {
        const fetch = vi.fn();
        const { relay } = setup();

        await relay.buildPayload(
            discordMessage({ fetch, embeds: [tenorEmbed] }),
            guildLink
        );
        await relay.buildPayload(
            discordMessage({ fetch, createdTimestamp: Date.now() - 3_600_000 }),
            guildLink
        );

        expect(fetch).not.toHaveBeenCalled();
    });
});
