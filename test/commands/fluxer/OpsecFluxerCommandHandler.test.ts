import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, Message } from '@fluxerjs/core';
import OpsecFluxerCommandHandler from '../../../src/commands/fluxer/handlers/OpsecFluxerCommandHandler';
import OpsecService from '../../../src/services/opsec/OpsecService';

function setup({ bot = false, guildId = 'guild-1' as string | null } = {}) {
    const service = new OpsecService();
    const log: string[] = [];
    const send = vi.fn(async (_id: string, opts: { content: string }) => ({
        id: `sent-${log.length}`,
        content: opts.content,
    }));
    const client = { channels: { send } } as unknown as Client;
    const relay = vi.fn(async (sent: Message) => {
        log.push(
            `${sent.content.includes('has ended') ? 'end' : 'start'}:${service.isActive('chan-1')}`
        );
    });
    const sendToDiscord = vi.fn<
        (source: Message, content: string) => Promise<void>
    >(async () => {
        log.push(`discord-start:${service.isActive('chan-1')}`);
    });
    const handler = new OpsecFluxerCommandHandler(
        client,
        service,
        relay,
        sendToDiscord
    );
    const reply = vi.fn().mockResolvedValue({ id: 'r' });
    const message = {
        id: '1',
        channelId: 'chan-1',
        guildId,
        author: { id: 'a', bot, username: 'a' },
        reply,
    } as unknown as Message;
    return {
        service,
        log,
        send,
        relay,
        sendToDiscord,
        handler,
        reply,
        message,
    };
}

describe('OpsecFluxerCommandHandler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends the start message to Discord only before pausing, bridges the end message after', async () => {
        const { service, log, handler, message, send, sendToDiscord, reply } =
            setup();
        await handler.handleCommand(message, 'opsec', 'on', '10');
        expect(log).toEqual(['discord-start:false']);
        expect(sendToDiscord.mock.calls[0][0]).toBe(message);
        expect(sendToDiscord.mock.calls[0][1]).toContain('Mr. Thiel');
        expect(send).not.toHaveBeenCalled();
        expect(reply.mock.calls[0][0].embeds[0].data.description).toContain(
            'has started'
        );
        expect(service.isActive('chan-1')).toBe(true);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(log).toEqual(['discord-start:false', 'end:false']);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('off ends the session and posts the end message', async () => {
        const { service, log, handler, message } = setup();
        await handler.handleCommand(message, 'opsex', 'on');
        await handler.handleCommand(message, 'opsex', 'off');
        await vi.advanceTimersByTimeAsync(0);
        expect(service.isActive('chan-1')).toBe(false);
        expect(log).toEqual(['discord-start:false', 'end:false']);
    });

    it('off when inactive says so', async () => {
        const { handler, message, reply, send } = setup();
        await handler.handleCommand(message, 'opsec', 'off');
        expect(reply.mock.calls[0][0].embeds[0].data.description).toContain(
            'No sex session'
        );
        expect(send).not.toHaveBeenCalled();
    });

    it('on while active extends without bridging', async () => {
        const { handler, message, reply, relay, sendToDiscord } = setup();
        await handler.handleCommand(message, 'opsec', 'on', '5');
        await handler.handleCommand(message, 'opsec', 'on', '20');
        expect(sendToDiscord).toHaveBeenCalledTimes(1);
        expect(relay).not.toHaveBeenCalled();
        expect(reply.mock.calls[1][0].embeds[0].data.description).toContain(
            'extended'
        );
    });

    it('still pauses when sending the start to Discord fails', async () => {
        const { service, sendToDiscord, handler, message } = setup();
        sendToDiscord.mockRejectedValueOnce(new Error('down'));
        await handler.handleCommand(message, 'opsec', 'on');
        expect(service.isActive('chan-1')).toBe(true);
    });

    it('reports status and invalid input', async () => {
        const { handler, message, reply } = setup();
        await handler.handleCommand(message, 'opsec');
        expect(reply.mock.calls[0][0].embeds[0].data.description).toContain(
            'No sex session'
        );
        await handler.handleCommand(message, 'opsec', 'on', 'nope');
        expect(reply.mock.calls[1][0].embeds[0].data.description).toContain(
            'Usage'
        );
    });

    it('refuses bots and non-server messages', async () => {
        const bot = setup({ bot: true });
        await bot.handler.handleCommand(bot.message, 'opsec', 'on');
        expect(bot.service.isActive('chan-1')).toBe(false);
        expect(bot.reply).toHaveBeenCalledTimes(1);

        const dm = setup({ guildId: null });
        await dm.handler.handleCommand(dm.message, 'opsec', 'on');
        expect(dm.service.isActive('chan-1')).toBe(false);
        expect(dm.reply.mock.calls[0][0].embeds[0].data.description).toContain(
            'server'
        );
    });
});
