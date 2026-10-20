import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, EmbedBuilder, ErrorCodes, FluxerError } from '@fluxerjs/core';
import FluxerReminderDeliverer, {
    isPermanentFluxerDeliveryError,
} from '../../../src/services/reminders/FluxerReminderDeliverer';
import { ReminderDeliveryError } from '../../../src/services/reminders/ReminderDeliverer';
import { Reminder } from '../../../src/db/entities/Reminder';

const reminder: Reminder = {
    id: 7,
    platform: 'fluxer',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'chan-1',
    message: 'water the plants',
    dueAt: new Date('2026-10-20T12:00:00Z'),
    attempts: 0,
    createdAt: new Date('2026-10-20T11:00:00Z'),
};

/** Mirrors the fields of @fluxerjs/rest's FluxerAPIError that we look at. */
class FakeApiError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string
    ) {
        super(`${statusCode} ${code}`);
    }
}

function makeClient() {
    const send = vi.fn().mockResolvedValue({});
    return {
        send,
        client: { channels: { send } } as unknown as Client,
    };
}

describe('FluxerReminderDeliverer', () => {
    let send: ReturnType<typeof vi.fn>;
    let deliverer: FluxerReminderDeliverer;

    beforeEach(() => {
        const made = makeClient();
        send = made.send;
        deliverer = new FluxerReminderDeliverer(made.client);
    });

    it('posts a ping line plus an embed, mentioning only the user', async () => {
        await deliverer.deliver(reminder);

        expect(send).toHaveBeenCalledTimes(1);
        const [channelId, payload] = send.mock.calls[0] as [
            string,
            {
                content: string;
                embeds: EmbedBuilder[];
                allowedMentions: { parse: string[]; users: string[] };
            },
        ];
        expect(channelId).toBe('chan-1');
        expect(payload.content).toBe('**Reminder** for <@user-1>');
        expect(payload.embeds).toHaveLength(1);
        expect(payload.embeds[0].data.title).toBe('Reminder from Bifröst');
        expect(payload.embeds[0].data.description).toBe('water the plants');
        expect(payload.allowedMentions).toEqual({
            parse: [],
            users: ['user-1'],
        });
    });

    it.each([404, 403])(
        'treats an HTTP %i from the API as a permanent failure',
        async (status) => {
            const cause = new FakeApiError(
                status,
                status === 404 ? 'UNKNOWN_CHANNEL' : 'MISSING_ACCESS'
            );
            send.mockRejectedValueOnce(cause);

            const err = await deliverer.deliver(reminder).catch((e) => e);
            expect(err).toBeInstanceOf(ReminderDeliveryError);
            expect((err as ReminderDeliveryError).permanent).toBe(true);
            expect((err as { cause?: unknown }).cause).toBe(cause);
        }
    );

    it('treats a plain { status: 404 } object as permanent', async () => {
        send.mockRejectedValueOnce({ status: 404 });
        const err = await deliverer.deliver(reminder).catch((e) => e);
        expect(err).toBeInstanceOf(ReminderDeliveryError);
        expect((err as ReminderDeliveryError).permanent).toBe(true);
    });

    it('treats CHANNEL_NOT_FOUND from the client as permanent', async () => {
        send.mockRejectedValueOnce(
            new FluxerError('Channel chan-1 not found', {
                code: ErrorCodes.ChannelNotFound,
            })
        );
        const err = await deliverer.deliver(reminder).catch((e) => e);
        expect(err).toBeInstanceOf(ReminderDeliveryError);
        expect((err as ReminderDeliveryError).permanent).toBe(true);
    });

    it('rethrows network errors unchanged', async () => {
        const cause = new Error('ECONNRESET');
        send.mockRejectedValueOnce(cause);
        await expect(deliverer.deliver(reminder)).rejects.toBe(cause);
    });

    it.each([503, 429])('rethrows an HTTP %i unchanged', async (status) => {
        const cause = new FakeApiError(
            status,
            status === 429 ? 'RATE_LIMITED' : 'INTERNAL_SERVER_ERROR'
        );
        send.mockRejectedValueOnce(cause);
        await expect(deliverer.deliver(reminder)).rejects.toBe(cause);
    });
});

describe('isPermanentFluxerDeliveryError', () => {
    it.each([
        [{ statusCode: 404 }, true],
        [{ statusCode: 403 }, true],
        [{ status: 403 }, true],
        [{ code: 'CHANNEL_NOT_FOUND' }, true],
        [{ code: 'CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL' }, true],
        [{ statusCode: 500 }, false],
        [{ statusCode: 429, code: 'RATE_LIMITED' }, false],
        [{ code: 'IP_BANNED' }, false],
        [new Error('boom'), false],
        [null, false],
        ['nope', false],
    ])('classifies %o as permanent=%s', (err, expected) => {
        expect(isPermanentFluxerDeliveryError(err)).toBe(expected);
    });
});
