import { describe, expect, it, vi } from 'vitest';
import { Client, Message } from '@fluxerjs/core';
import FishTradeFluxerCommandHandler from '../../../src/commands/fluxer/handlers/FishTradeFluxerCommandHandler';

const client = { user: { id: 'bot' } } as unknown as Client;

function makeMessage({ bot = false }: { bot?: boolean } = {}) {
    const sent = { id: 'reply-1' } as unknown as Message;
    const reply = vi.fn().mockResolvedValue(sent);
    const message = {
        id: '2000',
        content: '!fishtrade',
        channelId: 'chan-1',
        guildId: 'guild-1',
        author: { id: 'author', bot, username: 'author' },
        reply,
    };
    return { message: message as unknown as Message, reply, sent };
}

describe('FishTradeFluxerCommandHandler bridging (issue #42)', () => {
    it('relays the trading day reply', async () => {
        const relay = vi.fn().mockResolvedValue(undefined);
        const handler = new FishTradeFluxerCommandHandler(client, relay);
        const { message, reply, sent } = makeMessage();

        await handler.handleCommand(message, 'fishtrade', '-seed', '7');

        expect(reply).toHaveBeenCalledTimes(1);
        expect(reply.mock.calls[0][0].embeds[0].data.title).toBeTruthy();
        expect(relay).toHaveBeenCalledExactlyOnceWith(sent);
    });

    it('relays error replies too', async () => {
        const relay = vi.fn().mockResolvedValue(undefined);
        const handler = new FishTradeFluxerCommandHandler(client, relay);
        const { message, sent } = makeMessage();

        await handler.handleCommand(message, 'fishtrade', '-seed');

        expect(relay).toHaveBeenCalledExactlyOnceWith(sent);
    });

    it('relays the refusal for bots', async () => {
        const relay = vi.fn().mockResolvedValue(undefined);
        const handler = new FishTradeFluxerCommandHandler(client, relay);
        const { message, sent } = makeMessage({ bot: true });

        await handler.handleCommand(message, 'fishtrade');

        expect(relay).toHaveBeenCalledExactlyOnceWith(sent);
    });

    it('never fails the command when relaying fails', async () => {
        const relay = vi.fn().mockRejectedValue(new Error('webhook down'));
        const handler = new FishTradeFluxerCommandHandler(client, relay);
        const { message, reply } = makeMessage();

        await expect(
            handler.handleCommand(message, 'fishtrade', '-seed')
        ).resolves.toBeUndefined();
        expect(reply).toHaveBeenCalledTimes(1);
    });

    it('works without a relay hook', async () => {
        const handler = new FishTradeFluxerCommandHandler(client);
        const { message, reply } = makeMessage();

        await handler.handleCommand(message, 'fishtrade', '-seed');

        expect(reply).toHaveBeenCalledTimes(1);
    });
});
