import { Collection } from 'discord.js';
import { describe, expect, it } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import WebhookEmbed from '../../src/services/WebhookEmbed';

// Replies to messages without text (e.g. a lone image) used to build a quote
// embed with an empty description, which Discord rejects, so the reply was
// never bridged.

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
    it('quotes a replied-to image with a placeholder instead of an empty description', async () => {
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

        expect(result.content).toBe('nice pic');
        expect(result.embeds).toHaveLength(1);
        const quote = result.embeds![0].toPlainObject();
        expect(quote.description).toBe('*📎 attachment*');
        expect(quote.author?.name).toBe('olive ↩️');
        // Building the Discord payload must not throw (it did for '').
        expect(() => result.embeds![0].toDiscordEmbed()).not.toThrow();
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

        expect(result.embeds![0].toPlainObject().description).toBe(
            '*📎 2 attachments · 🏷️ sticker · 🔗 embed*'
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
        expect(result.embeds).toHaveLength(1);
        expect(() =>
            result.embeds!.map((e) => e.toDiscordEmbed().toJSON())
        ).not.toThrow();
    });

    it('keeps quoting replied-to text as before', async () => {
        const referenced = fakeFluxerMessage({ content: 'original' });
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerMessage({ referencedMessage: referenced }) as never
        );

        expect(result.embeds![0].toPlainObject().description).toBe('original');
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

        expect(result.embeds).toHaveLength(1);
        const quote = result.embeds![0].toPlainObject();
        expect(quote.description).toBe('*📎 attachment*');
        expect(quote.author?.name).toBe('olive ↩️');
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
        expect(result.embeds).toHaveLength(1);
        const quote = result.embeds![0].toPlainObject();
        expect(quote.description).not.toContain('Forwarded');
        expect(quote.author?.name).toBe('dave ↩️');
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
