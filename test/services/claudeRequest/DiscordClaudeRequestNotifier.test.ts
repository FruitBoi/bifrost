import { describe, expect, it, vi } from 'vitest';
import { Client, Message } from 'discord.js';
import DiscordClaudeRequestNotifier from '../../../src/services/claudeRequest/DiscordClaudeRequestNotifier';
import { ClaudeRequestNotifyError } from '../../../src/services/claudeRequest/ClaudeRequestNotifier';
import { ClaudeRequest } from '../../../src/db/entities/ClaudeRequest';
import { EmbedColors } from '../../../src/utils/embeds';

const request: ClaudeRequest = {
    id: 3,
    platform: 'discord',
    issueNumber: 26,
    issueUrl: 'https://github.com/owner/bifrost/issues/26',
    title: 'Notify [requesters] on completion',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'chan-1',
    messageId: 'msg-1',
    attempts: 0,
    createdAt: new Date('2026-10-20T11:00:00Z'),
};

function makeChannel(
    overrides: Partial<{
        isTextBased: boolean;
        isDMBased: boolean;
        isSendable: boolean;
        send: ReturnType<typeof vi.fn>;
    }> = {}
) {
    return {
        isTextBased: () => overrides.isTextBased ?? true,
        isDMBased: () => overrides.isDMBased ?? false,
        isSendable: () => overrides.isSendable ?? true,
        send: overrides.send ?? vi.fn().mockResolvedValue({ id: 'notice-1' }),
    };
}

function makeNotifier(
    fetch: ReturnType<typeof vi.fn>,
    relayNotice: ((notice: Message) => Promise<void>) | null = null
) {
    const client = { channels: { fetch } } as unknown as Client;
    return new DiscordClaudeRequestNotifier(client, relayNotice);
}

/** A Discord REST error as a plain object (the notifier duck-types it). */
function apiError(code: number) {
    return Object.assign(new Error(`Discord error ${code}`), { code });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected the promise to reject');
}

describe('DiscordClaudeRequestNotifier', () => {
    it('replies to the invoking message with a ping and a completed embed', async () => {
        const channel = makeChannel();
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );

        expect(channel.send).toHaveBeenCalledTimes(1);
        const payload = channel.send.mock.calls[0][0];
        expect(payload.content).toContain('<@user-1>');
        expect(payload.allowedMentions).toEqual({
            parse: [],
            users: ['user-1'],
        });
        expect(payload.reply).toEqual({
            messageReference: 'msg-1',
            failIfNotExists: false,
        });
        expect(payload.embeds).toHaveLength(1);
        const embed = payload.embeds[0].data;
        expect(embed.title).toBe('Claude request implemented');
        expect(embed.description).toContain(
            '[#26 Notify requesters on completion](https://github.com/owner/bifrost/issues/26)'
        );
        expect(embed.description).toContain('has been implemented');
        expect(embed.color).toBe(EmbedColors.Success);
    });

    it('resolves null when Discord does not hand back the message', async () => {
        const channel = makeChannel({
            send: vi.fn().mockResolvedValue(undefined),
        });
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        await expect(notifier.notify(request, 'completed')).resolves.toBeNull();
    });

    it('sends a plain message when there is no invoking message', async () => {
        const channel = makeChannel();
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        await notifier.notify({ ...request, messageId: null }, 'completed');

        expect(channel.send.mock.calls[0][0].reply).toBeUndefined();
    });

    it('says the request was closed without being implemented for not_planned', async () => {
        const channel = makeChannel();
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        await notifier.notify(request, 'not_planned');

        const embed = channel.send.mock.calls[0][0].embeds[0].data;
        expect(embed.title).toBe('Claude request closed');
        expect(embed.description).toContain('without being implemented');
        expect(embed.color).toBe(EmbedColors.Warning);
    });

    it.each([10003, 50001, 50013, 10004])(
        'treats Discord error %i on fetch as permanent',
        async (code) => {
            const notifier = makeNotifier(
                vi.fn().mockRejectedValue(apiError(code))
            );

            const err = await failure(notifier.notify(request, 'completed'));

            expect(err).toBeInstanceOf(ClaudeRequestNotifyError);
            expect((err as ClaudeRequestNotifyError).permanent).toBe(true);
            expect((err as Error).message).toContain(String(code));
        }
    );

    it('rethrows network errors on fetch unchanged (transient)', async () => {
        const network = new Error('ECONNRESET');
        const notifier = makeNotifier(vi.fn().mockRejectedValue(network));

        const err = await failure(notifier.notify(request, 'completed'));

        expect(err).toBe(network);
    });

    it.each([
        ['missing', null],
        ['not text-based', makeChannel({ isTextBased: false })],
        ['a DM', makeChannel({ isDMBased: true })],
        ['not sendable', makeChannel({ isSendable: false })],
    ])('fails permanently when the channel is %s', async (_label, channel) => {
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        const err = await failure(notifier.notify(request, 'completed'));

        expect(err).toBeInstanceOf(ClaudeRequestNotifyError);
        expect((err as ClaudeRequestNotifyError).permanent).toBe(true);
        if (channel) expect(channel.send).not.toHaveBeenCalled();
    });

    it.each([50013, 50001, 10003, 50007, 50035])(
        'treats Discord error %i on send as permanent',
        async (code) => {
            const channel = makeChannel({
                send: vi.fn().mockRejectedValue(apiError(code)),
            });
            const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

            const err = await failure(notifier.notify(request, 'completed'));

            expect(err).toBeInstanceOf(ClaudeRequestNotifyError);
            expect((err as ClaudeRequestNotifyError).permanent).toBe(true);
        }
    );

    it('rethrows transient send failures unchanged', async () => {
        const network = new Error('ETIMEDOUT');
        const channel = makeChannel({
            send: vi.fn().mockRejectedValue(network),
        });
        const notifier = makeNotifier(vi.fn().mockResolvedValue(channel));

        const err = await failure(notifier.notify(request, 'completed'));

        expect(err).toBe(network);
    });

    it('hands the sent notice to the relay hook', async () => {
        const channel = makeChannel();
        const relay = vi.fn().mockResolvedValue(undefined);
        const notifier = makeNotifier(
            vi.fn().mockResolvedValue(channel),
            relay
        );

        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );

        expect(relay).toHaveBeenCalledTimes(1);
        expect(relay).toHaveBeenCalledWith({ id: 'notice-1' });
    });

    it('still resolves the ID when the relay hook rejects', async () => {
        const channel = makeChannel();
        const relay = vi.fn().mockRejectedValue(new Error('bridge down'));
        const notifier = makeNotifier(
            vi.fn().mockResolvedValue(channel),
            relay
        );

        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it('does not call the relay hook when the send fails', async () => {
        const channel = makeChannel({
            send: vi.fn().mockRejectedValue(apiError(50013)),
        });
        const relay = vi.fn().mockResolvedValue(undefined);
        const notifier = makeNotifier(
            vi.fn().mockResolvedValue(channel),
            relay
        );

        await failure(notifier.notify(request, 'completed'));

        expect(relay).not.toHaveBeenCalled();
    });
});
