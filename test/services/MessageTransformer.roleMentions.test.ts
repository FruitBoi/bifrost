import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { PermissionFlags } from '@fluxerjs/core';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import MentionBridgeService, {
    CounterpartRoleLookup,
    GeneralRole,
} from '../../src/services/mentionBridge/MentionBridgeService';
import { FakeLinkService, guildLink, makeUserLink } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

const ZWSP = '​';

// sanitizeMentions only recognises numeric ids, so the linked guilds (and
// hence the @everyone roles, whose id is the guild id) need numeric ids too.
const numericGuildLink = {
    ...guildLink,
    discordGuildId: '100',
    fluxerGuildId: '200',
};

type FakeRole = { id: string; name: string; mentionable: boolean };

function fakeRoleLookup({
    discord = [],
    fluxer = [],
}: { discord?: GeneralRole[]; fluxer?: GeneralRole[] } = {}) {
    const fetchDiscordRoles = vi.fn(async (_guildId: string) => discord);
    const fetchFluxerRoles = vi.fn(async (_guildId: string) => fluxer);
    const lookup: CounterpartRoleLookup = {
        fetchDiscordRoles,
        fetchFluxerRoles,
    };
    return { lookup, fetchDiscordRoles, fetchFluxerRoles };
}

/** A member whose permission check answers true only for the given flags. */
function fakeMember(flags: bigint[]) {
    return {
        permissions: {
            has: (flag: bigint) => flags.includes(flag),
        },
    };
}

// ---------------------------------------------------------------------------
// Discord fakes
// ---------------------------------------------------------------------------

function fakeDiscordUser(id: string, username: string) {
    return { id, username, avatarURL: () => `https://avatars/${id}` };
}

function fakeDiscordClient(users: ReturnType<typeof fakeDiscordUser>[] = []) {
    return {
        users: { cache: new Map(users.map((u) => [u.id, u])) },
        channels: { cache: new Map() },
        guilds: { cache: new Map() },
    };
}

function fakeDiscordGuild(id: string, roles: FakeRole[]) {
    return {
        id,
        roles: { cache: new Map(roles.map((r) => [r.id, r])) },
    };
}

function fakeDiscordMessage(
    overrides: Record<string, unknown> = {},
    client = fakeDiscordClient()
) {
    return {
        id: 'dmsg-1',
        content: 'hello',
        author: fakeDiscordUser('duser', 'dave'),
        client,
        guild: null,
        guildId: null,
        member: null,
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

/** A message written in the linked Discord guild, whose roles are given. */
function discordGuildMessage(
    content: string,
    roles: FakeRole[],
    {
        canMentionEveryone = false,
        client = fakeDiscordClient(),
        extra = {},
    }: {
        canMentionEveryone?: boolean;
        client?: ReturnType<typeof fakeDiscordClient>;
        extra?: Record<string, unknown>;
    } = {}
) {
    return fakeDiscordMessage(
        {
            content,
            guildId: '100',
            guild: fakeDiscordGuild('100', roles),
            member: fakeMember(
                canMentionEveryone ? [PermissionFlagsBits.MentionEveryone] : []
            ),
            ...extra,
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

function fakeFluxerClient(users: ReturnType<typeof fakeFluxerUser>[] = []) {
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
        users: { get: (id: string) => byId.get(id) ?? null },
        channels: { get: () => null },
    };
}

function fakeFluxerGuild(id: string, roles: FakeRole[]) {
    const byId = new Map(roles.map((r) => [r.id, r]));
    return {
        id,
        roles: { get: (roleId: string) => byId.get(roleId) ?? undefined },
    };
}

function fakeFluxerMessage(
    overrides: Record<string, unknown> = {},
    client = fakeFluxerClient()
) {
    return {
        id: 'fmsg-1',
        content: 'hello',
        author: fakeFluxerUser('fuser', 'fran'),
        client,
        guild: null,
        guildId: null,
        member: null,
        attachments: [],
        stickers: [],
        embeds: [],
        referencedMessage: null,
        mentions: [],
        webhookId: null,
        ...overrides,
    };
}

/** A message written in the linked Fluxer guild, whose roles are given. */
function fluxerGuildMessage(
    content: string,
    roles: FakeRole[],
    {
        canMentionEveryone = false,
        client = fakeFluxerClient(),
        extra = {},
    }: {
        canMentionEveryone?: boolean;
        client?: ReturnType<typeof fakeFluxerClient>;
        extra?: Record<string, unknown>;
    } = {}
) {
    return fakeFluxerMessage(
        {
            content,
            guildId: '200',
            guild: fakeFluxerGuild('200', roles),
            member: fakeMember(
                canMentionEveryone ? [PermissionFlags.MentionEveryone] : []
            ),
            ...extra,
        },
        client
    );
}

// ---------------------------------------------------------------------------

const MODS_DISCORD: FakeRole = {
    id: '1001',
    name: 'Mods',
    mentionable: true,
};
const MODS_FLUXER: FakeRole = {
    id: '2001',
    name: 'Mods',
    mentionable: true,
};

describe('DiscordMessageTransformer role mentions (Discord -> Fluxer)', () => {
    let links: FakeLinkService;

    const bridgeWith = (
        fluxerRoles: GeneralRole[],
        options: { bridgeRoleMentions?: boolean } = {}
    ) => {
        const { lookup, fetchFluxerRoles, fetchDiscordRoles } = fakeRoleLookup({
            fluxer: fluxerRoles,
        });
        const bridge = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
            ...options,
        });
        return { bridge, fetchFluxerRoles, fetchDiscordRoles };
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        links.guildLinks = [numericGuildLink];
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    });

    it('relays a mentionable role as a real ping of the Fluxer role of the same name', async () => {
        const { bridge, fetchFluxerRoles } = bridgeWith([
            { id: '2002', name: 'Admins' },
            { id: '2001', name: 'Mods' },
        ]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('hey <@&1001> please look', [
                MODS_DISCORD,
            ]) as never
        );

        expect(result.content).toBe('hey <@&2001> please look');
        expect(result.mentionRoleIds).toEqual(['2001']);
        expect(result.mentionUserIds).toBeUndefined();
        expect(fetchFluxerRoles).toHaveBeenCalledTimes(1);
        expect(fetchFluxerRoles).toHaveBeenCalledWith('200');
    });

    it('relays an unmatched role as plaintext @Name without whitelisting anything', async () => {
        const { bridge } = bridgeWith([{ id: '2002', name: 'Admins' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('hey <@&1001>', [MODS_DISCORD]) as never
        );

        expect(result.content).toBe('hey @Mods');
        expect(result.mentionRoleIds).toBeUndefined();
        expect('mentionRoleIds' in result).toBe(false);
    });

    it('relays a non-mentionable role as plaintext when the author lacks Mention Everyone', async () => {
        const { bridge, fetchFluxerRoles } = bridgeWith([
            { id: '2001', name: 'Mods' },
        ]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage(
                'hey <@&1001>',
                [{ ...MODS_DISCORD, mentionable: false }],
                { canMentionEveryone: false }
            ) as never
        );

        expect(result.content).toBe('hey @Mods');
        expect(result.mentionRoleIds).toBeUndefined();
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
    });

    it('bridges a non-mentionable role when the author holds Mention Everyone', async () => {
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage(
                'hey <@&1001>',
                [{ ...MODS_DISCORD, mentionable: false }],
                { canMentionEveryone: true }
            ) as never
        );

        expect(result.content).toBe('hey <@&2001>');
        expect(result.mentionRoleIds).toEqual(['2001']);
    });

    it('treats a message without a member as written by someone who may not ping locked roles', async () => {
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage(
                'hey <@&1001>',
                [{ ...MODS_DISCORD, mentionable: false }],
                { extra: { member: null } }
            ) as never
        );

        expect(result.content).toBe('hey @Mods');
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('bridges a user mention and a role mention in the same message', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage(
                'hi <@42>, <@&1001> and <@99>',
                [MODS_DISCORD],
                { client: fakeDiscordClient([fakeDiscordUser('99', 'bob')]) }
            ) as never
        );

        expect(result.content).toBe('hi <@fluxer-42>, <@&2001> and @bob');
        expect(result.mentionUserIds).toEqual(['fluxer-42']);
        expect(result.mentionRoleIds).toEqual(['2001']);
    });

    it('still blocks @everyone: the guild-id role is never bridged even to a Fluxer role named @everyone', async () => {
        const { bridge, fetchFluxerRoles } = bridgeWith([
            { id: '200', name: '@everyone' },
            { id: '2999', name: '@everyone' },
        ]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage(
                '@everyone <@&100> wake up',
                [{ id: '100', name: '@everyone', mentionable: true }],
                { canMentionEveryone: true }
            ) as never
        );

        expect(result.content).toBe('@everyone @@everyone wake up');
        expect(result.mentionRoleIds).toBeUndefined();
        expect(result.mentionUserIds).toBeUndefined();
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
    });

    it('never matches a Fluxer role literally named @everyone for an ordinary role', async () => {
        const { bridge } = bridgeWith([{ id: '2999', name: '@everyone' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('<@&1003>', [
                { id: '1003', name: '@everyone', mentionable: true },
            ]) as never
        );

        expect(result.content).toBe('@@everyone');
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('relays roles as plaintext when roles.bridgeMentions is off', async () => {
        const { bridge, fetchFluxerRoles } = bridgeWith(
            [{ id: '2001', name: 'Mods' }],
            { bridgeRoleMentions: false }
        );
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('hey <@&1001>', [MODS_DISCORD]) as never
        );

        expect(result.content).toBe('hey @Mods');
        expect(result.mentionRoleIds).toBeUndefined();
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
    });

    it('relays roles as plaintext without a mention bridge at all', async () => {
        const transformer = new DiscordMessageTransformer();

        const result = await transformer.transformMessage(
            discordGuildMessage('hey <@&1001>', [MODS_DISCORD]) as never
        );

        expect(result.content).toBe('hey @Mods');
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('keeps the role ping markup and ids on an edit (the webhook layer decides not to re-ping)', async () => {
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        const result = await transformer.transformMessage(
            discordGuildMessage('hey <@&1001>', [MODS_DISCORD]) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe('hey <@&2001>');
        expect(result.mentionRoleIds).toEqual(['2001']);
        expect(info).not.toHaveBeenCalled();
    });

    it('dedupes a role mentioned twice into one whitelisted id', async () => {
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('<@&1001> and <@&1001>', [
                MODS_DISCORD,
            ]) as never
        );

        expect(result.content).toBe('<@&2001> and <@&2001>');
        expect(result.mentionRoleIds).toEqual(['2001']);
    });

    it('whitelists no roles for a poll, whose content is generated', async () => {
        const { bridge } = bridgeWith([{ id: '2001', name: 'Mods' }]);
        const transformer = new DiscordMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            discordGuildMessage('vote <@&1001>', [MODS_DISCORD], {
                extra: {
                    poll: {
                        question: { text: 'Pizza?' },
                        answers: [{ text: 'yes' }, { text: 'no' }],
                        expiresTimestamp: Date.now() + 60_000,
                    },
                },
            }) as never
        );

        expect(result.content).not.toContain('<@&');
        expect(result.mentionRoleIds).toBeUndefined();
    });
});

describe('FluxerMessageTransformer role mentions (Fluxer -> Discord)', () => {
    let links: FakeLinkService;

    const bridgeWith = (
        discordRoles: GeneralRole[],
        options: { bridgeRoleMentions?: boolean } = {}
    ) => {
        const { lookup, fetchFluxerRoles, fetchDiscordRoles } = fakeRoleLookup({
            discord: discordRoles,
        });
        const bridge = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
            ...options,
        });
        return { bridge, fetchFluxerRoles, fetchDiscordRoles };
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        links.guildLinks = [numericGuildLink];
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    });

    it('relays a mentionable role as a real ping of the Discord role of the same name, unbroken by the ZWSP', async () => {
        const { bridge, fetchDiscordRoles, fetchFluxerRoles } = bridgeWith([
            { id: '1002', name: 'Admins' },
            { id: '1001', name: 'Mods' },
        ]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hey <@&2001> please look', [
                MODS_FLUXER,
            ]) as never
        );

        expect(result.content).toBe('hey <@&1001> please look');
        expect(result.content).not.toContain(ZWSP);
        expect(result.mentionRoleIds).toEqual(['1001']);
        expect(result.mentionUserIds).toBeUndefined();
        expect(fetchDiscordRoles).toHaveBeenCalledTimes(1);
        expect(fetchDiscordRoles).toHaveBeenCalledWith('100');
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
    });

    it('relays an unmatched role as ZWSP-broken plaintext without whitelisting anything', async () => {
        const { bridge } = bridgeWith([{ id: '1002', name: 'Admins' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hey <@&2001>', [MODS_FLUXER]) as never
        );

        expect(result.content).toBe(`hey @${ZWSP}Mods`);
        expect('mentionRoleIds' in result).toBe(false);
    });

    it('relays a non-mentionable role as plaintext when the author lacks Mention Everyone', async () => {
        const { bridge, fetchDiscordRoles } = bridgeWith([
            { id: '1001', name: 'Mods' },
        ]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage(
                'hey <@&2001>',
                [{ ...MODS_FLUXER, mentionable: false }],
                { canMentionEveryone: false }
            ) as never
        );

        expect(result.content).toBe(`hey @${ZWSP}Mods`);
        expect(result.mentionRoleIds).toBeUndefined();
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
    });

    it('bridges a non-mentionable role when the author holds Mention Everyone', async () => {
        const { bridge } = bridgeWith([{ id: '1001', name: 'Mods' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage(
                'hey <@&2001>',
                [{ ...MODS_FLUXER, mentionable: false }],
                { canMentionEveryone: true }
            ) as never
        );

        expect(result.content).toBe('hey <@&1001>');
        expect(result.mentionRoleIds).toEqual(['1001']);
    });

    it('treats a message without a member as written by someone who may not ping locked roles', async () => {
        const { bridge } = bridgeWith([{ id: '1001', name: 'Mods' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage(
                'hey <@&2001>',
                [{ ...MODS_FLUXER, mentionable: false }],
                { extra: { member: null } }
            ) as never
        );

        expect(result.content).toBe(`hey @${ZWSP}Mods`);
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('bridges a user mention and a role mention in the same message', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const { bridge } = bridgeWith([{ id: '1001', name: 'Mods' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hi <@42>, <@&2001> and <@99>', [MODS_FLUXER], {
                client: fakeFluxerClient([fakeFluxerUser('99', 'bob')]),
            }) as never
        );

        expect(result.content).toBe(
            `hi <@discord-42>, <@&1001> and @${ZWSP}bob`
        );
        expect(result.mentionUserIds).toEqual(['discord-42']);
        expect(result.mentionRoleIds).toEqual(['1001']);
    });

    it('still blocks @everyone: the guild-id role is never bridged even to a Discord role named @everyone', async () => {
        const { bridge, fetchDiscordRoles } = bridgeWith([
            { id: '100', name: '@everyone' },
            { id: '1999', name: '@everyone' },
        ]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage(
                '@everyone <@&200> wake up',
                [{ id: '200', name: '@everyone', mentionable: true }],
                { canMentionEveryone: true }
            ) as never
        );

        expect(result.content).toBe(
            `@${ZWSP}everyone @${ZWSP}@${ZWSP}everyone wake up`
        );
        expect(result.content).not.toContain('<@&');
        expect(result.mentionRoleIds).toBeUndefined();
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
    });

    it('never matches a Discord role literally named @everyone for an ordinary role', async () => {
        const { bridge } = bridgeWith([{ id: '1999', name: '@everyone' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('<@&2003>', [
                { id: '2003', name: '@everyone', mentionable: true },
            ]) as never
        );

        expect(result.content).toBe(`@${ZWSP}@${ZWSP}everyone`);
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('relays roles as plaintext when roles.bridgeMentions is off', async () => {
        const { bridge, fetchDiscordRoles } = bridgeWith(
            [{ id: '1001', name: 'Mods' }],
            { bridgeRoleMentions: false }
        );
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hey <@&2001>', [MODS_FLUXER]) as never
        );

        expect(result.content).toBe(`hey @${ZWSP}Mods`);
        expect(result.mentionRoleIds).toBeUndefined();
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
    });

    it('relays roles as plaintext without a mention bridge at all', async () => {
        const transformer = new FluxerMessageTransformer();

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hey <@&2001>', [MODS_FLUXER]) as never
        );

        expect(result.content).toBe(`hey @${ZWSP}Mods`);
        expect(result.mentionRoleIds).toBeUndefined();
    });

    it('keeps the role ping markup and ids on an edit (the webhook layer decides not to re-ping)', async () => {
        const { bridge } = bridgeWith([{ id: '1001', name: 'Mods' }]);
        const transformer = new FluxerMessageTransformer(bridge);
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('hey <@&2001>', [MODS_FLUXER]) as never,
            [],
            { isEdit: true }
        );

        expect(result.content).toBe('hey <@&1001>');
        expect(result.mentionRoleIds).toEqual(['1001']);
        expect(info).not.toHaveBeenCalled();
    });

    it('dedupes a role mentioned twice into one whitelisted id', async () => {
        const { bridge } = bridgeWith([{ id: '1001', name: 'Mods' }]);
        const transformer = new FluxerMessageTransformer(bridge);

        const result = await transformer.transformMessage(
            fluxerGuildMessage('<@&2001> and <@&2001>', [MODS_FLUXER]) as never
        );

        expect(result.content).toBe('<@&1001> and <@&1001>');
        expect(result.mentionRoleIds).toEqual(['1001']);
    });
});
