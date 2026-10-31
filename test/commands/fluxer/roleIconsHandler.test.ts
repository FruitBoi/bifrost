import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Client,
    Message,
    PermissionFlags,
    PermissionsBitField,
} from '@fluxerjs/core';
import RoleIconsFluxerCommandHandler from '../../../src/commands/fluxer/handlers/RoleIconsFluxerCommandHandler';
import { LinkService } from '../../../src/services/LinkService';
import RoleIconTransferService, {
    RoleIconTransferInProgressError,
    RoleIconTransferOptions,
    RoleIconTransferReport,
} from '../../../src/services/roleIconTransfer/RoleIconTransferService';
import { EmbedColors } from '../../../src/utils/embeds';

const DISCORD_GUILD = '333333333333333333';
const FLUXER_GUILD = '444444444444444444';
const GUILD_LINK = {
    id: 'gl-1',
    discordGuildId: DISCORD_GUILD,
    fluxerGuildId: FLUXER_GUILD,
};

const client = { user: { id: 'bot' } } as unknown as Client;

const EMPTY_REPORT: RoleIconTransferReport = {
    copied: [],
    skipped: [],
    failed: [],
};

interface FakeMessageOptions {
    inGuild?: boolean;
    bot?: boolean;
    webhookId?: string | null;
    /** The author's guild permissions; Manage Roles by default. */
    permissions?: bigint[];
    /** Whether the author member can be fetched. */
    memberFound?: boolean;
}

function makeMessage({
    inGuild = true,
    bot = false,
    webhookId = null,
    permissions = [PermissionFlags.ManageRoles],
    memberFound = true,
}: FakeMessageOptions = {}) {
    const author = {
        id: 'author',
        permissions: new PermissionsBitField(permissions),
    };
    const guild = {
        id: FLUXER_GUILD,
        fetchMember: vi.fn(async (id: string) => {
            if (id === 'author' && memberFound) return author;
            throw new Error('Unknown Member');
        }),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '2000',
        content: '!b roleicons',
        channelId: 'chan-1',
        guildId: inGuild ? FLUXER_GUILD : null,
        author: { id: 'author', bot, username: 'author' },
        webhookId,
        guild: inGuild ? guild : null,
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        reply,
    };
    return { message: message as unknown as Message, reply };
}

function makeHandler(linked = true) {
    const transfer =
        vi.fn<
            (
                discordGuildId: string,
                fluxerGuildId: string,
                options?: RoleIconTransferOptions
            ) => Promise<RoleIconTransferReport>
        >();
    transfer.mockResolvedValue(EMPTY_REPORT);
    const linkService = {
        getGuildLinkForFluxerGuild: vi
            .fn()
            .mockResolvedValue(linked ? GUILD_LINK : null),
    };
    const handler = new RoleIconsFluxerCommandHandler(
        client,
        linkService as unknown as LinkService,
        { transfer } as unknown as RoleIconTransferService
    );
    return { handler, transfer, linkService };
}

interface EmbedData {
    title?: string;
    description?: string;
    color?: number;
}

/** The embeds of the `n`-th reply (0-based). */
function replyEmbeds(reply: ReturnType<typeof vi.fn>, n = 0): EmbedData[] {
    expect(reply.mock.calls.length).toBeGreaterThan(n);
    return reply.mock.calls[n][0].embeds.map(
        (embed: { data: EmbedData }) => embed.data
    );
}

/** The single embed of the `n`-th reply. */
function replyEmbed(reply: ReturnType<typeof vi.fn>, n = 0): EmbedData {
    const embeds = replyEmbeds(reply, n);
    expect(embeds).toHaveLength(1);
    return embeds[0];
}

/** Makes `transfer` call `onPlanned` with `plan` before resolving `report`. */
function planThenReport(
    transfer: ReturnType<typeof makeHandler>['transfer'],
    plan: { roles: number },
    report: RoleIconTransferReport = EMPTY_REPORT
) {
    transfer.mockImplementation(async (_d, _f, options) => {
        await options?.onPlanned?.(plan);
        return report;
    });
}

describe('RoleIconsFluxerCommandHandler', () => {
    let handler: RoleIconsFluxerCommandHandler;
    let transfer: ReturnType<typeof makeHandler>['transfer'];

    beforeEach(() => {
        ({ handler, transfer } = makeHandler());
    });

    describe('preamble', () => {
        it('refuses outside servers', async () => {
            const { message, reply } = makeMessage({ inGuild: false });
            await handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This command must be used in a server.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('refuses bots', async () => {
            const { message, reply } = makeMessage({ bot: true });
            await handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Bots cannot use this command.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('requires Manage Roles', async () => {
            const { message, reply } = makeMessage({
                permissions: [PermissionFlags.ManageMessages],
            });
            await handler.handleCommand(message, 'roleemotes');
            expect(replyEmbed(reply)).toMatchObject({
                description:
                    'You need the `Manage Roles` permission to use this command.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('reports a member that cannot be fetched', async () => {
            const { message, reply } = makeMessage({ memberFound: false });
            await handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Could not fetch your member information.',
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it.each([[['all']], [['overwrite', 'x']], [['replace']]])(
            'shows the usage after an error on bad args %j',
            async (args) => {
                const { message, reply } = makeMessage();
                await handler.handleCommand(message, 'roleicons', ...args);
                const embeds = replyEmbeds(reply);
                expect(embeds).toHaveLength(2);
                expect(embeds[0]).toMatchObject({ color: EmbedColors.Error });
                expect(embeds[0].description).toContain(
                    `Unknown argument \`${args.join(' ')}\``
                );
                expect(embeds[1].title).toBe('Command Usage');
                expect(embeds[1].description).toContain(
                    'roleicons [overwrite]'
                );
                expect(transfer).not.toHaveBeenCalled();
            }
        );

        it('refuses unlinked servers', async () => {
            ({ handler, transfer } = makeHandler(false));
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This server is not linked to a Discord server.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('treats a failing link lookup as unlinked', async () => {
            const made = makeHandler();
            made.linkService.getGuildLinkForFluxerGuild.mockRejectedValue(
                new Error('db down')
            );
            const { message, reply } = makeMessage();
            await made.handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This server is not linked to a Discord server.',
            });
        });
    });

    describe('overwrite', () => {
        it.each([
            [[], false],
            [['overwrite'], true],
            [['OVERWRITE'], true],
        ])('passes the flag for %j', async (args, overwrite) => {
            const { message } = makeMessage();
            await handler.handleCommand(message, 'roleicons', ...args);
            expect(transfer).toHaveBeenCalledTimes(1);
            expect(transfer).toHaveBeenCalledWith(DISCORD_GUILD, FLUXER_GUILD, {
                overwrite,
                onPlanned: expect.any(Function),
            });
        });
    });

    describe('progress notice', () => {
        it('is posted before the report when something will be copied', async () => {
            planThenReport(transfer, { roles: 5 });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            expect(reply).toHaveBeenCalledTimes(2);
            const notice = replyEmbed(reply, 0);
            expect(notice.color).toBe(EmbedColors.Info);
            expect(notice.description).toBeTruthy();
        });

        it('is skipped when nothing will be copied', async () => {
            planThenReport(transfer, { roles: 0 });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            expect(reply).toHaveBeenCalledTimes(1);
            expect(replyEmbed(reply).title).toBeTruthy();
        });

        it('does not abort the transfer when it cannot be sent', async () => {
            planThenReport(transfer, { roles: 1 });
            const { message, reply } = makeMessage();
            reply.mockRejectedValueOnce(new Error('Missing Permissions'));
            await handler.handleCommand(message, 'roleicons');
            expect(reply).toHaveBeenCalledTimes(2);
            expect(replyEmbed(reply, 1).title).toBeTruthy();
        });
    });

    describe('report', () => {
        it('is posted as an embed with the report details', async () => {
            transfer.mockResolvedValue({
                copied: ['Admin'],
                skipped: [],
                failed: [{ name: 'Mod', reason: 'HTTP 413' }],
            });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            const embed = replyEmbed(reply);
            expect(embed.title).toBeTruthy();
            expect(embed.description).toContain('Admin');
            expect(embed.description).toContain('Mod');
        });
    });

    describe('errors', () => {
        it('replies with the message of a rejecting service', async () => {
            transfer.mockRejectedValue(
                new Error('Could not access the linked Discord server.')
            );
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Could not access the linked Discord server.',
                color: EmbedColors.Error,
            });
        });

        it('reports a transfer that is already running', async () => {
            transfer.mockRejectedValue(
                new RoleIconTransferInProgressError(FLUXER_GUILD)
            );
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'roleicons');
            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Error);
            expect(embed.description).toBeTruthy();
        });
    });
});
