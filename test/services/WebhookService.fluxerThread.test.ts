import { describe, expect, it, vi } from 'vitest';
import {
    Client as FluxerClient,
    Webhook as FluxerWebhook,
} from '@fluxerjs/core';
import { WebhookClient } from 'discord.js';
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

describe('WebhookService Fluxer allowed mentions', () => {
    it('whitelists only mentionUserIds on send, with no everyone/role parsing', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            ...data,
            content: '<@u1> @everyone hi',
            mentionUserIds: ['u1'],
        });

        const [, options] = post.mock.calls[0] as unknown as [
            string,
            { body: Record<string, unknown> },
        ];
        expect(options.body.allowed_mentions).toEqual({
            parse: [],
            users: ['u1'],
        });
    });

    it('whitelists only mentionUserIds on edit, with no everyone/role parsing', async () => {
        const { client, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().editMessageViaFluxerWebhook(webhook, 'm1', {
            ...data,
            mentionUserIds: ['u1', 'u2'],
        });

        const [, options] = patch.mock.calls[0] as unknown as [
            string,
            { body: Record<string, unknown> },
        ];
        expect(options.body.allowed_mentions).toEqual({
            parse: [],
            users: ['u1', 'u2'],
        });
    });

    it('sends no allowed_mentions at all when mentionUserIds is absent or empty', async () => {
        const { client, post, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');
        const service = new WebhookService();

        await service.sendMessageViaFluxerWebhook(webhook, data);
        await service.sendMessageViaFluxerWebhook(webhook, {
            ...data,
            mentionUserIds: [],
        });
        await service.editMessageViaFluxerWebhook(webhook, 'm1', data);

        for (const call of [...post.mock.calls, ...patch.mock.calls]) {
            const [, options] = call as unknown as [
                string,
                { body: Record<string, unknown> },
            ];
            expect('allowed_mentions' in options.body).toBe(false);
        }
    });
});

function fakeDiscordWebhook() {
    const send = vi.fn(async () => ({ id: 'd-sent-1' }));
    const editMessage = vi.fn(async () => ({}));
    return {
        webhook: { send, editMessage } as unknown as WebhookClient,
        send,
        editMessage,
    };
}

describe('WebhookService Discord allowed mentions', () => {
    it('whitelists only mentionUserIds on send and edit', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();
        const payload = { ...data, mentionUserIds: ['u1'] };

        const result = await service.sendMessageViaDiscordWebhook(
            webhook,
            payload
        );
        await service.editMessageViaDiscordWebhook(webhook, 'm1', payload);

        expect(result).toEqual({ messageId: 'd-sent-1' });
        expect(send.mock.calls[0]![0]).toMatchObject({
            content: 'hi',
            allowedMentions: { users: ['u1'] },
        });
        expect(editMessage.mock.calls[0]![1]).toMatchObject({
            allowedMentions: { users: ['u1'] },
        });
    });

    it('passes no allowedMentions when mentionUserIds is absent', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();

        await service.sendMessageViaDiscordWebhook(webhook, data);
        await service.editMessageViaDiscordWebhook(webhook, 'm1', data);

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(sent.allowedMentions).toBeUndefined();
        expect(edited.allowedMentions).toBeUndefined();
    });
});
