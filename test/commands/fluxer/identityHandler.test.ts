import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, Message } from '@fluxerjs/core';
import { Collection } from 'discord.js';
import IdentityFluxerCommandHandler from '../../../src/commands/fluxer/handlers/IdentityFluxerCommandHandler';
import { LinkService } from '../../../src/services/LinkService';
import DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import ThreadMemberSyncService from '../../../src/services/threadMemberSync/ThreadMemberSyncService';
import { EmbedColors } from '../../../src/utils/embeds';

const IDENTITY_ROLE = '1561105750388908139';
const FLUXER_USER = '111111111111111111';
const DISCORD_USER = '222222222222222222';
const DISCORD_GUILD = '333333333333333333';
const GUILD_LINK = { id: 'gl-1', discordGuildId: DISCORD_GUILD };

const client = { user: { id: 'bot' } } as unknown as Client;

interface FakeMessageOptions {
    inGuild?: boolean;
    /** Role IDs of the author; allowed by default. */
    roles?: string[];
    /** Role IDs the target Fluxer member already holds. */
    targetRoles?: string[];
    /** Whether the target Fluxer member can be fetched. */
    targetFound?: boolean;
    /** Roles of the Fluxer guild, as `fetchRoles` returns them. */
    fluxerRoles?: { id: string; name: string }[];
}

function makeMessage({
    inGuild = true,
    roles = [IDENTITY_ROLE],
    targetRoles = [],
    targetFound = true,
    fluxerRoles = [],
}: FakeMessageOptions = {}) {
    const author = {
        id: 'author',
        roles: { has: (id: string) => roles.includes(id) },
    };
    const addRole = vi.fn().mockResolvedValue(undefined);
    const target = {
        id: FLUXER_USER,
        roles: {
            has: (id: string) => targetRoles.includes(id),
            add: addRole,
        },
    };
    const guild = {
        id: 'guild-1',
        fetchMember: vi.fn(async (id: string) => {
            if (id === 'author') return author;
            if (id === FLUXER_USER && targetFound) return target;
            throw new Error('Unknown Member');
        }),
        fetchRoles: vi.fn(async () => [
            { id: 'guild-1', name: '@everyone' },
            ...fluxerRoles,
        ]),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '2000',
        content: '!b role',
        channelId: 'chan-1',
        guildId: inGuild ? 'guild-1' : null,
        author: { id: 'author', bot: false, username: 'author' },
        guild: inGuild ? guild : null,
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        reply,
    };
    return { message: message as unknown as Message, reply, addRole };
}

interface FakeDiscordRole {
    id: string;
    name: string;
    managed?: boolean;
}

/** The linked Discord guild with one member, `DISCORD_USER`, holding `roles`. */
function makeDiscordGuild(roles: FakeDiscordRole[] = []) {
    const cache = new Collection(
        roles.map((role) => [role.id, { managed: false, ...role }])
    );
    const member = {
        id: DISCORD_USER,
        user: { username: 'disco' },
        roles: { cache },
    };
    return {
        id: DISCORD_GUILD,
        members: {
            fetch: vi.fn(async (id: string) => {
                if (id === DISCORD_USER) return member;
                throw new Error('Unknown Member');
            }),
        },
    };
}

function makeServices(discordRoles: FakeDiscordRole[] = []) {
    const setUserLink = vi.fn().mockResolvedValue({
        link: { id: 'ul-1' },
        unchanged: false,
        replaced: [],
    });
    const linkService = {
        getGuildLinkForFluxerGuild: vi.fn().mockResolvedValue(GUILD_LINK),
        setUserLink,
    };
    const discordEntityResolver = {
        fetchGuild: vi.fn().mockResolvedValue(makeDiscordGuild(discordRoles)),
    };
    const addFluxerUserToDiscordUsersThreads = vi.fn().mockResolvedValue({
        examined: 0,
        added: [],
        already: [],
        failed: [],
        unchecked: [],
    });
    const handler = new IdentityFluxerCommandHandler(
        client,
        linkService as unknown as LinkService,
        discordEntityResolver as unknown as DiscordEntityResolver,
        {
            addFluxerUserToDiscordUsersThreads,
        } as unknown as ThreadMemberSyncService,
        [IDENTITY_ROLE]
    );
    return { handler, setUserLink, addFluxerUserToDiscordUsersThreads };
}

/** The single embed of the first reply. */
function replyEmbed(reply: ReturnType<typeof vi.fn>): {
    title?: string;
    description?: string;
    color?: number;
} {
    expect(reply).toHaveBeenCalledTimes(1);
    const embeds = reply.mock.calls[0][0].embeds;
    expect(embeds).toHaveLength(1);
    return embeds[0].data;
}

const PAIR = {
    guildLinkId: GUILD_LINK.id,
    discordUserId: DISCORD_USER,
    fluxerUserId: FLUXER_USER,
};

describe('IdentityFluxerCommandHandler', () => {
    let services: ReturnType<typeof makeServices>;

    beforeEach(() => {
        services = makeServices();
    });

    describe('preamble', () => {
        it('refuses outside servers', async () => {
            const { message, reply } = makeMessage({ inGuild: false });
            await services.handler.handleCommand(
                message,
                'map',
                `<@${FLUXER_USER}>`,
                DISCORD_USER
            );
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This command must be used in a server.',
                color: EmbedColors.Error,
            });
            expect(services.setUserLink).not.toHaveBeenCalled();
        });

        it('refuses callers without an allowed role', async () => {
            const { message, reply } = makeMessage({ roles: ['other'] });
            await services.handler.handleCommand(
                message,
                'role',
                `<@${FLUXER_USER}>`,
                DISCORD_USER
            );
            expect(replyEmbed(reply)).toMatchObject({
                description:
                    'You do not have a role that is allowed to use this command.',
                color: EmbedColors.Error,
            });
            expect(services.setUserLink).not.toHaveBeenCalled();
        });

        it.each([
            ['map', [`<@${FLUXER_USER}>`]],
            ['role', [`<@${FLUXER_USER}>`]],
            ['map', [`<@${FLUXER_USER}>`, 'not-a-snowflake']],
            ['role', ['not-a-mention', DISCORD_USER]],
            ['role', [`<@${FLUXER_USER}>`, DISCORD_USER, 'extra']],
        ])('shows the usage of %s on bad args %j', async (command, args) => {
            const { message, reply } = makeMessage();
            await services.handler.handleCommand(message, command, ...args);
            const embed = replyEmbed(reply);
            expect(embed.title).toBe('Command Usage');
            expect(embed.description).toContain(`${command} `);
            expect(services.setUserLink).not.toHaveBeenCalled();
        });

        it('accepts a bare Fluxer user ID in place of a mention', async () => {
            const { message } = makeMessage();
            await services.handler.handleCommand(
                message,
                'map',
                FLUXER_USER,
                DISCORD_USER
            );
            expect(services.setUserLink).toHaveBeenCalledWith(PAIR);
        });

        it('reports an unlinked server', async () => {
            const linkService = {
                getGuildLinkForFluxerGuild: vi.fn().mockResolvedValue(null),
                setUserLink: services.setUserLink,
            };
            const handler = new IdentityFluxerCommandHandler(
                client,
                linkService as unknown as LinkService,
                {} as DiscordEntityResolver,
                {} as ThreadMemberSyncService,
                [IDENTITY_ROLE]
            );
            const { message, reply } = makeMessage();
            await handler.handleCommand(
                message,
                'map',
                `<@${FLUXER_USER}>`,
                DISCORD_USER
            );
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This server is not linked to a Discord server.',
                color: EmbedColors.Error,
            });
            expect(services.setUserLink).not.toHaveBeenCalled();
        });

        it('reports an unknown Discord member', async () => {
            const { message, reply } = makeMessage();
            await services.handler.handleCommand(
                message,
                'map',
                `<@${FLUXER_USER}>`,
                '444444444444444444'
            );
            expect(replyEmbed(reply)).toMatchObject({
                description:
                    'No member with the ID `444444444444444444` was found in the linked Discord server.',
                color: EmbedColors.Error,
            });
            expect(services.setUserLink).not.toHaveBeenCalled();
        });

        it('reports a Fluxer user who is not a member', async () => {
            const { message, reply } = makeMessage({ targetFound: false });
            await services.handler.handleCommand(
                message,
                'map',
                `<@${FLUXER_USER}>`,
                DISCORD_USER
            );
            expect(replyEmbed(reply)).toMatchObject({
                description: `<@${FLUXER_USER}> is not a member of this server.`,
                color: EmbedColors.Error,
            });
            expect(services.setUserLink).not.toHaveBeenCalled();
        });
    });

    // `map` is an alias of `role`: both names must behave identically.
    describe.each(['role', 'map'])('%s', (command) => {
        const run = async (message: Message) =>
            services.handler.handleCommand(
                message,
                command,
                `<@${FLUXER_USER}>`,
                DISCORD_USER
            );

        it('copies roles by name, maps the identity and syncs threads', async () => {
            services = makeServices([
                { id: DISCORD_GUILD, name: '@everyone' },
                { id: 'd-admin', name: 'Admin' },
                { id: 'd-member', name: 'Member' },
                { id: 'd-bot', name: 'Bot', managed: true },
                { id: 'd-nowhere', name: 'Nowhere' },
            ]);
            services.setUserLink.mockResolvedValueOnce({
                link: { id: 'ul-2' },
                unchanged: false,
                replaced: [
                    {
                        id: 'ul-1',
                        guildLinkId: GUILD_LINK.id,
                        discordUserId: '777777777777777777',
                        fluxerUserId: FLUXER_USER,
                    },
                ],
            });
            services.addFluxerUserToDiscordUsersThreads.mockResolvedValueOnce({
                examined: 2,
                added: [{ name: 'design' }],
                already: [{ name: 'general' }],
                failed: [],
                unchecked: [],
            });
            const { message, reply, addRole } = makeMessage({
                targetRoles: ['f-member'],
                fluxerRoles: [
                    { id: 'f-admin', name: 'Admin' },
                    { id: 'f-member', name: 'Member' },
                    { id: 'f-bot', name: 'Bot' },
                    { id: 'f-other', name: 'Other' },
                ],
            });
            await run(message);

            expect(addRole).toHaveBeenCalledTimes(1);
            expect(addRole).toHaveBeenCalledWith('f-admin');
            expect(services.setUserLink).toHaveBeenCalledWith(PAIR);
            expect(
                services.addFluxerUserToDiscordUsersThreads
            ).toHaveBeenCalledWith(PAIR);

            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Success);
            expect(embed.description?.split('\n')).toEqual([
                `Treating <@${FLUXER_USER}> as Discord user \`${DISCORD_USER}\` (disco).`,
                '**Added roles:** `Admin`',
                '**Already had roles:** `Member`',
                '**No Fluxer role with this name:** `Nowhere`',
                `**Identity:** <@${FLUXER_USER}> is now mapped to Discord user \`${DISCORD_USER}\`; pings of either account are bridged to the other. Replaced previous mapping (was Discord user \`777777777777777777\`).`,
                '**Added to threads:** `design`',
                '**Already in threads:** `general`',
            ]);
        });

        it('reports an unchanged identity and no roles to copy', async () => {
            services.setUserLink.mockResolvedValueOnce({
                link: { id: 'ul-1' },
                unchanged: true,
                replaced: [],
            });
            const { message, reply } = makeMessage();
            await run(message);
            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Success);
            expect(embed.description?.split('\n')).toEqual([
                `Treating <@${FLUXER_USER}> as Discord user \`${DISCORD_USER}\` (disco).`,
                '**Roles:** the Discord user has no roles to copy.',
                `**Identity:** <@${FLUXER_USER}> was already mapped to Discord user \`${DISCORD_USER}\`; pings keep bridging between them.`,
                '**Threads:** no bridged threads in this server.',
            ]);
        });

        it('warns when the thread sync fails', async () => {
            services.addFluxerUserToDiscordUsersThreads.mockRejectedValueOnce(
                new Error('boom')
            );
            const { message, reply } = makeMessage();
            await run(message);
            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Warning);
            expect(embed.description).toContain(
                '**Threads:** membership sync failed: boom'
            );
        });

        it('warns when the identity cannot be recorded', async () => {
            services.setUserLink.mockRejectedValueOnce(new Error('db down'));
            const { message, reply } = makeMessage();
            await run(message);
            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Warning);
            expect(embed.description).toContain(
                '**Identity:** could not record the mapping: db down'
            );
            expect(
                services.addFluxerUserToDiscordUsersThreads
            ).toHaveBeenCalledTimes(1);
        });
    });
});
