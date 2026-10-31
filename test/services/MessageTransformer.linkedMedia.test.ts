import { Collection } from 'discord.js';
import { describe, expect, it } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';

// Issue #53: GIF-picker links (and expiring Discord CDN media links) are
// uploaded to Fluxer as files instead of relayed as bare links.

const TENOR_LINK = 'https://tenor.com/view/dancing-cat-gif-12345';
const TENOR_MP4 = 'https://media.tenor.com/abcDEFAAAPo/dancing-cat.mp4';
const TENOR_GIF = 'https://media.tenor.com/abcDEFAAAAC/dancing-cat.gif';

const tenorEmbed = {
    data: { type: 'gifv' },
    url: TENOR_LINK,
    video: { url: TENOR_MP4, proxyURL: TENOR_MP4 },
    image: null,
    thumbnail: { url: 'https://media.tenor.com/thumb.png' },
};

function fakeUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeDiscordMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dmsg',
        content: TENOR_LINK,
        author: fakeUser('duser', 'dave'),
        client: {
            users: { cache: new Map() },
            channels: { cache: new Map() },
            guilds: { cache: new Map() },
        },
        guild: null,
        attachments: new Collection(),
        stickers: new Collection(),
        embeds: [tenorEmbed],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map(), everyone: false },
        ...overrides,
    };
}

function file(i: number) {
    return {
        url: `https://cdn.discordapp.com/attachments/1/2/file${i}.png`,
        name: `file${i}.png`,
        spoiler: false,
        size: 10,
    };
}

describe('DiscordMessageTransformer linked gif/video media', () => {
    it('uploads a lone tenor link as a gif and blanks the content', async () => {
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage() as never
        );

        expect(result.attachments).toEqual([
            {
                url: TENOR_GIF,
                name: 'dancing-cat.gif',
                spoiler: false,
                fromLink: true,
            },
        ]);
        expect(result.content).toBe('');
        expect(result.linkFallbackContent).toBe(TENOR_LINK);
    });

    it('keeps the content when there is other text', async () => {
        const content = `look at this ${TENOR_LINK}`;
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({ content }) as never
        );

        expect(result.attachments).toHaveLength(1);
        expect(result.attachments![0].fromLink).toBe(true);
        expect(result.content).toBe(content);
        expect(result.linkFallbackContent).toBe(content);
    });

    it('puts the media after real attachments, within 10 files', async () => {
        const nine = new Collection(
            Array.from({ length: 9 }, (_, i) => [`a${i}`, file(i)] as const)
        );
        const cdn1 = 'https://cdn.discordapp.com/attachments/1/2/a.mp4';
        const cdn2 = 'https://cdn.discordapp.com/attachments/1/2/b.mp4';
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({
                content: `${cdn1} ${cdn2}`,
                embeds: [],
                attachments: nine,
            }) as never
        );

        expect(result.attachments).toHaveLength(10);
        expect(result.attachments![9]).toMatchObject({
            url: cdn1,
            fromLink: true,
        });
        // b.mp4 was not uploaded, so its link has to stay.
        expect(result.content).toBe(`${cdn1} ${cdn2}`);
    });

    it('keeps the reply quote above an emptied content', async () => {
        const referenced = fakeDiscordMessage({
            id: 'dmsg-ref',
            content: 'hi',
            author: fakeUser('dother', 'olive'),
            embeds: [],
        });
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({
                reference: { messageId: 'dmsg-ref', channelId: 'c' },
                fetchReference: async () => referenced,
            }) as never
        );

        expect(result.content).toMatch(/^-# ↩️ .*olive.* hi$/);
        expect(result.linkFallbackContent).toBe(
            `${result.content}\n${TENOR_LINK}`
        );
        expect(result.attachments).toHaveLength(1);
    });

    it('leaves the link alone on edits', async () => {
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage() as never,
            [],
            { isEdit: true }
        );

        expect(result.attachments).toEqual([]);
        expect(result.content).toBe(TENOR_LINK);
        expect(result.linkFallbackContent).toBeUndefined();
    });

    it('leaves a link without a gif embed alone', async () => {
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordMessage({ embeds: [] }) as never
        );

        expect(result.attachments).toEqual([]);
        expect(result.content).toBe(TENOR_LINK);
        expect(result.linkFallbackContent).toBeUndefined();
    });
});
