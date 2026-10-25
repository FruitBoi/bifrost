import { Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import ReplyLinkResolver from '../../src/services/replyQuote/ReplyLinkResolver';
import {
    buildReplyQuoteLine,
    formatQuoteSnippet,
    messageUrl,
    prependReplyQuote,
} from '../../src/services/replyQuote/replyQuote';
import { MessageLink } from '../../src/db/entities/MessageLink';
import { FakeLinkService, makeChannelLink } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

const ZWSP = '​';

function makeMessageLink(overrides: Partial<MessageLink> = {}): MessageLink {
    return {
        id: 'ml-1',
        guildLinkId: 'guild-link-1',
        channelLinkId: 'link-1',
        discordMessageId: 'dmsg-orig',
        fluxerMessageId: 'fmsg-orig',
        sourcePlatform: null,
        sourceAuthorId: null,
        createdAt: new Date(),
        ...overrides,
    };
}

function fakeUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeDiscordMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'dmsg-reply',
        content: 'hello',
        author: fakeUser('duser', 'dave'),
        client: {
            users: { cache: new Map() },
            channels: { cache: new Map() },
            guilds: { cache: new Map() },
        },
        guild: null,
        guildId: 'dguild',
        channelId: 'dchan',
        attachments: new Collection(),
        stickers: new Collection(),
        embeds: [],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map(), everyone: false },
        ...overrides,
    };
}

/** A Discord reply to `referenced` (by default `dmsg-orig` by olive). */
function fakeDiscordReply(
    overrides: Record<string, unknown> = {},
    referencedOverrides: Record<string, unknown> = {}
) {
    const referenced = fakeDiscordMessage({
        id: 'dmsg-orig',
        content: 'original text',
        author: fakeUser('dolive', 'olive'),
        ...referencedOverrides,
    });
    return fakeDiscordMessage({
        reference: {
            messageId: referenced.id,
            channelId: 'dchan',
            guildId: 'dguild',
        },
        fetchReference: async () => referenced,
        ...overrides,
    });
}

function fakeFluxerMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'fmsg-reply',
        content: 'hello',
        author: fakeUser('fuser', 'fran'),
        client: {
            users: { get: () => null },
            channels: { get: () => null },
            guilds: { get: () => null },
        },
        guild: null,
        guildId: 'fguild',
        channelId: 'fchan',
        attachments: new Collection(),
        stickers: [],
        embeds: [],
        referencedMessage: null,
        messageReference: null,
        mentions: [],
        webhookId: null,
        ...overrides,
    };
}

/** A Fluxer reply to `referenced` (by default `fmsg-orig` by olive). */
function fakeFluxerReply(
    overrides: Record<string, unknown> = {},
    referencedOverrides: Record<string, unknown> = {}
) {
    const referenced = fakeFluxerMessage({
        id: 'fmsg-orig',
        content: 'original text',
        author: fakeUser('folive', 'olive'),
        ...referencedOverrides,
    });
    return fakeFluxerMessage({
        referencedMessage: referenced,
        messageReference: {
            messageId: referenced.id,
            channelId: 'fchan',
            guildId: 'fguild',
        },
        ...overrides,
    });
}

describe('reply quote formatting', () => {
    it('builds Discord and Fluxer message URLs', () => {
        expect(messageUrl('discord', 'g', 'c', 'm')).toBe(
            'https://discord.com/channels/g/c/m'
        );
        expect(messageUrl('fluxer', 'g', 'c', 'm')).toBe(
            'https://fluxer.app/channels/g/c/m'
        );
    });

    it('collapses newlines and whitespace to single spaces', () => {
        expect(formatQuoteSnippet('  first line\n\nsecond\tline  ')).toBe(
            'first line second line'
        );
    });

    it('truncates long text to 100 characters with an ellipsis', () => {
        const snippet = formatQuoteSnippet('a'.repeat(150));
        expect(snippet).toBe(`${'a'.repeat(100)}…`);
        expect(formatQuoteSnippet('a'.repeat(100))).toBe('a'.repeat(100));
    });

    it('escapes markdown that could leak past the quote line', () => {
        expect(formatQuoteSnippet('use `code and [a](b) *x* ~y~ _z_')).toBe(
            'use \\`code and \\[a\\](b) \\*x\\* \\~y\\~ \\_z\\_'
        );
    });

    it('keeps spoilers tagged, escaping their text', () => {
        expect(formatQuoteSnippet('the killer is ||the butler||!')).toBe(
            'the killer is ||the butler||!'
        );
        expect(formatQuoteSnippet('||a *b*|| and ||c||')).toBe(
            '||a \\*b\\*|| and ||c||'
        );
        // A lone marker is not a spoiler and stays escaped.
        expect(formatQuoteSnippet('a || b')).toBe('a \\|\\| b');
    });

    it('closes a spoiler that the cut lands in', () => {
        const snippet = formatQuoteSnippet(
            `${'a'.repeat(95)} ||the butler did it||`
        );
        expect(snippet).toBe(`${'a'.repeat(95)} ||the||…`);
        // Cut right before the spoiler: no empty spoiler is left behind.
        expect(formatQuoteSnippet(`${'a'.repeat(100)}||secret||`)).toBe(
            `${'a'.repeat(100)}…`
        );
    });

    it('keeps emoji and links inside spoilers intact', () => {
        expect(formatQuoteSnippet('||<:my_emoji:123> https://a.b/x_y||')).toBe(
            '||<:my_emoji:123> <https://a.b/x_y>||'
        );
    });

    it('keeps custom emoji and URLs intact, never cutting them in half', () => {
        expect(
            formatQuoteSnippet('hi <:my_emoji:123> see https://a.b/x_y')
        ).toBe('hi <:my_emoji:123> see <https://a.b/x_y>');
        // Links are wrapped (once) so the quote does not unfurl a preview.
        expect(formatQuoteSnippet('see <https://a.b/x>')).toBe(
            'see <https://a.b/x>'
        );
        const snippet = formatQuoteSnippet(`${'a'.repeat(95)} <:my_emoji:123>`);
        expect(snippet).toBe(`${'a'.repeat(95)}…`);
    });

    it('links the bold author name when there is a URL', () => {
        expect(buildReplyQuoteLine('olive', 'https://x/y', 'hi')).toBe(
            '-# ↩️ [**olive**](<https://x/y>) hi'
        );
        expect(buildReplyQuoteLine('o_l*i[v]e', null, 'hi')).toBe(
            '-# ↩️ **o\\_l\\*i\\[v\\]e** hi'
        );
    });

    it('prepends the line, or refuses when the message would be too long', () => {
        expect(prependReplyQuote('', 'quote')).toBe('quote');
        expect(prependReplyQuote('body', 'quote')).toBe('quote\nbody');
        expect(prependReplyQuote('a'.repeat(1994), 'quote')).toBe(
            `quote\n${'a'.repeat(1994)}`
        );
        expect(prependReplyQuote('a'.repeat(1995), 'quote')).toBeNull();
    });
});

describe('ReplyLinkResolver', () => {
    let links: FakeLinkService;
    let resolver: ReplyLinkResolver;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        resolver = new ReplyLinkResolver(links.asLinkService());
    });

    it('links a Discord message to its Fluxer counterpart', async () => {
        const link = makeChannelLink({ id: 'link-1' });
        links.links.push(link);
        links.messageLinks.push(makeMessageLink());

        expect(
            await resolver.resolveCounterpartUrl('discord', 'dmsg-orig')
        ).toBe('https://fluxer.app/channels/fguild/fchan/fmsg-orig');
    });

    it('links a Fluxer message to its Discord counterpart', async () => {
        links.links.push(makeChannelLink({ id: 'link-1' }));
        links.messageLinks.push(makeMessageLink());

        expect(
            await resolver.resolveCounterpartUrl('fluxer', 'fmsg-orig')
        ).toBe('https://discord.com/channels/dguild/dchan/dmsg-orig');
    });

    it('uses the thread id when the target side is a thread', async () => {
        links.links.push(
            makeChannelLink({
                id: 'link-1',
                discordThreadId: 'dthread',
                fluxerThreadId: 'fthread',
            })
        );
        links.messageLinks.push(makeMessageLink());

        expect(
            await resolver.resolveCounterpartUrl('discord', 'dmsg-orig')
        ).toBe('https://fluxer.app/channels/fguild/fthread/fmsg-orig');
        expect(
            await resolver.resolveCounterpartUrl('fluxer', 'fmsg-orig')
        ).toBe('https://discord.com/channels/dguild/dthread/dmsg-orig');
    });

    it('returns null for a message that was never bridged', async () => {
        expect(
            await resolver.resolveCounterpartUrl('discord', 'unknown')
        ).toBeNull();
    });

    it('returns null when the channel link is gone', async () => {
        links.messageLinks.push(makeMessageLink());
        expect(
            await resolver.resolveCounterpartUrl('discord', 'dmsg-orig')
        ).toBeNull();
    });

    it('returns null and logs at debug level when the lookup throws', async () => {
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);
        vi.spyOn(links, 'getMessageLinkByFluxerMessageId').mockRejectedValue(
            new Error('db down')
        );

        expect(
            await resolver.resolveCounterpartUrl('fluxer', 'fmsg-orig')
        ).toBeNull();
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
});

describe('reply quotes in relayed messages', () => {
    let links: FakeLinkService;
    let resolver: ReplyLinkResolver;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        links = new FakeLinkService();
        resolver = new ReplyLinkResolver(links.asLinkService());
    });

    function bridgeOriginals(threads = false) {
        links.links.push(
            makeChannelLink({
                id: 'link-1',
                ...(threads
                    ? { discordThreadId: 'dthread', fluxerThreadId: 'fthread' }
                    : {}),
            })
        );
        links.messageLinks.push(makeMessageLink());
    }

    it('puts a quote linking to the Fluxer copy above a Discord reply', async () => {
        bridgeOriginals(true);
        const result = await new DiscordMessageTransformer(
            undefined,
            resolver
        ).transformMessage(fakeDiscordReply() as never);

        expect(result.content).toBe(
            '-# ↩️ [**olive**](<https://fluxer.app/channels/fguild/fthread/fmsg-orig>) original text\nhello'
        );
        expect(result.embeds).toEqual([]);
    });

    it('puts a quote linking to the Discord copy above a Fluxer reply', async () => {
        bridgeOriginals(true);
        const result = await new FluxerMessageTransformer(
            undefined,
            resolver
        ).transformMessage(fakeFluxerReply() as never);

        expect(result.content).toBe(
            '-# ↩️ [**olive**](<https://discord.com/channels/dguild/dthread/dmsg-orig>) original text\nhello'
        );
        expect(result.embeds).toEqual([]);
    });

    it('links to the source message when the replied-to one is not bridged', async () => {
        const discord = await new DiscordMessageTransformer(
            undefined,
            resolver
        ).transformMessage(fakeDiscordReply() as never);
        expect(discord.content.split('\n')[0]).toBe(
            '-# ↩️ [**olive**](<https://discord.com/channels/dguild/dchan/dmsg-orig>) original text'
        );

        // Without a resolver at all the source link is used too.
        const fluxer = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerReply() as never
        );
        expect(fluxer.content.split('\n')[0]).toBe(
            '-# ↩️ [**olive**](<https://fluxer.app/channels/fguild/fchan/fmsg-orig>) original text'
        );
    });

    it('quotes without a link when no URL can be built', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerReply(
                { guildId: null, messageReference: null },
                { guildId: null }
            ) as never
        );
        expect(result.content).toBe('-# ↩️ **olive** original text\nhello');
    });

    it('collapses and truncates a long multi-line quote', async () => {
        const long = `line one\n\n${'x'.repeat(200)}`;
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordReply({}, { content: long }) as never
        );
        const [line, ...rest] = result.content.split('\n');
        expect(line).toBe(
            `-# ↩️ [**olive**](<https://discord.com/channels/dguild/dchan/dmsg-orig>) line one ${'x'.repeat(91)}…`
        );
        expect(rest).toEqual(['hello']);
    });

    it('describes a textless replied-to message', async () => {
        const result = await new FluxerMessageTransformer().transformMessage(
            fakeFluxerReply(
                {},
                {
                    content: '',
                    attachments: new Collection([['a1', { url: 'u' }]]),
                }
            ) as never
        );
        expect(result.content.split('\n')[0]).toMatch(
            /^-# ↩️ \[\*\*olive\*\*\]\(<[^>]+>\) \*📎 attachment\*$/
        );
    });

    it('never pings @everyone from a quoted Discord message', async () => {
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordReply({}, { content: 'hey @everyone' }) as never
        );
        expect(result.content).toContain(`hey @${ZWSP}everyone`);
        expect(result.mentionEveryone).toBeUndefined();
    });

    it('keeps the reply ping, below the quote line', async () => {
        bridgeOriginals();
        links.messageLinks[0] = makeMessageLink({
            sourcePlatform: 'discord',
            sourceAuthorId: 'dolive',
        });
        const mentionBridge = new MentionBridgeService(links.asLinkService());
        const reply = fakeFluxerReply(
            {},
            { author: fakeUser('fwebhook', 'olive'), webhookId: 'fwebhook' }
        );
        reply.mentions = [reply.referencedMessage.author] as never;

        const result = await new FluxerMessageTransformer(
            mentionBridge,
            resolver
        ).transformMessage(reply as never);

        expect(result.content).toBe(
            '-# ↩️ [**olive**](<https://discord.com/channels/dguild/dchan/dmsg-orig>) original text\n<@dolive> hello'
        );
        expect(result.mentionUserIds).toEqual(['dolive']);
    });

    it('falls back to a linked embed when the quote would not fit', async () => {
        bridgeOriginals();
        const content = 'a'.repeat(1990);
        const result = await new DiscordMessageTransformer(
            undefined,
            resolver
        ).transformMessage(fakeDiscordReply({ content }) as never);

        expect(result.content).toBe(content);
        expect(result.embeds).toHaveLength(1);
        const url = 'https://fluxer.app/channels/fguild/fchan/fmsg-orig';
        const fluxerEmbed = result.embeds![0].toFluxerEmbed().toJSON();
        expect(fluxerEmbed.author).toEqual({
            name: 'olive ↩️',
            url,
            icon_url: 'https://avatars/dolive',
        });
        expect(fluxerEmbed.description).toBe('original text');

        const fluxerResult = await new FluxerMessageTransformer(
            undefined,
            resolver
        ).transformMessage(fakeFluxerReply({ content }) as never);
        expect(fluxerResult.content).toBe(content);
        const discordEmbed = fluxerResult.embeds![0].toDiscordEmbed().toJSON();
        expect(discordEmbed.author?.url).toBe(
            'https://discord.com/channels/dguild/dchan/dmsg-orig'
        );
        expect(discordEmbed.author?.name).toBe('olive ↩️');
    });

    it('puts the quote above a relayed poll', async () => {
        const result = await new DiscordMessageTransformer().transformMessage(
            fakeDiscordReply({
                poll: {
                    question: { text: 'Lunch?' },
                    answers: [{ text: 'Pizza' }, { text: 'Soup' }],
                    expiresTimestamp: Date.now() + 60_000,
                },
            }) as never
        );
        const [line, ...poll] = result.content.split('\n');
        expect(line).toMatch(/^-# ↩️ .* original text$/);
        expect(poll.join('\n')).toContain('Lunch?');
    });

    it('leaves Discord forwards as embeds', async () => {
        const snapshot = fakeDiscordMessage({
            content: 'forwarded text',
            author: fakeUser('dolive', 'olive'),
        });
        const result = await new DiscordMessageTransformer(
            undefined,
            resolver
        ).transformMessage(
            fakeDiscordMessage({
                content: '',
                reference: { messageId: 'x', channelId: 'dchan' },
                flags: { has: () => true },
                messageSnapshots: { first: () => snapshot },
            }) as never
        );

        expect(result.content).toBe('');
        expect(result.embeds).toHaveLength(1);
        const quote = result.embeds![0].toPlainObject();
        expect(quote.description).toBe('forwarded text');
        expect(quote.author?.name).toBe('olive ⏩');
    });

    it('leaves Fluxer forwards as embeds', async () => {
        const result = await new FluxerMessageTransformer(
            undefined,
            resolver
        ).transformMessage(
            fakeFluxerMessage({
                content: '',
                messageReference: {
                    channelId: 'c1',
                    messageId: 'm1',
                    guildId: null,
                },
                messageSnapshots: [
                    {
                        content: 'forwarded text',
                        embeds: [],
                        attachments: [],
                        stickers: [],
                    },
                ],
            }) as never
        );

        expect(result.content).toBe('');
        expect(result.embeds).toHaveLength(1);
        expect(result.embeds![0].toPlainObject().author?.name).toBe(
            'Forwarded message ⏩'
        );
    });
});
