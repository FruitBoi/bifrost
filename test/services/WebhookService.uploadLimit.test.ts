import { describe, expect, it, vi } from 'vitest';
import { WebhookClient } from 'discord.js';
import {
    WebhookMessageData,
    WebhookService,
} from '../../src/services/WebhookService';

const MiB = 1024 * 1024;

function fakeDiscordWebhook() {
    const send = vi.fn(async () => ({ id: 'd-sent-1' }));
    const editMessage = vi.fn(async () => ({}));
    return {
        webhook: { send, editMessage } as unknown as WebhookClient,
        send,
        editMessage,
    };
}

type Built = { name?: string; attachment?: unknown; spoiler?: boolean };

const video = {
    url: 'https://cdn.example/clip.mp4',
    name: 'clip.mp4',
    size: 30 * MiB,
};
const image = {
    url: 'https://cdn.example/pic.png',
    name: 'pic.png',
    size: 100 * 1024,
};

function data(overrides: Partial<WebhookMessageData>): WebhookMessageData {
    return { content: 'hello', username: 'u', avatarURL: '', ...overrides };
}

function filesOf(payload: Record<string, unknown>): Built[] {
    return (payload.files ?? []) as Built[];
}

describe('WebhookService Discord upload limit', () => {
    it('links an oversized video on send instead of uploading it', async () => {
        const { webhook, send } = fakeDiscordWebhook();

        await new WebhookService().sendMessageViaDiscordWebhook(
            webhook,
            data({ attachments: [video] })
        );

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        expect(filesOf(sent).map((f) => f.name)).not.toContain('clip.mp4');
        expect((sent.content as string).split('\n')).toContain(video.url);
        expect((sent.content as string).startsWith('hello')).toBe(true);
    });

    it('links an oversized video on edit instead of uploading it', async () => {
        const { webhook, editMessage } = fakeDiscordWebhook();

        await new WebhookService().editMessageViaDiscordWebhook(
            webhook,
            'm1',
            data({ attachments: [video] })
        );

        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(filesOf(edited).map((f) => f.name)).not.toContain('clip.mp4');
        expect((edited.content as string).split('\n')).toContain(video.url);
    });

    it('still uploads small attachments alongside a linked video', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();
        const msg = data({ attachments: [video, image] });

        await service.sendMessageViaDiscordWebhook(webhook, msg);
        await service.editMessageViaDiscordWebhook(webhook, 'm1', msg);

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        for (const payload of [sent, edited]) {
            const files = filesOf(payload);
            expect(files).toHaveLength(1);
            expect(files[0]!.name).toBe('pic.png');
            expect(files[0]!.attachment).toBe(image.url);
            expect(payload.content as string).not.toContain(image.url);
            expect(payload.content as string).toContain(video.url);
        }
    });

    it('wraps a spoiler oversize link in ||', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();
        const msg = data({ attachments: [{ ...video, spoiler: true }] });

        await service.sendMessageViaDiscordWebhook(webhook, msg);
        await service.editMessageViaDiscordWebhook(webhook, 'm1', msg);

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect((sent.content as string).split('\n')).toContain(
            `||${video.url}||`
        );
        expect((edited.content as string).split('\n')).toContain(
            `||${video.url}||`
        );
        expect(filesOf(sent)).toHaveLength(0);
    });

    it('leaves content unchanged when there are no attachments', async () => {
        const { webhook, send, editMessage } = fakeDiscordWebhook();
        const service = new WebhookService();

        await service.sendMessageViaDiscordWebhook(webhook, data({}));
        await service.editMessageViaDiscordWebhook(webhook, 'm1', data({}));

        const sent = send.mock.calls[0]![0] as Record<string, unknown>;
        const edited = editMessage.mock.calls[0]![1] as Record<string, unknown>;
        expect(sent.content).toBe('hello');
        expect(edited.content).toBe('hello');
        expect(filesOf(sent)).toHaveLength(0);
    });
});
