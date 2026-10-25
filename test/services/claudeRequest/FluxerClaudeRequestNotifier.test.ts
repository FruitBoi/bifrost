import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Client,
    EmbedBuilder,
    ErrorCodes,
    FluxerError,
    Message,
} from '@fluxerjs/core';
import FluxerClaudeRequestNotifier from '../../../src/services/claudeRequest/FluxerClaudeRequestNotifier';
import {
    ClaudeRequestNotifyError,
    sanitizeIssueTitle,
} from '../../../src/services/claudeRequest/ClaudeRequestNotifier';
import { ClaudeRequest } from '../../../src/db/entities/ClaudeRequest';
import { EmbedColors } from '../../../src/utils/embeds';

const request: ClaudeRequest = {
    id: 3,
    platform: 'fluxer',
    issueNumber: 26,
    issueUrl: 'https://github.com/owner/bifrost/issues/26',
    title: 'Notify on completion',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'chan-1',
    messageId: 'msg-1',
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

interface SentPayload {
    content: string;
    embeds: EmbedBuilder[];
    allowedMentions: { parse: string[]; users: string[] };
    replyTo?: { channelId: string; messageId: string; guildId?: string };
}

describe('FluxerClaudeRequestNotifier', () => {
    let send: ReturnType<typeof vi.fn>;
    let notifier: FluxerClaudeRequestNotifier;

    beforeEach(() => {
        send = vi.fn().mockResolvedValue({ id: 'notice-1' });
        notifier = new FluxerClaudeRequestNotifier({
            channels: { send },
        } as unknown as Client);
    });

    it('replies to the invoking message with a ping and a completed embed', async () => {
        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );

        expect(send).toHaveBeenCalledTimes(1);
        const [channelId, payload] = send.mock.calls[0] as [
            string,
            SentPayload,
        ];
        expect(channelId).toBe('chan-1');
        expect(payload.content).toContain('<@user-1>');
        expect(payload.allowedMentions).toEqual({
            parse: [],
            users: ['user-1'],
        });
        expect(payload.replyTo).toEqual({
            channelId: 'chan-1',
            messageId: 'msg-1',
            guildId: 'guild-1',
        });
        expect(payload.embeds).toHaveLength(1);
        expect(payload.embeds[0].data.title).toBe('Claude request implemented');
        expect(payload.embeds[0].data.description).toContain(
            '[#26 Notify on completion](https://github.com/owner/bifrost/issues/26)'
        );
        expect(payload.embeds[0].data.color).toBe(EmbedColors.Success);
    });

    it('resolves null when the sent message has no ID', async () => {
        send.mockResolvedValue({});
        await expect(notifier.notify(request, 'completed')).resolves.toBeNull();
    });

    it('sends without a reply when there is no invoking message', async () => {
        await expect(
            notifier.notify({ ...request, messageId: null }, 'not_planned')
        ).resolves.toBe('notice-1');

        expect(send).toHaveBeenCalledTimes(1);
        const payload = send.mock.calls[0][1] as SentPayload;
        expect(payload.replyTo).toBeUndefined();
        expect(payload.embeds[0].data.title).toBe('Claude request closed');
        expect(payload.embeds[0].data.description).toContain(
            'without being implemented'
        );
        expect(payload.embeds[0].data.color).toBe(EmbedColors.Warning);
    });

    it('falls back to a plain message when the reply is rejected', async () => {
        send.mockRejectedValueOnce(new FakeApiError(400, 'UNKNOWN_MESSAGE'));
        send.mockResolvedValueOnce({ id: 'notice-2' });

        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-2'
        );

        expect(send).toHaveBeenCalledTimes(2);
        expect((send.mock.calls[0][1] as SentPayload).replyTo).toBeDefined();
        expect((send.mock.calls[1][1] as SentPayload).replyTo).toBeUndefined();
    });

    it('does not fall back on network errors', async () => {
        const cause = new Error('ECONNRESET');
        send.mockRejectedValueOnce(cause);
        await expect(notifier.notify(request, 'completed')).rejects.toBe(cause);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it.each([404, 403])(
        'treats an HTTP %i on the plain send as permanent',
        async (status) => {
            const cause = new FakeApiError(
                status,
                status === 404 ? 'UNKNOWN_CHANNEL' : 'MISSING_ACCESS'
            );
            send.mockRejectedValue(cause);

            const err = await notifier
                .notify(request, 'completed')
                .catch((e) => e);
            expect(err).toBeInstanceOf(ClaudeRequestNotifyError);
            expect((err as ClaudeRequestNotifyError).permanent).toBe(true);
            expect((err as { cause?: unknown }).cause).toBe(cause);
        }
    );

    it('treats CHANNEL_NOT_FOUND from the client as permanent', async () => {
        send.mockRejectedValueOnce(
            new FluxerError('Channel chan-1 not found', {
                code: ErrorCodes.ChannelNotFound,
            })
        );
        const err = await notifier.notify(request, 'completed').catch((e) => e);
        expect(err).toBeInstanceOf(ClaudeRequestNotifyError);
        expect((err as ClaudeRequestNotifyError).permanent).toBe(true);
    });

    it.each([503, 429])('rethrows an HTTP %i unchanged', async (status) => {
        const cause = new FakeApiError(
            status,
            status === 429 ? 'RATE_LIMITED' : 'INTERNAL_SERVER_ERROR'
        );
        send.mockRejectedValueOnce(cause);
        await expect(notifier.notify(request, 'completed')).rejects.toBe(cause);
    });
});

describe('FluxerClaudeRequestNotifier relay hook', () => {
    let send: ReturnType<typeof vi.fn>;
    let relay: ReturnType<typeof vi.fn>;
    let notifier: FluxerClaudeRequestNotifier;

    beforeEach(() => {
        send = vi.fn().mockResolvedValue({ id: 'notice-1' });
        relay = vi.fn().mockResolvedValue(undefined);
        notifier = new FluxerClaudeRequestNotifier(
            { channels: { send } } as unknown as Client,
            relay as (notice: Message) => Promise<void>
        );
    });

    it('hands the sent notice to the relay hook', async () => {
        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );
        expect(relay).toHaveBeenCalledTimes(1);
        expect(relay).toHaveBeenCalledWith({ id: 'notice-1' });
    });

    it('relays the notice sent by the plain-message retry', async () => {
        send.mockRejectedValueOnce(new FakeApiError(400, 'UNKNOWN_MESSAGE'));
        send.mockResolvedValueOnce({ id: 'notice-2' });

        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-2'
        );
        expect(relay).toHaveBeenCalledTimes(1);
        expect(relay).toHaveBeenCalledWith({ id: 'notice-2' });
    });

    it('still resolves the ID when the relay hook rejects', async () => {
        relay.mockRejectedValue(new Error('bridge down'));
        await expect(notifier.notify(request, 'completed')).resolves.toBe(
            'notice-1'
        );
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not call the relay hook when the send fails', async () => {
        send.mockRejectedValue(new FakeApiError(403, 'MISSING_ACCESS'));
        await notifier.notify(request, 'completed').catch((e) => e);
        expect(relay).not.toHaveBeenCalled();
    });
});

describe('sanitizeIssueTitle', () => {
    it('drops square brackets and collapses whitespace', () => {
        expect(sanitizeIssueTitle(' a [b]  c](x) ')).toBe('a b c(x)');
    });

    it('caps long titles', () => {
        const out = sanitizeIssueTitle('y'.repeat(300));
        expect(out.length).toBe(100);
        expect(out.endsWith('…')).toBe(true);
    });
});
