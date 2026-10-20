import { describe, expect, it, vi } from 'vitest';
import {
    Client as FluxerClient,
    Webhook as FluxerWebhook,
} from '@fluxerjs/core';
import { WebhookService } from '../../src/services/WebhookService';

function fakeFluxerClient() {
    const post = vi.fn(async () => ({
        id: 'sent-1',
        channel_id: 'fthread',
        author: { id: 'wh', username: 'webhook', discriminator: '0' },
        content: 'hi',
        timestamp: new Date().toISOString(),
        attachments: [],
        embeds: [],
    }));
    const patch = vi.fn(async () => ({}));
    const client = {
        rest: { post, patch },
        getOrCreateUser: (u: unknown) => u ?? null,
        channels: { get: () => null, resolve: () => null },
        guilds: { get: () => null, resolve: () => null },
        instance: { endpoints: { media: 'https://media.example' } },
    };
    return { client: client as unknown as FluxerClient, post, patch };
}

const data = { content: 'hi', username: 'u', avatarURL: '' };

describe('WebhookService Fluxer thread targeting', () => {
    it('posts into the thread via ?thread_id on the execute route', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        const result = await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            data,
            'fthread'
        );

        expect(post).toHaveBeenCalledTimes(1);
        const [route, options] = post.mock.calls[0] as unknown as [
            string,
            { body: Record<string, unknown>; auth: boolean },
        ];
        expect(route).toMatch(/^\/webhooks\/wh1\/tok\?/);
        expect(route).toContain('wait=true');
        expect(route).toContain('thread_id=fthread');
        expect(options.auth).toBe(false);
        expect(options.body).toMatchObject({ content: 'hi', username: 'u' });
        expect(result).toEqual({ messageId: 'sent-1' });
    });

    it('posts to the plain execute route when no thread is given', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().sendMessageViaFluxerWebhook(webhook, data);

        const [route] = post.mock.calls[0] as unknown as [string];
        expect(route).toBe('/webhooks/wh1/tok?wait=true');
    });

    it('does not leak the thread id into later sends through the same webhook', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');
        const service = new WebhookService();

        await service.sendMessageViaFluxerWebhook(webhook, data, 'fthread');
        await service.sendMessageViaFluxerWebhook(webhook, data);

        const [, second] = post.mock.calls as unknown as [string][];
        expect(second[0]).not.toContain('thread_id');
    });

    it('edits with ?thread_id when a thread is given', async () => {
        const { client, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().editMessageViaFluxerWebhook(
            webhook,
            'm1',
            data,
            'fthread'
        );
        await new WebhookService().editMessageViaFluxerWebhook(
            webhook,
            'm1',
            data
        );

        const [withThread, without] = patch.mock.calls as unknown as [string][];
        expect(withThread[0]).toBe(
            '/webhooks/wh1/tok/messages/m1?thread_id=fthread'
        );
        expect(without[0]).toBe('/webhooks/wh1/tok/messages/m1');
    });
});
