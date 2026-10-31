import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection } from 'discord.js';
import { PermissionFlags } from '@fluxerjs/core';
import RoleIconTransferService, {
    ImageDownloader,
    ROLE_ICON_MAX_BYTES,
    RoleIconTransferInProgressError,
} from '../../../src/services/roleIconTransfer/RoleIconTransferService';
import { RATE_LIMIT_MAX_ATTEMPTS } from '../../../src/services/expressionTransfer/ExpressionTransferService';
import DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import {
    isFluxerApiBlocked,
    markFluxerApiBlocked,
    markFluxerApiOk,
} from '../../../src/utils/fluxerApiGuard';

const DISCORD_GUILD = 'dguild';
const FLUXER_GUILD = 'fguild';
const BOT_ID = 'fluxer-bot';

interface FakeDiscordRole {
    id: string;
    name: string;
    icon?: string | null;
    unicodeEmoji?: string | null;
}

function discordRole({
    id,
    name,
    icon = null,
    unicodeEmoji = null,
}: FakeDiscordRole) {
    return {
        id,
        name,
        icon,
        unicodeEmoji,
        iconURL: vi.fn(
            ({ extension, size }: { extension: string; size: number }) =>
                icon
                    ? `https://cdn.discordapp.com/role-icons/${id}/${icon}.${extension}?size=${size}`
                    : null
        ),
    };
}

function makeDiscordGuild(roles: FakeDiscordRole[] = []) {
    return {
        id: DISCORD_GUILD,
        roles: {
            fetch: vi.fn(async () => {
                const coll = new Collection<string, unknown>();
                coll.set(
                    DISCORD_GUILD,
                    discordRole({
                        id: DISCORD_GUILD,
                        name: '@everyone',
                        unicodeEmoji: '🌍',
                    })
                );
                for (const r of roles) coll.set(r.id, discordRole(r));
                return coll;
            }),
        },
    };
}

interface FakeFluxerRole {
    id: string;
    name: string;
    icon?: string | null;
    unicode_emoji?: string | null;
}

interface FluxerGuildOptions {
    roles?: FakeFluxerRole[];
    /** Permission bits of the bot member; Manage Roles by default. */
    permissions?: bigint;
    /** Whether `members.me` is cached; otherwise `fetchMember` is used. */
    meCached?: boolean;
    /** Whether `fetchMember` can find the bot. */
    meFetchable?: boolean;
}

function makeFluxerGuild({
    roles = [],
    permissions = PermissionFlags.ManageRoles,
    meCached = true,
    meFetchable = true,
}: FluxerGuildOptions = {}) {
    const me = {
        id: BOT_ID,
        permissions: {
            has: (flag: bigint) => (permissions & flag) === flag,
        },
    };
    const fetchMember = vi.fn(async (id: string) => {
        if (id === BOT_ID && meFetchable) return me;
        throw new Error('Unknown Member');
    });
    const get = vi.fn(async (route: string) => {
        if (route !== `/guilds/${FLUXER_GUILD}/roles`) {
            throw new Error(`unexpected GET ${route}`);
        }
        return [
            { id: FLUXER_GUILD, name: '@everyone', unicode_emoji: null },
            ...roles.map((r) => ({
                icon: null,
                unicode_emoji: null,
                ...r,
            })),
        ];
    });
    const patch = vi.fn<
        (route: string, options: { body: unknown }) => Promise<unknown>
    >(async () => ({}));
    return {
        id: FLUXER_GUILD,
        client: { user: { id: BOT_ID }, rest: { get, patch } },
        members: { me: meCached ? me : null },
        fetchMember,
    };
}

type FakeDiscordGuild = ReturnType<typeof makeDiscordGuild>;
type FakeFluxerGuild = ReturnType<typeof makeFluxerGuild>;

const downloadOk: ImageDownloader = async (url) => ({
    bytes: Buffer.from(`bytes of ${url}`),
    contentType: url.includes('.webp') ? 'image/webp' : 'image/png',
});

function makeService({
    discordGuild = makeDiscordGuild() as FakeDiscordGuild | null,
    fluxerGuild = makeFluxerGuild() as FakeFluxerGuild | null,
    downloadImage = vi.fn(downloadOk) as ImageDownloader,
    sleep = vi.fn(async () => {}),
} = {}) {
    const discordEntityResolver = {
        fetchGuild: vi.fn(async (id: string) =>
            id === DISCORD_GUILD ? discordGuild : null
        ),
    } as unknown as DiscordEntityResolver;
    const fluxerEntityResolver = {
        fetchGuild: vi.fn(async (id: string) =>
            id === FLUXER_GUILD ? fluxerGuild : null
        ),
    } as unknown as FluxerEntityResolver;
    const service = new RoleIconTransferService({
        discordEntityResolver,
        fluxerEntityResolver,
        downloadImage,
        sleep,
    });
    return { service, downloadImage, sleep };
}

/** What `@fluxerjs/rest` throws on a 429 for a non-GET request. */
function rateLimitError(retryAfter?: number) {
    return Object.assign(new Error('You are being rate limited.'), {
        statusCode: 429,
        retryAfter,
    });
}

function iconUrl(id: string, hash: string, extension = 'png'): string {
    return `https://cdn.discordapp.com/role-icons/${id}/${hash}.${extension}?size=256`;
}

function dataUrlOf(url: string, mime = 'image/png'): string {
    return `data:${mime};base64,${Buffer.from(`bytes of ${url}`).toString('base64')}`;
}

/** The (role ID, body) pairs PATCHed, in order. */
function patches(guild: FakeFluxerGuild) {
    return guild.client.rest.patch.mock.calls.map(([route, options]) => [
        route.replace(`/guilds/${FLUXER_GUILD}/roles/`, ''),
        options.body,
    ]);
}

beforeEach(() => {
    markFluxerApiOk();
});

afterEach(() => {
    markFluxerApiOk();
    vi.restoreAllMocks();
});

describe('RoleIconTransferService.transfer', () => {
    it('copies unicode emojis and images onto same-named Fluxer roles', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Mods', unicodeEmoji: '🛡️' },
            { id: 'd2', name: 'Artists', icon: 'abc' },
            { id: 'd3', name: 'Plain' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f1', name: 'Mods' },
                { id: 'f2', name: 'Artists' },
                { id: 'f3', name: 'Plain' },
            ],
        });
        const { service, downloadImage } = makeService({
            discordGuild,
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report).toEqual({
            copied: ['Artists', 'Mods'],
            skipped: [],
            failed: [],
        });
        expect(patches(fluxerGuild)).toEqual([
            ['f2', { icon: dataUrlOf(iconUrl('d2', 'abc')) }],
            ['f1', { unicode_emoji: '🛡️' }],
        ]);
        expect(downloadImage).toHaveBeenCalledTimes(1);
        expect(downloadImage).toHaveBeenCalledWith(iconUrl('d2', 'abc'));
    });

    it('never touches @everyone on either side', async () => {
        const discordGuild = makeDiscordGuild();
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report).toEqual({ copied: [], skipped: [], failed: [] });
        expect(fluxerGuild.client.rest.patch).not.toHaveBeenCalled();
    });

    it('matches names exactly and skips roles missing on Fluxer', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'mods', unicodeEmoji: '🛡️' },
            { id: 'd2', name: 'Gone', unicodeEmoji: '👻' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'Mods' }],
        });
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual([]);
        expect(report.skipped).toEqual([
            { name: 'Gone', reason: 'no Fluxer role with this name' },
            { name: 'mods', reason: 'no Fluxer role with this name' },
        ]);
        expect(fluxerGuild.client.rest.patch).not.toHaveBeenCalled();
    });

    it('updates every Fluxer role sharing the name, downloading once', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Team', icon: 'img' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f2', name: 'Team' },
                { id: 'f1', name: 'Team' },
            ],
        });
        const { service, downloadImage } = makeService({
            discordGuild,
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['Team', 'Team']);
        expect(patches(fluxerGuild).map(([id]) => id)).toEqual(['f1', 'f2']);
        expect(downloadImage).toHaveBeenCalledTimes(1);
    });

    it('skips Discord duplicates with different icons, merges identical ones', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Twin', unicodeEmoji: '🔥' },
            { id: 'd2', name: 'Twin', unicodeEmoji: '💧' },
            { id: 'd3', name: 'Same', icon: 'h' },
            { id: 'd4', name: 'Same', icon: 'h' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f1', name: 'Twin' },
                { id: 'f2', name: 'Same' },
            ],
        });
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['Same']);
        expect(report.skipped).toEqual([
            {
                name: 'Twin',
                reason: 'Discord roles with this name have different icons',
            },
        ]);
        expect(patches(fluxerGuild)).toEqual([
            ['f2', { icon: dataUrlOf(iconUrl('d3', 'h')) }],
        ]);
    });

    it('prefers the image when a Discord role has both kinds of icon', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Both', icon: 'h', unicodeEmoji: '⭐' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'Both' }],
        });
        const { service } = makeService({ discordGuild, fluxerGuild });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(patches(fluxerGuild)).toEqual([
            ['f1', { icon: dataUrlOf(iconUrl('d1', 'h')) }],
        ]);
    });

    describe('existing Fluxer icons', () => {
        const discordRoles: FakeDiscordRole[] = [
            { id: 'd1', name: 'Emoji', unicodeEmoji: '⭐' },
            { id: 'd2', name: 'Same', unicodeEmoji: '✅' },
            { id: 'd3', name: 'Image', icon: 'h' },
        ];
        const fluxerRoles: FakeFluxerRole[] = [
            { id: 'f1', name: 'Emoji', icon: 'existing' },
            { id: 'f2', name: 'Same', unicode_emoji: '✅' },
            { id: 'f3', name: 'Image', unicode_emoji: '🎨' },
        ];

        it('skips them without overwrite', async () => {
            const fluxerGuild = makeFluxerGuild({ roles: fluxerRoles });
            const { service } = makeService({
                discordGuild: makeDiscordGuild(discordRoles),
                fluxerGuild,
            });

            const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

            expect(report.copied).toEqual([]);
            expect(report.skipped).toEqual([
                {
                    name: 'Emoji',
                    reason: 'already has an icon (use `overwrite`)',
                },
                {
                    name: 'Image',
                    reason: 'already has an icon (use `overwrite`)',
                },
                { name: 'Same', reason: 'already set' },
            ]);
            expect(fluxerGuild.client.rest.patch).not.toHaveBeenCalled();
        });

        it('replaces them with overwrite, except identical emojis', async () => {
            const fluxerGuild = makeFluxerGuild({ roles: fluxerRoles });
            const onPlanned = vi.fn();
            const { service } = makeService({
                discordGuild: makeDiscordGuild(discordRoles),
                fluxerGuild,
            });

            const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
                overwrite: true,
                onPlanned,
            });

            expect(onPlanned).toHaveBeenCalledWith({ roles: 2 });
            expect(report.copied).toEqual(['Emoji', 'Image']);
            expect(report.skipped).toEqual([
                { name: 'Same', reason: 'already set' },
            ]);
            expect(patches(fluxerGuild)).toEqual([
                ['f1', { unicode_emoji: '⭐' }],
                ['f3', { icon: dataUrlOf(iconUrl('d3', 'h')) }],
            ]);
        });
    });

    it('reports the plan before the first update', async () => {
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'A' }],
        });
        const order: string[] = [];
        fluxerGuild.client.rest.patch.mockImplementation(async () => {
            order.push('patch');
            return {};
        });
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'A', unicodeEmoji: '🅰️' },
            ]),
            fluxerGuild,
        });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            onPlanned: (plan) => {
                order.push(`planned ${plan.roles}`);
            },
        });

        expect(order).toEqual(['planned 1', 'patch']);
    });

    it('falls back to WebP when the PNG is over 256 KiB', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Big', icon: 'h' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'Big' }],
        });
        const downloadImage = vi.fn(async (url: string) =>
            url.includes('.png')
                ? {
                      bytes: Buffer.alloc(ROLE_ICON_MAX_BYTES + 1),
                      contentType: 'image/png',
                  }
                : downloadOk(url)
        );
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['Big']);
        expect(downloadImage.mock.calls.map(([url]) => url)).toEqual([
            iconUrl('d1', 'h', 'png'),
            iconUrl('d1', 'h', 'webp'),
        ]);
        expect(patches(fluxerGuild)).toEqual([
            [
                'f1',
                {
                    icon: dataUrlOf(iconUrl('d1', 'h', 'webp'), 'image/webp'),
                },
            ],
        ]);
    });

    it('fails roles whose image is too large in every format', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'Huge', icon: 'h' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'Huge' }],
        });
        const downloadImage = vi.fn(async () => ({
            bytes: Buffer.alloc(300 * 1024),
            contentType: 'image/png',
        }));
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual([]);
        expect(report.failed).toEqual([
            {
                name: 'Huge',
                reason: 'image too large for Fluxer (300 KiB, max 256 KiB)',
            },
        ]);
        expect(fluxerGuild.client.rest.patch).not.toHaveBeenCalled();
    });

    it('fails a role whose download fails and continues', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'd1', name: 'A', icon: 'broken' },
            { id: 'd2', name: 'B', unicodeEmoji: '🅱️' },
        ]);
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f1', name: 'A' },
                { id: 'f2', name: 'B' },
            ],
        });
        const downloadImage = vi.fn(async () => {
            throw new Error('download failed: HTTP 404');
        });
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['B']);
        expect(report.failed).toEqual([
            { name: 'A', reason: 'download failed: HTTP 404' },
        ]);
    });

    it('fails a role whose PATCH is rejected (e.g. hierarchy) and continues', async () => {
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f1', name: 'Admin' },
                { id: 'f2', name: 'Member' },
            ],
        });
        fluxerGuild.client.rest.patch.mockImplementation(
            async (route: string) => {
                if (route.endsWith('/f1'))
                    throw new Error('Missing Permissions');
                return {};
            }
        );
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'Admin', unicodeEmoji: '👑' },
                { id: 'd2', name: 'Member', unicodeEmoji: '🙂' },
            ]),
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['Member']);
        expect(report.failed).toEqual([
            { name: 'Admin', reason: 'Missing Permissions' },
        ]);
    });

    it('waits and retries a rate-limited update', async () => {
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'A' }],
        });
        fluxerGuild.client.rest.patch
            .mockRejectedValueOnce(rateLimitError(2))
            .mockResolvedValueOnce({});
        const sleep = vi.fn(async () => {});
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'A', unicodeEmoji: '🅰️' },
            ]),
            fluxerGuild,
            sleep,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['A']);
        expect(sleep).toHaveBeenCalledWith(2000);
        expect(fluxerGuild.client.rest.patch).toHaveBeenCalledTimes(2);
    });

    it('gives up after the maximum number of rate-limited attempts', async () => {
        const fluxerGuild = makeFluxerGuild({
            roles: [{ id: 'f1', name: 'A' }],
        });
        fluxerGuild.client.rest.patch.mockRejectedValue(rateLimitError(1));
        const sleep = vi.fn(async () => {});
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'A', unicodeEmoji: '🅰️' },
            ]),
            fluxerGuild,
            sleep,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.failed).toEqual([
            { name: 'A', reason: 'You are being rate limited.' },
        ]);
        expect(fluxerGuild.client.rest.patch).toHaveBeenCalledTimes(
            RATE_LIMIT_MAX_ATTEMPTS
        );
        expect(sleep).toHaveBeenCalledTimes(RATE_LIMIT_MAX_ATTEMPTS - 1);
    });

    it('stops updating once the Fluxer API blocks the bot', async () => {
        const fluxerGuild = makeFluxerGuild({
            roles: [
                { id: 'f1', name: 'A' },
                { id: 'f2', name: 'B' },
            ],
        });
        fluxerGuild.client.rest.patch.mockRejectedValue(
            Object.assign(new Error('banned'), { code: 'IP_BANNED' })
        );
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'A', unicodeEmoji: '🅰️' },
                { id: 'd2', name: 'B', unicodeEmoji: '🅱️' },
            ]),
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.failed).toEqual([
            { name: 'A', reason: 'Fluxer API temporarily blocked' },
            { name: 'B', reason: 'Fluxer API temporarily blocked' },
        ]);
        expect(fluxerGuild.client.rest.patch).toHaveBeenCalledTimes(1);
        expect(isFluxerApiBlocked()).toBe(true);
    });

    it('rejects up front while the Fluxer API is blocked', async () => {
        markFluxerApiBlocked();
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('temporarily blocked');
        expect(fluxerGuild.client.rest.get).not.toHaveBeenCalled();
    });

    it('rejects with the block message when listing Fluxer roles is blocked', async () => {
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.client.rest.get.mockRejectedValue(
            Object.assign(new Error('banned'), { code: 'GLOBAL_IP_BANNED' })
        );
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow(
            'The Fluxer API is temporarily blocked; try again later.'
        );
        expect(isFluxerApiBlocked()).toBe(true);
    });

    it('rejects with a readable message when a role list cannot be fetched', async () => {
        const discordGuild = makeDiscordGuild();
        discordGuild.roles.fetch.mockRejectedValue(new Error('Missing Access'));
        const { service } = makeService({ discordGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow(
            "Could not list the Discord server's roles: Missing Access"
        );
    });

    it('rejects when a guild cannot be fetched', async () => {
        await expect(
            makeService({ discordGuild: null }).service.transfer(
                DISCORD_GUILD,
                FLUXER_GUILD
            )
        ).rejects.toThrow('Discord server not found');
        await expect(
            makeService({ fluxerGuild: null }).service.transfer(
                DISCORD_GUILD,
                FLUXER_GUILD
            )
        ).rejects.toThrow('Fluxer server not found');
    });

    it('rejects when the bot lacks Manage Roles', async () => {
        const fluxerGuild = makeFluxerGuild({ permissions: 0n });
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('`Manage Roles`');
        expect(fluxerGuild.client.rest.get).not.toHaveBeenCalled();
    });

    it('fetches the bot member when it is not cached', async () => {
        const fluxerGuild = makeFluxerGuild({
            meCached: false,
            permissions: 0n,
        });
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('`Manage Roles`');
        expect(fluxerGuild.fetchMember).toHaveBeenCalledWith(BOT_ID);
    });

    it('lets the API decide when the bot member cannot be fetched', async () => {
        const fluxerGuild = makeFluxerGuild({
            meCached: false,
            meFetchable: false,
            roles: [{ id: 'f1', name: 'A' }],
        });
        const { service } = makeService({
            discordGuild: makeDiscordGuild([
                { id: 'd1', name: 'A', unicodeEmoji: '🅰️' },
            ]),
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.copied).toEqual(['A']);
    });

    it('allows one transfer per Fluxer guild at a time', async () => {
        const discordGuild = makeDiscordGuild();
        let release!: () => void;
        discordGuild.roles.fetch.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return new Collection<string, unknown>();
        });
        const { service } = makeService({ discordGuild });

        const first = service.transfer(DISCORD_GUILD, FLUXER_GUILD);
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(service.isRunning(FLUXER_GUILD)).toBe(true);

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toBeInstanceOf(RoleIconTransferInProgressError);

        release();
        await first;
        expect(service.isRunning(FLUXER_GUILD)).toBe(false);
        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).resolves.toEqual({ copied: [], skipped: [], failed: [] });
    });
});
