import { describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import DiscordReminderDeliverer from '../../../src/services/reminders/DiscordReminderDeliverer';
import { ReminderDeliveryError } from '../../../src/services/reminders/ReminderDeliverer';
import { Reminder } from '../../../src/db/entities/Reminder';

const reminder: Reminder = {
    id: 7,
    platform: 'discord',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'chan-1',
    message: 'take the pizza out',
    dueAt: new Date('2026-10-20T12:00:00Z'),
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
        send: overrides.send ?? vi.fn().mockResolvedValue(undefined),
    };
}

function makeDeliverer(fetch: ReturnType<typeof vi.fn>) {
    const client = { channels: { fetch } } as unknown as Client;
    return new DiscordReminderDeliverer(client);
}

/** A Discord REST error as a plain object (the deliverer duck-types it). */
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

describe('DiscordReminderDeliverer', () => {
    it('posts a ping and an embed, mentioning only the reminded user', async () => {
        const channel = makeChannel();
        const deliverer = makeDeliverer(vi.fn().mockResolvedValue(channel));

        await deliverer.deliver(reminder);

        expect(channel.send).toHaveBeenCalledTimes(1);
        const payload = channel.send.mock.calls[0][0];
        expect(payload.content).toBe('**Reminder** for <@user-1>');
        expect(payload.allowedMentions).toEqual({
            parse: [],
            users: ['user-1'],
        });
        expect(payload.embeds).toHaveLength(1);
        const embed = payload.embeds[0].data;
        expect(embed.title).toBe('Reminder from Bifröst');
        expect(embed.description).toBe('take the pizza out');
        expect(embed.timestamp).toBe('2026-10-20T12:00:00.000Z');
    });

    it.each([10003, 50001, 50013, 10004])(
        'treats Discord error %i on fetch as permanent',
        async (code) => {
            const deliverer = makeDeliverer(
                vi.fn().mockRejectedValue(apiError(code))
            );

            const err = await failure(deliverer.deliver(reminder));

            expect(err).toBeInstanceOf(ReminderDeliveryError);
            expect((err as ReminderDeliveryError).permanent).toBe(true);
            expect((err as Error).message).toContain(String(code));
        }
    );

    it('rethrows network errors on fetch unchanged (transient)', async () => {
        const network = new Error('ECONNRESET');
        const deliverer = makeDeliverer(vi.fn().mockRejectedValue(network));

        const err = await failure(deliverer.deliver(reminder));

        expect(err).toBe(network);
        expect(err).not.toBeInstanceOf(ReminderDeliveryError);
    });

    it('rethrows unknown Discord errors on fetch (transient)', async () => {
        const unknown = apiError(130000); // API resource overloaded
        const deliverer = makeDeliverer(vi.fn().mockRejectedValue(unknown));

        const err = await failure(deliverer.deliver(reminder));

        expect(err).toBe(unknown);
    });

    it.each([
        ['missing', null],
        ['not text-based', makeChannel({ isTextBased: false })],
        ['a DM', makeChannel({ isDMBased: true })],
        ['not sendable', makeChannel({ isSendable: false })],
    ])('fails permanently when the channel is %s', async (_label, channel) => {
        const deliverer = makeDeliverer(vi.fn().mockResolvedValue(channel));

        const err = await failure(deliverer.deliver(reminder));

        expect(err).toBeInstanceOf(ReminderDeliveryError);
        expect((err as ReminderDeliveryError).permanent).toBe(true);
        if (channel) expect(channel.send).not.toHaveBeenCalled();
    });

    it.each([50013, 50001, 10003, 50007, 50035])(
        'treats Discord error %i on send as permanent',
        async (code) => {
            const channel = makeChannel({
                send: vi.fn().mockRejectedValue(apiError(code)),
            });
            const deliverer = makeDeliverer(vi.fn().mockResolvedValue(channel));

            const err = await failure(deliverer.deliver(reminder));

            expect(err).toBeInstanceOf(ReminderDeliveryError);
            expect((err as ReminderDeliveryError).permanent).toBe(true);
        }
    );

    it('rethrows transient send failures unchanged', async () => {
        const network = new Error('ETIMEDOUT');
        const channel = makeChannel({
            send: vi.fn().mockRejectedValue(network),
        });
        const deliverer = makeDeliverer(vi.fn().mockResolvedValue(channel));

        const err = await failure(deliverer.deliver(reminder));

        expect(err).toBe(network);
    });
});
