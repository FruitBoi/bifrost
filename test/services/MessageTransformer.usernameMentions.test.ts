import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import {
    FakeLinkService,
    FakeMemberLookup,
    makeUserLink,
} from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

const ZWSP = '​';

function fakeUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeDiscordMessage(
    content: string,
    users: ReturnType<typeof fakeUser>[] = [],
    overrides: Record<string, unknown> = {}
) {
    return {
        id: 'dmsg',
        content,
        guildId: 'dguild',
        author: fakeUser('duser', 'dave'),
        client: {
            users: { cache: new Map(users.map((u) => [u.id, u])) },
            channels: { cache: new Map() },
            guilds: { cache: new Map() },
        },
        guild: null,
        attachments: [],
        stickers: [],
        embeds: [],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map(), everyone: false },
        ...overrides,
    };
}

function fakeFluxerMessage(
    content: string,
    users: ReturnType<typeof fakeUser>[] = [],
    overrides: Record<string, unknown> = {}
) {
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
        id: 'fmsg',
        content,
        guildId: 'fguild',
        author: fakeUser('fuser', 'fran'),
        client: {
            users: { get: (id: string) => byId.get(id) ?? null },
            channels: { get: () => null },
        },
        guild: null,
        attachments: new Map(),
        stickers: [],
        embeds: [],
        referencedMessage: null,
        mentions: [],
        webhookId: null,
        ...overrides,
    };
}

describe('DiscordMessageTransformer username mentions', () => {
    let links: FakeLinkService;
    let lookup: FakeMemberLookup;
    let transformer: DiscordMessageTransformer;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        links = new FakeLinkService();
        lookup = new FakeMemberLookup();
        transformer = new DiscordMessageTransformer(
            new MentionBridgeService(links.asLinkService(), {
                memberLookup: lookup,
            })
        );
    });

    it('turns a typed @name into a ping of the Fluxer namesake and whitelists it', async () => {
        lookup.fluxerMembers.push({
            id: 'f-alice',
            username: 'alice',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeDiscordMessage('hey @alice, look') as never
        );

        expect(result.content).toBe('hey <@f-alice>, look');
        expect(result.mentionUserIds).toEqual(['f-alice']);
    });

    it('relays an unmatched @name as it is', async () => {
        const result = await transformer.transformMessage(
            fakeDiscordMessage('hey @nobody') as never
        );

        expect(result.content).toBe('hey @nobody');
        expect('mentionUserIds' in result).toBe(false);
    });

    it('leaves @name in code alone and still breaks @everyone', async () => {
        lookup.fluxerMembers.push({
            id: 'f-alice',
            username: 'alice',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeDiscordMessage('`@alice` @everyone @alice') as never
        );

        expect(result.content).toBe(`\`@alice\` @${ZWSP}everyone <@f-alice>`);
        expect(result.mentionUserIds).toEqual(['f-alice']);
    });

    it('falls back to the username for an unmapped <@id>', async () => {
        lookup.fluxerMembers.push({
            id: 'f-alice',
            username: 'alice',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeDiscordMessage('hi <@42>', [fakeUser('42', 'alice')]) as never
        );

        expect(result.content).toBe('hi <@f-alice>');
        expect(result.mentionUserIds).toEqual(['f-alice']);
    });

    it('keeps using the mapping for a mapped <@id>', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'f-mapped' })
        );
        lookup.fluxerMembers.push({
            id: 'f-alice',
            username: 'alice',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeDiscordMessage('hi <@42>', [fakeUser('42', 'alice')]) as never
        );

        expect(result.content).toBe('hi <@f-mapped>');
        expect(result.mentionUserIds).toEqual(['f-mapped']);
    });

    it('does not ping outside a linked guild', async () => {
        lookup.fluxerMembers.push({
            id: 'f-alice',
            username: 'alice',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeDiscordMessage('hey @alice', [], {
                guildId: 'unlinked',
            }) as never
        );

        expect(result.content).toBe('hey @alice');
        expect('mentionUserIds' in result).toBe(false);
    });
});

describe('FluxerMessageTransformer username mentions', () => {
    let links: FakeLinkService;
    let lookup: FakeMemberLookup;
    let transformer: FluxerMessageTransformer;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        links = new FakeLinkService();
        lookup = new FakeMemberLookup();
        transformer = new FluxerMessageTransformer(
            new MentionBridgeService(links.asLinkService(), {
                memberLookup: lookup,
            })
        );
    });

    it('turns a typed @name into a ping of the Discord namesake and whitelists it', async () => {
        lookup.discordMembers.push({
            id: 'd-bob',
            username: 'Bob',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeFluxerMessage('thanks @bob.') as never
        );

        expect(result.content).toBe('thanks <@d-bob>.');
        expect(result.mentionUserIds).toEqual(['d-bob']);
    });

    it('relays an unmatched @name with its @ broken, as before', async () => {
        const result = await transformer.transformMessage(
            fakeFluxerMessage('thanks @nobody') as never
        );

        expect(result.content).toBe(`thanks @${ZWSP}nobody`);
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not ping a bot namesake', async () => {
        lookup.discordMembers.push({ id: 'd-bot', username: 'bob', bot: true });

        const result = await transformer.transformMessage(
            fakeFluxerMessage('hi @bob') as never
        );

        expect(result.content).toBe(`hi @${ZWSP}bob`);
        expect('mentionUserIds' in result).toBe(false);
    });

    it('falls back to the username for an unmapped <@id>', async () => {
        lookup.discordMembers.push({
            id: 'd-bob',
            username: 'bob',
            bot: false,
        });

        const result = await transformer.transformMessage(
            fakeFluxerMessage('hi <@42> and @bob', [
                fakeUser('42', 'bob'),
            ]) as never
        );

        expect(result.content).toBe('hi <@d-bob> and <@d-bob>');
        expect(result.mentionUserIds).toEqual(['d-bob']);
    });

    it('keeps an unmatched <@id> as broken plaintext', async () => {
        const result = await transformer.transformMessage(
            fakeFluxerMessage('hi <@42>', [fakeUser('42', 'carol')]) as never
        );

        expect(result.content).toBe(`hi @${ZWSP}carol`);
        expect('mentionUserIds' in result).toBe(false);
    });

    it('does not search the text without a member lookup', async () => {
        const plain = new FluxerMessageTransformer(
            new MentionBridgeService(links.asLinkService())
        );

        const result = await plain.transformMessage(
            fakeFluxerMessage('hi @bob') as never
        );

        expect(result.content).toBe(`hi @${ZWSP}bob`);
    });
});
