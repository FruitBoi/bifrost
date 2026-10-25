import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookService } from '../../src/services/WebhookService';
import type MessageCountService from '../../src/services/messageCount/MessageCountService';
import { FakeLinkService, makeChannelLink } from '../helpers/fakes';

// In-memory stand-in for the queued_messages table.
type FakeEntry = {
    id: string;
    direction: 'discord_to_fluxer' | 'fluxer_to_discord';
    channelLinkId: string;
    sourceMessageId: string;
    payload: string;
    retryCount: number;
    lastError: string | null;
    createdAt: Date;
    destroy: () => Promise<void>;
    update: (values: Record<string, unknown>) => Promise<void>;
};
const entries: FakeEntry[] = [];

vi.mock('../../src/db/models/QueuedMessageModel', () => ({
    QueuedMessageModel: {
        create: vi.fn(async (values: Record<string, unknown>) => {
            const entry: FakeEntry = {
                id: `q-${entries.length + 1}`,
                direction: values.direction as FakeEntry['direction'],
                channelLinkId: values.channelLinkId as string,
                sourceMessageId: values.sourceMessageId as string,
                payload: values.payload as string,
                retryCount: 0,
                lastError: null,
                createdAt: new Date(),
                destroy: async () => {
                    entries.splice(entries.indexOf(entry), 1);
                },
                update: async (patch) => {
                    Object.assign(entry, patch);
                },
            };
            entries.push(entry);
            return entry;
        }),
        destroy: vi.fn(async () => 0),
        findAll: vi.fn(async () => [...entries]),
    },
}));

import MessageQueueService, {
    toSerializable,
} from '../../src/services/MessageQueueService';

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

const payload = {
    content: '<@u-target> hello',
    username: 'dave',
    avatarURL: '',
    mentionUserIds: ['u-target'],
};

describe('MessageQueueService drain', () => {
    let links: FakeLinkService;
    let channelLink: ReturnType<typeof makeChannelLink>;

    beforeEach(() => {
        entries.length = 0;
        links = new FakeLinkService();
        channelLink = makeChannelLink();
        links.links.push(channelLink);
    });

    it('relays a queued Discord message with its mentions and links it to its author', async () => {
        const queue = new MessageQueueService(60_000);
        const { service, sendFluxer } = fakeWebhookService();

        await queue.enqueue(
            'discord_to_fluxer',
            channelLink.id,
            'dmsg-1',
            toSerializable(payload, 'duser-1')
        );
        await queue.drain(service, links.asLinkService());

        expect(sendFluxer).toHaveBeenCalledTimes(1);
        const sent = sendFluxer.mock.calls[0]![1] as Record<string, unknown>;
        expect(sent.mentionUserIds).toEqual(['u-target']);
        expect('sourceAuthorId' in sent).toBe(false);
        expect(links.messageLinks).toHaveLength(1);
        expect(links.messageLinks[0]).toMatchObject({
            discordMessageId: 'dmsg-1',
            fluxerMessageId: 'f-sent',
            channelLinkId: channelLink.id,
            sourcePlatform: 'discord',
            sourceAuthorId: 'duser-1',
        });
        expect(entries).toHaveLength(0);
    });

    it('relays a queued Fluxer message and links it to its author', async () => {
        const queue = new MessageQueueService(60_000);
        const { service, sendDiscord } = fakeWebhookService();

        await queue.enqueue(
            'fluxer_to_discord',
            channelLink.id,
            'fmsg-1',
            toSerializable(payload, 'fuser-1')
        );
        await queue.drain(service, links.asLinkService());

        expect(sendDiscord).toHaveBeenCalledTimes(1);
        expect(links.messageLinks[0]).toMatchObject({
            discordMessageId: 'd-sent',
            fluxerMessageId: 'fmsg-1',
            sourcePlatform: 'fluxer',
            sourceAuthorId: 'fuser-1',
        });
    });

    it('records the platform but no author for entries without one', async () => {
        const queue = new MessageQueueService(60_000);
        const { service } = fakeWebhookService();

        await queue.enqueue(
            'discord_to_fluxer',
            channelLink.id,
            'dmsg-2',
            toSerializable(payload)
        );
        await queue.drain(service, links.asLinkService());

        expect(links.messageLinks[0]).toMatchObject({
            sourcePlatform: 'discord',
            sourceAuthorId: null,
        });
    });

    describe('message counting', () => {
        function fakeCounter(
            record: MessageCountService['record'] = vi.fn(async () => {})
        ) {
            return {
                record: vi.fn(record),
            };
        }

        it('counts a delivered Discord message once, from discord', async () => {
            const queue = new MessageQueueService(60_000);
            const counter = fakeCounter();
            queue.setMessageCountService(
                counter as unknown as MessageCountService
            );
            const { service } = fakeWebhookService();

            await queue.enqueue(
                'discord_to_fluxer',
                channelLink.id,
                'dmsg-c1',
                toSerializable(payload, 'duser-1')
            );
            await queue.drain(service, links.asLinkService());

            expect(counter.record).toHaveBeenCalledTimes(1);
            expect(counter.record).toHaveBeenCalledWith(
                channelLink.guildLinkId,
                'discord'
            );
        });

        it('counts a delivered Fluxer message once, from fluxer', async () => {
            const queue = new MessageQueueService(60_000);
            const counter = fakeCounter();
            queue.setMessageCountService(
                counter as unknown as MessageCountService
            );
            const { service } = fakeWebhookService();

            await queue.enqueue(
                'fluxer_to_discord',
                channelLink.id,
                'fmsg-c1',
                toSerializable(payload, 'fuser-1')
            );
            await queue.drain(service, links.asLinkService());

            expect(counter.record).toHaveBeenCalledTimes(1);
            expect(counter.record).toHaveBeenCalledWith(
                channelLink.guildLinkId,
                'fluxer'
            );
        });

        it('delivers but does not count a queued join notice', async () => {
            const queue = new MessageQueueService(60_000);
            const counter = fakeCounter();
            queue.setMessageCountService(
                counter as unknown as MessageCountService
            );
            const { service, sendDiscord } = fakeWebhookService();

            await queue.enqueue(
                'fluxer_to_discord',
                channelLink.id,
                'fmsg-join',
                toSerializable(payload, 'fuser-1', { uncounted: true })
            );
            await queue.drain(service, links.asLinkService());

            expect(sendDiscord).toHaveBeenCalledTimes(1);
            expect(sendDiscord.mock.calls[0]).not.toContainEqual(
                expect.objectContaining({ uncounted: true })
            );
            expect(counter.record).not.toHaveBeenCalled();
        });

        it('does not count an entry whose send fails', async () => {
            const queue = new MessageQueueService(60_000);
            const counter = fakeCounter();
            queue.setMessageCountService(
                counter as unknown as MessageCountService
            );
            const { service, sendDiscord } = fakeWebhookService();
            sendDiscord.mockRejectedValueOnce(new Error('discord down'));

            await queue.enqueue(
                'fluxer_to_discord',
                channelLink.id,
                'fmsg-c2',
                toSerializable(payload)
            );
            await queue.drain(service, links.asLinkService());

            expect(counter.record).not.toHaveBeenCalled();
            expect(entries).toHaveLength(1);
            expect(entries[0]!.retryCount).toBe(1);
        });

        it('a failing counter never makes drain retry a delivered message', async () => {
            const queue = new MessageQueueService(60_000);
            const counter = fakeCounter(async () => {
                throw new Error('db down');
            });
            queue.setMessageCountService(
                counter as unknown as MessageCountService
            );
            const { service, sendFluxer } = fakeWebhookService();

            await queue.enqueue(
                'discord_to_fluxer',
                channelLink.id,
                'dmsg-c3',
                toSerializable(payload)
            );
            await queue.drain(service, links.asLinkService());
            await queue.drain(service, links.asLinkService());

            expect(sendFluxer).toHaveBeenCalledTimes(1);
            expect(entries).toHaveLength(0);
            expect(links.messageLinks).toHaveLength(1);
        });

        it('a synchronously throwing counter never makes drain retry either', async () => {
            const queue = new MessageQueueService(60_000);
            queue.setMessageCountService({
                record: () => {
                    throw new Error('boom');
                },
            } as unknown as MessageCountService);
            const { service, sendDiscord } = fakeWebhookService();

            await queue.enqueue(
                'fluxer_to_discord',
                channelLink.id,
                'fmsg-c4',
                toSerializable(payload)
            );
            await queue.drain(service, links.asLinkService());
            await queue.drain(service, links.asLinkService());

            expect(sendDiscord).toHaveBeenCalledTimes(1);
            expect(entries).toHaveLength(0);
        });
    });
});
