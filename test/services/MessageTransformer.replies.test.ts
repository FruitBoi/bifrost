import { Collection } from 'discord.js';
import { describe, expect, it } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import WebhookEmbed from '../../src/services/WebhookEmbed';

// Replies to messages without text (e.g. a lone image) used to build a quote
// embed with an empty description, which Discord rejects, so the reply was
// never bridged. The quote is now a line above the content (see
// replyQuote.test.ts); textless messages are still described.

function fakeUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeFluxerMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'fmsg',
        content: 'hello',
        author: fakeUser('fuser', 'fran'),
        client: { users: { get: () => null }, channels: { get: () => null } },
        guild: null,
        attachments: new Collection(),
        stickers: [],
        embeds: [],
        referencedMessage: null,
        mentions: [],
        webhookId: null,
        ...overrides,
    };
}

function fakeDiscordMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dmsg',
        content: 'hello',
        author: fakeUser('duser', 'dave'),
        client: {
            users: { cache: new Map() },
            channels: { cache: new Map() },
            guilds: { cache: new Map() },
        },
        guild: null,
        attachments: new Collection(),
        stickers: new Collection(),
        embeds: [],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map() },
        ...overrides,
    };
}

const image = {
    url: 'https://cdn/image.png',
    filename: 'image.png',
    name: 'image.png',
    flags: 0,
    spoiler: false,
};

describe('FluxerMessageTransformer replies to textless messages', () => {
    it('quotes a replied-to image with a placeholder instead of empty text', async () => {
        const referenced = fakeFluxerMessage({
            id: 'fmsg-image',
            content: '',
            author: fakeUser('fother', 'olive'),
            attachments: new Collection([['a1', image]]),
        });
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({
                content: 'nice pic',
                referencedMessage: referenced,
            }) as never
        );

        expect(result.content).toBe(
            '-# ↩️ **olive** *📎 attachment*\nnice pic'
        );
        expect(result.embeds).toEqual([]);
    });

    it('counts attachments, stickers and embeds of the replied-to message', async () => {
        const referenced = fakeFluxerMessage({
            content: '   ',
            attachments: new Collection([
                ['a1', image],
                ['a2', image],
            ]),
            stickers: [{ id: 's1', name: 'wave', animated: false }],
            embeds: [{ title: 'link' }],
        });
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({ referencedMessage: referenced }) as never
        );

        expect(result.content.split('\n')[0]).toBe(
            '-# ↩️ **fran** *📎 2 attachments · 🏷️ sticker · 🔗 embed*'
        );
    });

    it('still bridges an image-only reply to an image-only message', async () => {
        const referenced = fakeFluxerMessage({
            content: '',
            attachments: new Collection([['a1', image]]),
        });
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({
                content: '',
                attachments: new Collection([['a1', image]]),
                referencedMessage: referenced,
            }) as never
        );

        expect(result.attachments).toHaveLength(1);
        // The quote line alone is the content: never an empty payload.
        expect(result.content).toBe('-# ↩️ **fran** *📎 attachment*');
        expect(result.embeds).toEqual([]);
    });

    it('quotes replied-to text above the content', async () => {
        const referenced = fakeFluxerMessage({ content: 'original' });
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({ referencedMessage: referenced }) as never
        );

        expect(result.content).toBe('-# ↩️ **fran** original\nhello');
    });
});

describe('DiscordMessageTransformer replies to textless messages', () => {
    it('quotes a replied-to image instead of dropping the quote', async () => {
        const referenced = fakeDiscordMessage({
            content: '',
            author: fakeUser('dother', 'olive'),
            attachments: new Collection([['a1', image]]),
        });
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({
                content: 'nice pic',
                reference: { messageId: 'dmsg-image', channelId: 'dchan' },
                fetchReference: async () => referenced,
            }) as never
        );

        expect(result.content).toBe(
            '-# ↩️ **olive** *📎 attachment*\nnice pic'
        );
        expect(result.embeds).toEqual([]);
    });

    it('does not label a reply with attachments as a forwarded message', async () => {
        const referenced = fakeDiscordMessage({
            content: '',
            attachments: new Collection([['a1', image]]),
        });
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({
                content: '',
                attachments: new Collection([['a2', image]]),
                reference: { messageId: 'dmsg-image', channelId: 'dchan' },
                fetchReference: async () => referenced,
            }) as never
        );

        expect(result.attachments).toHaveLength(1);
        expect(result.embeds).toEqual([]);
        expect(result.content).toBe('-# ↩️ **dave** *📎 attachment*');
        expect(result.content).not.toContain('Forwarded');
    });
});

describe('WebhookEmbed', () => {
    it('omits empty titles and descriptions so Discord accepts the embed', () => {
        const embed = new WebhookEmbed({
            title: '',
            description: '',
            author: { name: 'someone ↩️' },
        });

        expect(embed.toPlainObject().description).toBeNull();
        expect(embed.toPlainObject().title).toBeNull();
        expect(() => embed.toDiscordEmbed()).not.toThrow();
        expect(() => embed.toFluxerEmbed()).not.toThrow();
    });
});

// A Fluxer forward has empty content of its own; the forwarded message lives
// in `messageSnapshots`. Ignoring it produced an empty webhook payload that
// Discord rejects with "Cannot send an empty message" (50006).
describe('FluxerMessageTransformer forwarded messages', () => {
    function snapshot(overrides: Record<string, unknown> = {}) {
        return {
            content: '',
            createdAt: new Date(0),
            editedAt: null,
            mentionUserIds: [],
            mentionRoles: [],
            embeds: [],
            attachments: [],
            stickers: [],
            ...overrides,
        };
    }

    it('quotes the forwarded text in an embed', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({
                content: '',
                messageReference: {
                    channelId: 'c1',
                    messageId: 'm1',
                    guildId: null,
                },
                messageSnapshots: [snapshot({ content: 'forwarded text' })],
            }) as never
        );

        expect(result.embeds).toHaveLength(1);
        const json = result.embeds![0].toDiscordEmbed().toJSON();
        expect(json.description).toBe('forwarded text');
        expect(json.author?.name).toBe('Forwarded message ⏩');
        expect(json.footer?.text).toBe('From another server');
    });

    it('carries over forwarded attachments and names the source channel', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({
                content: '',
                client: {
                    users: { get: () => null },
                    channels: {
                        get: (id: string) =>
                            id === 'c1' ? { name: 'general' } : null,
                    },
                    guilds: {
                        get: (id: string) =>
                            id === 'g1' ? { name: 'Lemon Land' } : null,
                    },
                },
                messageReference: {
                    channelId: 'c1',
                    messageId: 'm1',
                    guildId: 'g1',
                },
                messageSnapshots: [snapshot({ attachments: [image] })],
            }) as never
        );

        expect(result.attachments).toEqual([
            { url: image.url, name: image.filename, spoiler: false },
        ]);
        const json = result.embeds![0].toDiscordEmbed().toJSON();
        expect(json.description).toBe('*📎 attachment*');
        expect(json.footer?.text).toBe('From #general in Lemon Land');
    });

    it('never sends an empty payload for a forward without anything bridgeable', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({
                content: '',
                messageReference: null,
                messageSnapshots: [snapshot()],
            }) as never
        );

        expect(result.embeds).toHaveLength(1);
        expect(result.embeds![0].toDiscordEmbed().toJSON().description).toBe(
            '*No text*'
        );
    });

    it('leaves plain messages without snapshots untouched', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({ messageSnapshots: [] }) as never
        );

        expect(result.content).toBe('hello');
        expect(result.embeds).toEqual([]);
    });
});
