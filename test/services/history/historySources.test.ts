import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client as DiscordClient, MessageType } from 'discord.js';
import {
    Client as FluxerClient,
    Message as FluxerMessage,
    MessageType as FluxerMessageType,
} from '@fluxerjs/core';
import DiscordHistorySource, {
    toDiscordHistoryItem,
} from '../../../src/services/history/DiscordHistorySource';
import FluxerHistorySource, {
    FluxerHistoryChannel,
    toFluxerHistoryItem,
} from '../../../src/services/history/FluxerHistorySource';
import type DiscordToFluxerMessageRelay from '../../../src/services/messageRelay/DiscordToFluxerMessageRelay';
import type FluxerToDiscordMessageRelay from '../../../src/services/messageRelay/FluxerToDiscordMessageRelay';
import type { WebhookMessageData } from '../../../src/services/WebhookService';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

const NOW = new Date('2026-10-20T12:00:00Z');

interface FakeMessageOptions {
    authorId?: string;
    username?: string;
    bot?: boolean;
    webhookId?: string | null;
    type?: number;
    content?: string;
    attachments?: number;
    embeds?: number;
    stickers?: number;
}

/** A Discord-looking message with the fields the source reads. */
function discordMessage(id: string, o: FakeMessageOptions = {}) {
    return {
        id,
        createdAt: NOW,
        author: {
            id: o.authorId ?? 'user-1',
            username: o.username ?? 'alice',
            bot: o.bot ?? false,
        },
        webhookId: o.webhookId ?? null,
        type: o.type ?? MessageType.Default,
        content: o.content ?? `message ${id}`,
        attachments: new Map(
            Array.from({ length: o.attachments ?? 0 }, (_, i) => [`a${i}`, {}])
        ),
        embeds: Array.from({ length: o.embeds ?? 0 }, () => ({})),
        stickers: new Map(
            Array.from({ length: o.stickers ?? 0 }, (_, i) => [`s${i}`, {}])
        ),
    };
}

/** A Fluxer-looking message (stickers are an array there). */
function fluxerMessage(id: string, o: FakeMessageOptions = {}) {
    return {
        id,
        createdAt: NOW,
        author: {
            id: o.authorId ?? 'user-1',
            username: o.username ?? 'alice',
            bot: o.bot ?? false,
        },
        webhookId: o.webhookId ?? null,
        type: o.type ?? FluxerMessageType.Default,
        content: o.content ?? `message ${id}`,
        attachments: new Map(
            Array.from({ length: o.attachments ?? 0 }, (_, i) => [`a${i}`, {}])
        ),
        embeds: Array.from({ length: o.embeds ?? 0 }, () => ({})),
        stickers: Array.from({ length: o.stickers ?? 0 }, () => ({})),
    };
}

function makeChannel(history: { id: string }[]) {
    const fetch = vi.fn(async () => new Map(history.map((m) => [m.id, m])));
    return { id: 'chan', messages: { fetch }, fetch };
}

const payload: WebhookMessageData = {
    content: 'hi',
    username: 'alice',
    avatarURL: '',
};

describe('toDiscordHistoryItem', () => {
    it('maps the fields the transfer decides on', () => {
        const item = toDiscordHistoryItem(
            discordMessage('1', {
                authorId: 'u',
                username: 'Alice',
                bot: true,
                webhookId: 'wh',
                content: 'hello',
            }) as never
        );
        expect(item).toMatchObject({
            id: '1',
            createdAt: NOW,
            authorId: 'u',
            authorName: 'Alice',
            authorIsBot: true,
            webhookId: 'wh',
            isSystem: false,
            isEmpty: false,
            isCommand: false,
        });
        expect(item.raw.id).toBe('1');
    });

    it('treats everything but plain messages and replies as system messages', () => {
        const plain = toDiscordHistoryItem(discordMessage('1') as never);
        const reply = toDiscordHistoryItem(
            discordMessage('2', { type: MessageType.Reply }) as never
        );
        const join = toDiscordHistoryItem(
            discordMessage('3', { type: MessageType.UserJoin }) as never
        );
        const thread = toDiscordHistoryItem(
            discordMessage('4', { type: MessageType.ThreadCreated }) as never
        );
        const pin = toDiscordHistoryItem(
            discordMessage('5', {
                type: MessageType.ChannelPinnedMessage,
            }) as never
        );
        expect(
            [plain, reply, join, thread, pin].map((i) => i.isSystem)
        ).toEqual([false, false, true, true, true]);
    });

    it('is empty only without content, attachments, embeds and stickers', () => {
        const empty = (o: FakeMessageOptions) =>
            toDiscordHistoryItem(
                discordMessage('1', { content: '', ...o }) as never
            ).isEmpty;
        expect(empty({})).toBe(true);
        expect(empty({ attachments: 1 })).toBe(false);
        expect(empty({ embeds: 1 })).toBe(false);
        expect(empty({ stickers: 1 })).toBe(false);
        expect(empty({ content: 'x' })).toBe(false);
    });

    it('recognises bot commands by the configured prefix', () => {
        expect(
            toDiscordHistoryItem(
                discordMessage('1', { content: '!b help' }) as never
            ).isCommand
        ).toBe(true);
        expect(
            toDiscordHistoryItem(
                discordMessage('1', { content: 'hello !b' }) as never
            ).isCommand
        ).toBe(false);
    });
});

describe('toFluxerHistoryItem', () => {
    it('maps the fields the transfer decides on', () => {
        const item = toFluxerHistoryItem(
            fluxerMessage('9', {
                authorId: 'u',
                username: 'Bob',
                webhookId: null,
                content: '',
                stickers: 1,
            }) as unknown as FluxerMessage
        );
        expect(item).toMatchObject({
            id: '9',
            authorId: 'u',
            authorName: 'Bob',
            authorIsBot: false,
            webhookId: null,
            isSystem: false,
            isEmpty: false,
            isCommand: false,
        });
    });

    it('flags system, empty and command messages', () => {
        const of = (o: FakeMessageOptions) =>
            toFluxerHistoryItem(
                fluxerMessage('1', o) as unknown as FluxerMessage
            );
        expect(of({ type: FluxerMessageType.UserJoin }).isSystem).toBe(true);
        expect(of({ type: FluxerMessageType.Reply }).isSystem).toBe(false);
        expect(of({ content: '' }).isEmpty).toBe(true);
        expect(of({ content: '', embeds: 1 }).isEmpty).toBe(false);
        expect(of({ content: '!b clean 3' }).isCommand).toBe(true);
    });
});

describe('DiscordHistorySource', () => {
    let linkService: FakeLinkService;
    let relay: {
        buildPayload: ReturnType<typeof vi.fn>;
        sendPayload: ReturnType<typeof vi.fn>;
    };
    let link: ReturnType<typeof makeChannelLink>;
    const client = {
        user: {
            id: 'bot',
            username: 'Bifröst',
            displayAvatarURL: () => 'https://example.invalid/bot.png',
        },
    } as unknown as DiscordClient;

    function makeSource(history: { id: string }[] = []) {
        const channel = makeChannel(history);
        const source = new DiscordHistorySource({
            client,
            channel: channel as never,
            link,
            guildLink,
            relay: relay as unknown as DiscordToFluxerMessageRelay,
            linkService: linkService.asLinkService(),
        });
        return { source, channel };
    }

    beforeEach(() => {
        linkService = new FakeLinkService();
        link = makeChannelLink({ discordChannelId: 'chan' });
        linkService.links.push(link);
        relay = {
            buildPayload: vi.fn().mockResolvedValue(payload),
            sendPayload: vi.fn().mockResolvedValue({ messageId: 'f-1' }),
        };
    });

    it('describes itself', () => {
        const { source } = makeSource();
        expect(source.platform).toBe('discord');
        expect(source.link).toBe(link);
        expect(source.guildLink).toBe(guildLink);
        expect(source.botUserId).toBe('bot');
        expect(source.digestIdentity()).toEqual({
            username: 'Bifröst',
            avatarURL: 'https://example.invalid/bot.png',
        });
    });

    it('falls back when the client has no user yet', () => {
        const source = new DiscordHistorySource({
            client: { user: null } as unknown as DiscordClient,
            channel: makeChannel([]) as never,
            link,
            guildLink,
            relay: relay as unknown as DiscordToFluxerMessageRelay,
            linkService: linkService.asLinkService(),
        });
        expect(source.botUserId).toBeNull();
        expect(source.digestIdentity()).toEqual({
            username: 'Bifröst',
            avatarURL: '',
        });
    });

    it('fetches pages before and after a message', async () => {
        const { source, channel } = makeSource([
            discordMessage('3'),
            discordMessage('2'),
        ]);
        const newest = await source.fetchBefore(undefined, 50);
        expect(channel.fetch).toHaveBeenLastCalledWith({ limit: 50 });
        expect(newest.map((i) => i.id)).toEqual(['3', '2']);

        await source.fetchBefore('3', 10);
        expect(channel.fetch).toHaveBeenLastCalledWith({
            limit: 10,
            before: '3',
        });

        await source.fetchAfter('1', 25);
        expect(channel.fetch).toHaveBeenLastCalledWith({
            limit: 25,
            after: '1',
        });
    });

    it('builds and sends payloads through the live relay', async () => {
        const { source } = makeSource();
        const item = toDiscordHistoryItem(discordMessage('1') as never);
        await expect(source.buildPayload(item)).resolves.toBe(payload);
        expect(relay.buildPayload).toHaveBeenCalledWith(item.raw, guildLink);
        await expect(source.send(payload)).resolves.toEqual({
            messageId: 'f-1',
        });
        expect(relay.sendPayload).toHaveBeenCalledWith(link, payload);
    });

    it('knows which messages are bridged and records new links', async () => {
        const { source } = makeSource();
        await expect(source.isBridged('1')).resolves.toBe(false);

        const item = toDiscordHistoryItem(
            discordMessage('1', { authorId: 'u-1' }) as never
        );
        await source.createMessageLink(item, 'f-1');
        await expect(source.isBridged('1')).resolves.toBe(true);
        expect(linkService.messageLinks[0]).toMatchObject({
            discordMessageId: '1',
            fluxerMessageId: 'f-1',
            guildLinkId: link.guildLinkId,
            channelLinkId: link.id,
            sourcePlatform: 'discord',
            sourceAuthorId: 'u-1',
        });

        // Webhook authors have nobody to ping.
        const viaWebhook = toDiscordHistoryItem(
            discordMessage('2', { authorId: 'u-2', webhookId: 'wh' }) as never
        );
        await source.createMessageLink(viaWebhook, 'f-2');
        expect(linkService.messageLinks[1].sourceAuthorId).toBeNull();
    });
});

describe('FluxerHistorySource', () => {
    let linkService: FakeLinkService;
    let relay: {
        buildPayload: ReturnType<typeof vi.fn>;
        sendPayload: ReturnType<typeof vi.fn>;
    };
    let link: ReturnType<typeof makeChannelLink>;
    const client = {
        user: {
            id: 'fbot',
            username: 'Bifröst',
            displayAvatarURL: () => 'https://example.invalid/fbot.png',
        },
    } as unknown as FluxerClient;

    function makeSource(history: { id: string }[] = []) {
        const channel = makeChannel(history);
        const source = new FluxerHistorySource({
            client,
            channel: channel as unknown as FluxerHistoryChannel,
            link,
            guildLink,
            relay: relay as unknown as FluxerToDiscordMessageRelay,
            linkService: linkService.asLinkService(),
        });
        return { source, channel };
    }

    beforeEach(() => {
        linkService = new FakeLinkService();
        link = makeChannelLink({ fluxerChannelId: 'chan' });
        linkService.links.push(link);
        relay = {
            buildPayload: vi.fn().mockResolvedValue(payload),
            sendPayload: vi.fn().mockResolvedValue({ messageId: 'd-1' }),
        };
    });

    it('describes itself', () => {
        const { source } = makeSource();
        expect(source.platform).toBe('fluxer');
        expect(source.botUserId).toBe('fbot');
        expect(source.digestIdentity()).toEqual({
            username: 'Bifröst',
            avatarURL: 'https://example.invalid/fbot.png',
        });
    });

    it('fetches pages before and after a message', async () => {
        const { source, channel } = makeSource([fluxerMessage('3')]);
        await source.fetchBefore(undefined, 100);
        expect(channel.fetch).toHaveBeenLastCalledWith({ limit: 100 });
        await source.fetchBefore('3', 10);
        expect(channel.fetch).toHaveBeenLastCalledWith({
            limit: 10,
            before: '3',
        });
        const after = await source.fetchAfter('1', 25);
        expect(channel.fetch).toHaveBeenLastCalledWith({
            limit: 25,
            after: '1',
        });
        expect(after.map((i) => i.id)).toEqual(['3']);
    });

    it('builds and sends payloads through the live relay', async () => {
        const { source } = makeSource();
        const item = toFluxerHistoryItem(
            fluxerMessage('1') as unknown as FluxerMessage
        );
        await expect(source.buildPayload(item)).resolves.toBe(payload);
        expect(relay.buildPayload).toHaveBeenCalledWith(item.raw, guildLink);
        await expect(source.send(payload)).resolves.toEqual({
            messageId: 'd-1',
        });
        expect(relay.sendPayload).toHaveBeenCalledWith(link, payload);
    });

    it('knows which messages are bridged and records new links with the sides swapped', async () => {
        const { source } = makeSource();
        await expect(source.isBridged('1')).resolves.toBe(false);

        const item = toFluxerHistoryItem(
            fluxerMessage('1', { authorId: 'u-1' }) as unknown as FluxerMessage
        );
        await source.createMessageLink(item, 'd-1');
        await expect(source.isBridged('1')).resolves.toBe(true);
        expect(linkService.messageLinks[0]).toMatchObject({
            discordMessageId: 'd-1',
            fluxerMessageId: '1',
            guildLinkId: link.guildLinkId,
            channelLinkId: link.id,
            sourcePlatform: 'fluxer',
            sourceAuthorId: 'u-1',
        });

        const viaWebhook = toFluxerHistoryItem(
            fluxerMessage('2', { webhookId: 'wh' }) as unknown as FluxerMessage
        );
        await source.createMessageLink(viaWebhook, 'd-2');
        expect(linkService.messageLinks[1].sourceAuthorId).toBeNull();
    });
});
