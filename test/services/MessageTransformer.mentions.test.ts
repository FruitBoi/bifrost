import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import { MessageLink } from '../../src/db/entities/MessageLink';
import { FakeLinkService, makeUserLink } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

const ZWSP = '​';

function makeMessageLink(overrides: Partial<MessageLink> = {}): MessageLink {
    return {
        id: 'ml-1',
        guildLinkId: 'guild-link-1',
        channelLinkId: 'link-1',
        discordMessageId: 'dmsg-bridged',
        fluxerMessageId: 'fmsg-bridged',
        sourcePlatform: null,
        sourceAuthorId: null,
        createdAt: new Date(),
        ...overrides,
    } as MessageLink;
}

// ---------------------------------------------------------------------------
// Discord fakes
// ---------------------------------------------------------------------------

function fakeDiscordUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeDiscordClient(users: ReturnType<typeof fakeDiscordUser>[]) {
    return {
        users: { cache: new Map(users.map((u) => [u.id, u])) },
        channels: { cache: new Map() },
        guilds: { cache: new Map() },
    };
}

function fakeDiscordMessage(
    overrides: Record<string, unknown> = {},
    client = fakeDiscordClient([])
) {
    return {
        id: 'dmsg-reply',
        content: 'hello',
        author: fakeDiscordUser('duser', 'dave'),
        client,
        guild: null,
        attachments: [],
        stickers: [],
        embeds: [],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map() },
        fetchReference: async () => {
            throw new Error('no reference');
        },
        ...overrides,
    };
}

/** A reply to a message that our Discord webhook posted (bridged copy). */
function fakeDiscordReply({
    pings,
    content = 'hello',
    guildId,
    client = fakeDiscordClient([]),
}: {
    pings: boolean;
    content?: string;
    guildId?: string;
    client?: ReturnType<typeof fakeDiscordClient>;
}) {
    const webhookAuthor = fakeDiscordUser('dwebhook', 'Bifröst');
    const referenced = fakeDiscordMessage(
        {
            id: 'dmsg-bridged',
            content: 'original',
            author: webhookAuthor,
            webhookId: 'dwebhook',
        },
        client
    );
    return fakeDiscordMessage(
        {
            content,
            ...(guildId ? { guildId } : {}),
            reference: { messageId: 'dmsg-bridged', channelId: 'dchan' },
            mentions: {
                users: pings
                    ? new Map([[webhookAuthor.id, webhookAuthor]])
                    : new Map(),
            },
            fetchReference: async () => referenced,
        },
        client
    );
}

// ---------------------------------------------------------------------------
// Fluxer fakes
// ---------------------------------------------------------------------------

function fakeFluxerUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeFluxerClient(users: ReturnType<typeof fakeFluxerUser>[]) {
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
        users: { get: (id: string) => byId.get(id) ?? null },
        channels: { get: () => null },
    };
}

function fakeFluxerMessage(
    overrides: Record<string, unknown> = {},
    client = fakeFluxerClient([])
) {
    return {
        id: 'fmsg-reply',
        content: 'hello',
        author: fakeFluxerUser('fuser', 'fran'),
        client,
        guild: null,
        attachments: [],
        stickers: [],
        embeds: [],
        referencedMessage: null,
        mentions: [],
        webhookId: null,
        ...overrides,
    };
}

/** A reply to a message that our Fluxer webhook posted (bridged copy). */
function fakeFluxerReply({
    pings,
    content = 'hello',
    guildId,
    client = fakeFluxerClient([]),
}: {
    pings: boolean;
    content?: string;
    guildId?: string;
    client?: ReturnType<typeof fakeFluxerClient>;
}) {
    const webhookAuthor = fakeFluxerUser('fwebhook', 'Bifröst');
    const referenced = fakeFluxerMessage(
        {
            id: 'fmsg-bridged',
            content: 'original',
            author: webhookAuthor,
            webhookId: 'fwebhook',
        },
        client
    );
    return fakeFluxerMessage(
        {
            content,
            ...(guildId ? { guildId } : {}),
            referencedMessage: referenced,
            mentions: pings ? [webhookAuthor] : [],
        },
        client
    );
}

// ---------------------------------------------------------------------------

describe('DiscordMessageTransformer reply pings', () => {
    let links: FakeLinkService;
    let mentionBridge: MentionBridgeService;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        mentionBridge = new MentionBridgeService(links.asLinkService());
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
    });

    it('prepends a mention and whitelists the Fluxer author when a reply pings a bridged message', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({ pings: true }) as never
        );

        expect(result.content.startsWith('<@fuser-original> ')).toBe(true);
        expect(result.content).toBe('<@fuser-original> hello');
        expect(result.mentionUserIds).toEqual(['fuser-original']);
        // The reply quote embed is still produced.
        expect(result.embeds?.length).toBe(1);
    });

    it('does not mention anyone when the reply has pings turned off', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({ pings: false }) as never
        );

        expect(result.content).toBe('hello');
        expect(result.mentionUserIds).toBeUndefined();
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not mention anyone when the original author is also on Discord', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({ pings: true }) as never
        );

        expect(result.content).toBe('hello');
        expect(result.mentionUserIds).toBeUndefined();
    });

    it('does not mention anyone when the replied-to message is not bridged', async () => {
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({ pings: true }) as never
        );

        expect(result.content).toBe('hello');
        expect(result.mentionUserIds).toBeUndefined();
    });

    it('logs direct user mentions that were flattened to plaintext', async () => {
        const client = fakeDiscordClient([fakeDiscordUser('42', 'alice')]);
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeDiscordMessage(
                { content: 'hi <@42> and <@!99>', guildId: 'dguild' },
                client
            ) as never
        );

        expect(result.content).toBe('hi @alice and @unknown-user');
        expect('mentionUserIds' in result).toBe(false);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'discord',
                guildId: 'dguild',
                mentions: [
                    { id: '42', username: 'alice' },
                    { id: '99', username: null },
                ],
            })
        );
        expect(resolve.mock.calls[0][0].isEdit).toBeFalsy();
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '42', username: 'alice' },
            { id: '99', username: null },
        ]);
    });

    it('passes a null guild id to the bridge when the message has none', async () => {
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');

        await transformer.transformMessage(
            fakeDiscordMessage({ content: 'hi <@42>' }) as never
        );

        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ platform: 'discord', guildId: null })
        );
    });

    it('does not ask the bridge about mentions when the content has none', async () => {
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');

        const result = await transformer.transformMessage(
            fakeDiscordMessage({ content: 'hi <@&1> <#2>' }) as never
        );

        expect(result.content).toBe('hi @unknown-role #unknown-channel');
        expect(resolve).not.toHaveBeenCalled();
    });

    it('renders a mapped mention inline as the Fluxer counterpart and whitelists it', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const client = fakeDiscordClient([fakeDiscordUser('42', 'alice')]);
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeDiscordMessage(
                { content: 'hi <@42> and <@99>', guildId: 'dguild' },
                client
            ) as never
        );

        expect(result.content).toBe('hi <@fluxer-42> and @unknown-user');
        expect(result.mentionUserIds).toEqual(['fluxer-42']);
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '99', username: null },
        ]);
    });

    it('renders a <@!id> mapped mention inline too', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordMessage({
                content: '<@!42> <@42>',
                guildId: 'dguild',
            }) as never
        );

        expect(result.content).toBe('<@fluxer-42> <@fluxer-42>');
        expect(result.mentionUserIds).toEqual(['fluxer-42']);
    });

    it('keeps a mapped mention inline next to custom emojis', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordMessage({
                content: '<@42> <:wave:123>',
                guildId: 'dguild',
            }) as never,
            [{ name: 'wave', id: '999', animated: false }]
        );

        expect(result.content).toBe('<@fluxer-42> <:wave:999>');
    });

    it('prepends the reply ping and keeps the mapped mention inline', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({
                pings: true,
                content: 'hi <@42>',
                guildId: 'dguild',
            }) as never
        );

        expect(result.content).toBe('<@fuser-original> hi <@fluxer-42>');
        expect(result.mentionUserIds).toEqual(['fluxer-42', 'fuser-original']);
        expect(result.embeds?.length).toBe(1);
    });

    it('does not duplicate the ping when the reply target is also mentioned inline', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({
                discordUserId: '42',
                fluxerUserId: 'fuser-original',
            })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeDiscordReply({
                pings: true,
                content: 'hi <@42>',
                guildId: 'dguild',
            }) as never
        );

        expect(result.content).toBe('hi <@fuser-original>');
        expect(result.mentionUserIds).toEqual(['fuser-original']);
    });

    it('drops mapped mentions from a poll message', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const message = Object.assign(
            fakeDiscordMessage({ content: 'vote <@42>', guildId: 'dguild' }),
            {
                poll: {
                    question: { text: 'Lunch?' },
                    answers: [{ text: 'Pizza' }, { text: 'Sushi' }],
                    expiresTimestamp: Date.now() + 60_000,
                },
            }
        );

        const result = await transformer.transformMessage(message as never);

        expect(result.content).not.toContain('<@');
        expect(result.content).not.toContain('bfmention');
        expect('mentionUserIds' in result).toBe(false);
    });

    it('still resolves mapped mentions on edits, without logging', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const client = fakeDiscordClient([fakeDiscordUser('42', 'alice')]);
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');
        const info = vi.mocked(logger.info);
        info.mockClear();

        const result = await transformer.transformMessage(
            fakeDiscordMessage(
                { content: 'hi <@42> and <@99>', guildId: 'dguild' },
                client
            ) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe('hi <@fluxer-42> and @unknown-user');
        expect(result.mentionUserIds).toEqual(['fluxer-42']);
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ isEdit: true })
        );
        expect(log).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('does not prepend a mention when the reply is a forward', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const resolve = vi.spyOn(mentionBridge, 'resolveReplyPing');
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const reply = fakeDiscordReply({ pings: true, content: '' });
        const snapshot = await reply.fetchReference();
        const forwarded = Object.assign(reply, {
            flags: { has: () => true },
            messageSnapshots: { first: () => snapshot },
        });

        const result = await transformer.transformMessage(forwarded as never);

        expect(resolve).not.toHaveBeenCalled();
        expect(result.content).toBe('');
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not prepend a mention when the reply carries a poll', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const resolve = vi.spyOn(mentionBridge, 'resolveReplyPing');
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const reply = Object.assign(fakeDiscordReply({ pings: true }), {
            poll: {
                question: { text: 'Lunch?' },
                answers: [{ text: 'Pizza' }, { text: 'Sushi' }],
                expiresTimestamp: Date.now() + 60_000,
            },
        });

        const result = await transformer.transformMessage(reply as never);

        expect(resolve).not.toHaveBeenCalled();
        expect(result.content).not.toContain('<@');
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not re-log unresolved mentions when transforming an edit', async () => {
        const client = fakeDiscordClient([fakeDiscordUser('42', 'alice')]);
        const transformer = new DiscordMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeDiscordMessage(
                { content: 'hi <@42>', guildId: 'dguild' },
                client
            ) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe('hi @alice');
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ isEdit: true })
        );
        expect(log).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when no mention bridge is configured', async () => {
        const transformer = new DiscordMessageTransformer();
        const client = fakeDiscordClient([fakeDiscordUser('42', 'alice')]);

        const plain = await transformer.transformMessage(
            fakeDiscordMessage({ content: 'hi <@42>' }, client) as never
        );
        expect(plain).toStrictEqual({
            content: 'hi @alice',
            username: 'dave',
            avatarURL: 'https://avatars/duser',
            attachments: [],
            embeds: [],
        });

        const reply = await transformer.transformMessage(
            fakeDiscordReply({ pings: true }) as never
        );
        expect(reply.content).toBe('hello');
        expect('mentionUserIds' in reply).toBe(false);
    });
});

describe('FluxerMessageTransformer reply pings', () => {
    let links: FakeLinkService;
    let mentionBridge: MentionBridgeService;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        mentionBridge = new MentionBridgeService(links.asLinkService());
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
    });

    it('prepends a mention and whitelists the Discord author when a reply pings a bridged message', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({ pings: true }) as never
        );

        expect(result.content.startsWith('<@duser-original> ')).toBe(true);
        expect(result.content).toBe('<@duser-original> hello');
        expect(result.mentionUserIds).toEqual(['duser-original']);
        expect(result.embeds?.length).toBe(1);
    });

    it('keeps the injected mention intact while still zero-width-breaking other @s', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({
                pings: true,
                content: 'hey @everyone and <@77>',
            }) as never
        );

        expect(result.content).toBe(
            `<@duser-original> hey @${ZWSP}everyone and @${ZWSP}unknown-user`
        );
        expect(result.content).toContain('<@duser-original>');
        expect(result.content).not.toContain(`<@${ZWSP}duser-original>`);
        expect(result.mentionUserIds).toEqual(['duser-original']);
    });

    it('does not mention anyone when the reply has pings turned off', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({ pings: false }) as never
        );

        expect(result.content).toBe('hello');
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not mention anyone when the original author is also on Fluxer', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({ pings: true }) as never
        );

        expect(result.content).toBe('hello');
        expect(result.mentionUserIds).toBeUndefined();
    });

    it('logs direct user mentions that were flattened to plaintext', async () => {
        const client = fakeFluxerClient([fakeFluxerUser('42', 'alice')]);
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeFluxerMessage(
                { content: 'hi <@42> and <@99>', guildId: 'fguild' },
                client
            ) as never
        );

        expect(result.content).toBe(
            `hi @${ZWSP}alice and @${ZWSP}unknown-user`
        );
        expect('mentionUserIds' in result).toBe(false);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: 'fluxer',
                guildId: 'fguild',
                mentions: [
                    { id: '42', username: 'alice' },
                    { id: '99', username: null },
                ],
            })
        );
        expect(resolve.mock.calls[0][0].isEdit).toBeFalsy();
        expect(log).toHaveBeenCalledWith('fluxer', [
            { id: '42', username: 'alice' },
            { id: '99', username: null },
        ]);
    });

    it('passes a null guild id to the bridge when the message has none', async () => {
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');

        await transformer.transformMessage(
            fakeFluxerMessage({ content: 'hi <@42>' }) as never
        );

        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ platform: 'fluxer', guildId: null })
        );
    });

    it('does not ask the bridge about mentions when the content has none', async () => {
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');

        const result = await transformer.transformMessage(
            fakeFluxerMessage({ content: 'hi @everyone' }) as never
        );

        expect(result.content).toBe(`hi @${ZWSP}everyone`);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('renders a mapped mention inline as the Discord counterpart, without a zero-width space', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const client = fakeFluxerClient([fakeFluxerUser('42', 'alice')]);
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeFluxerMessage(
                {
                    content: 'hi <@42> and @everyone and <@99>',
                    guildId: 'fguild',
                },
                client
            ) as never
        );

        expect(result.content).toBe(
            `hi <@discord-42> and @${ZWSP}everyone and @${ZWSP}unknown-user`
        );
        expect(result.content).toContain('<@discord-42>');
        expect(result.content).not.toContain(`<@${ZWSP}discord-42>`);
        expect(result.mentionUserIds).toEqual(['discord-42']);
        expect(log).toHaveBeenCalledWith('fluxer', [
            { id: '99', username: null },
        ]);
    });

    it('keeps a mapped mention inline next to custom emojis', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerMessage({
                content: '<@42> <:wave:123>',
                guildId: 'fguild',
            }) as never,
            [{ name: 'wave', id: '999', animated: false }]
        );

        expect(result.content).toBe('<@discord-42> <:wave:999>');
    });

    it('prepends the reply ping and keeps the mapped mention inline', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({
                pings: true,
                content: 'hi <@42> @here',
                guildId: 'fguild',
            }) as never
        );

        expect(result.content).toBe(
            `<@duser-original> hi <@discord-42> @${ZWSP}here`
        );
        expect(result.mentionUserIds).toEqual(['discord-42', 'duser-original']);
        expect(result.embeds?.length).toBe(1);
    });

    it('does not duplicate the ping when the reply target is also mentioned inline', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({
                discordUserId: 'duser-original',
                fluxerUserId: '42',
            })
        );
        const transformer = new FluxerMessageTransformer(mentionBridge);

        const result = await transformer.transformMessage(
            fakeFluxerReply({
                pings: true,
                content: 'hi <@42>',
                guildId: 'fguild',
            }) as never
        );

        expect(result.content).toBe('hi <@duser-original>');
        expect(result.mentionUserIds).toEqual(['duser-original']);
    });

    it('still resolves mapped mentions on edits, without logging', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const client = fakeFluxerClient([fakeFluxerUser('42', 'alice')]);
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');
        const info = vi.mocked(logger.info);
        info.mockClear();

        const result = await transformer.transformMessage(
            fakeFluxerMessage(
                { content: 'hi <@42> and <@99>', guildId: 'fguild' },
                client
            ) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe(
            `hi <@discord-42> and @${ZWSP}unknown-user`
        );
        expect(result.mentionUserIds).toEqual(['discord-42']);
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ isEdit: true })
        );
        expect(log).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('does not re-log unresolved mentions when transforming an edit', async () => {
        const client = fakeFluxerClient([fakeFluxerUser('42', 'alice')]);
        const transformer = new FluxerMessageTransformer(mentionBridge);
        const resolve = vi.spyOn(mentionBridge, 'resolveUserMentions');
        const log = vi.spyOn(mentionBridge, 'logUnresolvedUserMentions');

        const result = await transformer.transformMessage(
            fakeFluxerMessage(
                { content: 'hi <@42>', guildId: 'fguild' },
                client
            ) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe(`hi @${ZWSP}alice`);
        expect(resolve).toHaveBeenCalledWith(
            expect.objectContaining({ isEdit: true })
        );
        expect(log).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when no mention bridge is configured', async () => {
        const transformer = new FluxerMessageTransformer();
        const client = fakeFluxerClient([fakeFluxerUser('42', 'alice')]);

        const plain = await transformer.transformMessage(
            fakeFluxerMessage({ content: 'hi <@42>' }, client) as never
        );
        expect(plain).toStrictEqual({
            content: `hi @${ZWSP}alice`,
            username: 'fran',
            avatarURL: 'https://avatars/fuser',
            attachments: [],
            embeds: [],
        });

        const reply = await transformer.transformMessage(
            fakeFluxerReply({ pings: true }) as never
        );
        expect(reply.content).toBe('hello');
        expect('mentionUserIds' in reply).toBe(false);
    });
});
