import { describe, expect, it, vi } from 'vitest';
import {
    Client as FluxerClient,
    Webhook as FluxerWebhook,
} from '@fluxerjs/core';
import { WebhookClient } from 'discord.js';
import {
    WebhookMessageData,
    WebhookService,
} from '../../src/services/WebhookService';

type RestCall = [string, { body: Record<string, unknown>; auth?: boolean }];

function fakeFluxerClient() {
    const post = vi.fn(async () => ({
        id: 'sent-1',
        channel_id: 'fchan',
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

function fakeDiscordWebhook() {
    const send = vi.fn(async () => ({ id: 'd-sent-1' }));
    const editMessage = vi.fn(async () => ({}));
    return {
        webhook: { send, editMessage } as unknown as WebhookClient,
        send,
        editMessage,
    };
}

const base: WebhookMessageData = {
    content: 'hey <@&r1>',
    username: 'u',
    avatarURL: '',
};

const withRole: WebhookMessageData = { ...base, mentionRoleIds: ['r1'] };
const withBoth: WebhookMessageData = {
    ...base,
    content: '<@u1> hey <@&r1> <@&r2>',
    mentionUserIds: ['u1'],
    mentionRoleIds: ['r1', 'r2'],
};

describe('WebhookService Discord role pings', () => {
    it('whitelists the bridged roles on send without parsing everyone/here', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(
            webhook,
            withRole
        );

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.content).toBe('hey <@&r1>');
        expect(sent.allowedMentions).toEqual({
            parse: [],
            users: [],
            roles: ['r1'],
        });
    });

    it('whitelists users and roles together on send', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(
            webhook,
            withBoth
        );

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toEqual({
            parse: [],
            users: ['u1'],
            roles: ['r1', 'r2'],
        });
    });

    it('never re-pings a role on edit: the same data edits with no roles key', async () => {
        const { webhook, editMessage } = fakeDiscordWebhook();

        await new WebhookService().editMessageViaDiscordWebhook(
            webhook,
            'm1',
            withBoth
        );

        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(edited.content).toBe('<@u1> hey <@&r1> <@&r2>');
        expect(edited.allowedMentions).toEqual({ parse: [], users: ['u1'] });
        expect('roles' in (edited.allowedMentions as object)).toBe(false);
    });

    it('passes no allowedMentions on edit when only roles were whitelisted', async () => {
        const { webhook, editMessage } = fakeDiscordWebhook();

        await new WebhookService().editMessageViaDiscordWebhook(
            webhook,
            'm1',
            withRole
        );

        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(edited.content).toBe('hey <@&r1>');
        expect(edited.allowedMentions).toBeUndefined();
    });

    it('omits the roles key on send when mentionRoleIds is empty', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(webhook, {
            ...base,
            mentionUserIds: ['u1'],
            mentionRoleIds: [],
        });

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toEqual({ parse: [], users: ['u1'] });
        expect('roles' in (sent.allowedMentions as object)).toBe(false);
    });

    it('passes no allowedMentions at all when neither users nor roles are whitelisted', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();

        await service.sendMessageViaDiscordWebhook(webhook, {
            ...base,
            mentionUserIds: [],
            mentionRoleIds: [],
        });
        await service.editMessageViaDiscordWebhook(webhook, 'm1', base);

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(sent.allowedMentions).toBeUndefined();
        expect(edited.allowedMentions).toBeUndefined();
    });
});

describe('WebhookService Fluxer role pings', () => {
    it('whitelists the bridged roles on send without parsing everyone/here', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            withRole
        );

        expect(post).toHaveBeenCalledTimes(1);
        const [, options] = post.mock.calls[0] as unknown as RestCall;
        expect(options.body.content).toBe('hey <@&r1>');
        // @fluxerjs/core drops the empty users list when serialising.
        expect(options.body.allowed_mentions).toEqual({
            parse: [],
            roles: ['r1'],
        });
    });

    it('whitelists users and roles together on send', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().sendMessageViaFluxerWebhook(
            webhook,
            withBoth
        );

        const [, options] = post.mock.calls[0] as unknown as RestCall;
        expect(options.body.allowed_mentions).toEqual({
            parse: [],
            users: ['u1'],
            roles: ['r1', 'r2'],
        });
    });

    it('never re-pings a role on edit: the PATCH body has no roles key', async () => {
        const { client, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().editMessageViaFluxerWebhook(
            webhook,
            'm1',
            withBoth
        );

        expect(patch).toHaveBeenCalledTimes(1);
        const [route, options] = patch.mock.calls[0] as unknown as RestCall;
        expect(route).toBe('/webhooks/wh1/tok/messages/m1');
        expect(options.body.content).toBe('<@u1> hey <@&r1> <@&r2>');
        expect(options.body.allowed_mentions).toEqual({
            parse: [],
            users: ['u1'],
        });
        expect('roles' in (options.body.allowed_mentions as object)).toBe(
            false
        );
    });

    it('sends no allowed_mentions on edit when only roles were whitelisted', async () => {
        const { client, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().editMessageViaFluxerWebhook(
            webhook,
            'm1',
            withRole
        );

        const [, options] = patch.mock.calls[0] as unknown as RestCall;
        expect(options.body.content).toBe('hey <@&r1>');
        expect('allowed_mentions' in options.body).toBe(false);
    });

    it('sends no allowed_mentions at all when neither users nor roles are whitelisted', async () => {
        const { client, post, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');
        const service = new WebhookService();

        await service.sendMessageViaFluxerWebhook(webhook, {
            ...base,
            mentionUserIds: [],
            mentionRoleIds: [],
        });
        await service.editMessageViaFluxerWebhook(webhook, 'm1', {
            ...base,
            mentionUserIds: [],
            mentionRoleIds: [],
        });

        for (const call of [...post.mock.calls, ...patch.mock.calls]) {
            const [, options] = call as unknown as RestCall;
            expect('allowed_mentions' in options.body).toBe(false);
        }
    });
});

describe('WebhookService @everyone / @here pings', () => {
    const everyone: WebhookMessageData = {
        ...base,
        content: '@everyone hi',
        mentionEveryone: true,
    };

    it('parses everyone on a Discord send, even with no users or roles', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(
            webhook,
            everyone
        );

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toEqual({
            parse: ['everyone'],
            users: [],
        });
    });

    it('combines everyone with users and roles on a Discord send', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(webhook, {
            ...withBoth,
            mentionEveryone: true,
        });

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toEqual({
            parse: ['everyone'],
            users: ['u1'],
            roles: ['r1', 'r2'],
        });
    });

    it('never parses everyone on a Discord edit', async () => {
        const { webhook, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();

        await service.editMessageViaDiscordWebhook(webhook, 'm1', everyone);
        await service.editMessageViaDiscordWebhook(webhook, 'm1', {
            ...withBoth,
            mentionEveryone: true,
        });

        const alone = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        const mixed = editMessage.mock.calls[1]![1] as Record<string, unknown>;
        expect(alone.allowedMentions).toBeUndefined();
        expect(mixed.allowedMentions).toEqual({ parse: [], users: ['u1'] });
    });

    it('lets suppressMentions win over mentionEveryone on Discord', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(webhook, {
            ...withBoth,
            mentionEveryone: true,
            suppressMentions: true,
        });

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toEqual({ parse: [], users: [] });
    });

    it('does not parse everyone when mentionEveryone is false', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(webhook, {
            ...base,
            mentionEveryone: false,
        });

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(sent.allowedMentions).toBeUndefined();
    });

    it('parses everyone on a Fluxer send, with and without roles', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');
        const service = new WebhookService();

        await service.sendMessageViaFluxerWebhook(webhook, everyone);
        await service.sendMessageViaFluxerWebhook(webhook, {
            ...withBoth,
            mentionEveryone: true,
        });

        const [, first] = post.mock.calls[0] as unknown as RestCall;
        const [, second] = post.mock.calls[1] as unknown as RestCall;
        expect(first.body.allowed_mentions).toEqual({ parse: ['everyone'] });
        expect(second.body.allowed_mentions).toEqual({
            parse: ['everyone'],
            users: ['u1'],
            roles: ['r1', 'r2'],
        });
    });

    it('never parses everyone on a Fluxer edit', async () => {
        const { client, patch } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');
        const service = new WebhookService();

        await service.editMessageViaFluxerWebhook(webhook, 'm1', everyone);
        await service.editMessageViaFluxerWebhook(webhook, 'm1', {
            ...withBoth,
            mentionEveryone: true,
        });

        const [, alone] = patch.mock.calls[0] as unknown as RestCall;
        const [, mixed] = patch.mock.calls[1] as unknown as RestCall;
        expect('allowed_mentions' in alone.body).toBe(false);
        expect(mixed.body.allowed_mentions).toEqual({
            parse: [],
            users: ['u1'],
        });
    });

    it('lets suppressMentions win over mentionEveryone on Fluxer', async () => {
        const { client, post } = fakeFluxerClient();
        const webhook = FluxerWebhook.fromToken(client, 'wh1', 'tok');

        await new WebhookService().sendMessageViaFluxerWebhook(webhook, {
            ...everyone,
            suppressMentions: true,
        });

        const [, options] = post.mock.calls[0] as unknown as RestCall;
        expect(options.body.allowed_mentions).toEqual({ parse: [] });
    });
});
