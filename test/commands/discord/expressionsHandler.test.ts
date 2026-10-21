import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import ExpressionsDiscordCommandHandler from '../../../src/commands/discord/handlers/ExpressionsDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import { LinkService } from '../../../src/services/LinkService';
import ExpressionTransferService, {
    ALL_EXPRESSION_KINDS,
    ExpressionTransferInProgressError,
    ExpressionTransferOptions,
    ExpressionTransferPlan,
    ExpressionTransferReport,
} from '../../../src/services/expressionTransfer/ExpressionTransferService';
import { EmbedColors } from '../../../src/utils/embeds';

const DISCORD_GUILD = '333333333333333333';
const FLUXER_GUILD = '444444444444444444';
const GUILD_LINK = {
    id: 'gl-1',
    discordGuildId: DISCORD_GUILD,
    fluxerGuildId: FLUXER_GUILD,
};

const client = {} as unknown as Client;

const EMPTY_REPORT: ExpressionTransferReport = {
    emojis: { created: [], skipped: [], failed: [] },
    stickers: { created: [], skipped: [], failed: [] },
};

interface FakeMessageOptions {
    inGuild?: boolean;
    bot?: boolean;
    /** The author's guild permissions; Manage Expressions by default. */
    permissions?: bigint[];
    /** Whether the author member can be fetched. */
    memberFound?: boolean;
}

function makeMessage({
    inGuild = true,
    bot = false,
    permissions = [PermissionFlagsBits.ManageGuildExpressions],
    memberFound = true,
}: FakeMessageOptions = {}) {
    const member = { permissions: new PermissionsBitField(permissions) };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '2000',
        content: '!b expressions',
        channelId: 'chan-1',
        guildId: inGuild ? DISCORD_GUILD : null,
        inGuild: () => inGuild,
        author: {
            id: 'author',
            bot,
            username: 'author',
            displayAvatarURL: () => 'https://example.invalid/a.png',
        },
        guild: inGuild
            ? {
                  id: DISCORD_GUILD,
                  members: {
                      fetch: vi.fn(async (id: string) => {
                          if (id !== 'author' || !memberFound) {
                              throw new Error('Unknown Member');
                          }
                          return member;
                      }),
                  },
              }
            : null,
        reply,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
    };
}

function makeHandler(linked = true) {
    const transfer =
        vi.fn<
            (
                discordGuildId: string,
                fluxerGuildId: string,
                options?: ExpressionTransferOptions
            ) => Promise<ExpressionTransferReport>
        >();
    transfer.mockResolvedValue(EMPTY_REPORT);
    const linkService = {
        getGuildLinkForDiscordGuild: vi
            .fn()
            .mockResolvedValue(linked ? GUILD_LINK : null),
    };
    const handler = new ExpressionsDiscordCommandHandler(
        client,
        linkService as unknown as LinkService,
        { transfer } as unknown as ExpressionTransferService
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
    plan: ExpressionTransferPlan,
    report: ExpressionTransferReport = EMPTY_REPORT
) {
    transfer.mockImplementation(async (_d, _f, options) => {
        await options?.onPlanned?.(plan);
        return report;
    });
}

describe('ExpressionsDiscordCommandHandler', () => {
    let handler: ExpressionsDiscordCommandHandler;
    let transfer: ReturnType<typeof makeHandler>['transfer'];

    beforeEach(() => {
        ({ handler, transfer } = makeHandler());
    });

    describe('preamble', () => {
        it('refuses outside servers', async () => {
            const { message, reply } = makeMessage({ inGuild: false });
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This command must be used in a server.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('refuses bots', async () => {
            const { message, reply } = makeMessage({ bot: true });
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Bots cannot use this command.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('requires Manage Expressions', async () => {
            const { message, reply } = makeMessage({
                permissions: [PermissionFlagsBits.ManageMessages],
            });
            await handler.handleCommand(message, 'emotes');
            expect(replyEmbed(reply)).toMatchObject({
                description:
                    'You need the `Manage Expressions` permission to use this command.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('reports a member that cannot be fetched', async () => {
            const { message, reply } = makeMessage({ memberFound: false });
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Could not fetch your member information.',
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it.each([[['both']], [['emoji']], [['emojis', 'stickers']]])(
            'shows the usage after an error on bad args %j',
            async (args) => {
                const { message, reply } = makeMessage();
                await handler.handleCommand(message, 'expressions', ...args);
                const embeds = replyEmbeds(reply);
                expect(embeds).toHaveLength(2);
                expect(embeds[0]).toMatchObject({ color: EmbedColors.Error });
                expect(embeds[0].description).toContain(
                    `Unknown argument \`${args.join(' ')}\``
                );
                expect(embeds[1].title).toBe('Command Usage');
                expect(embeds[1].description).toContain(
                    'expressions [emojis | stickers]'
                );
                expect(transfer).not.toHaveBeenCalled();
            }
        );

        it('refuses unlinked servers', async () => {
            ({ handler, transfer } = makeHandler(false));
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This server is not linked to a Fluxer server.',
                color: EmbedColors.Error,
            });
            expect(transfer).not.toHaveBeenCalled();
        });

        it('treats a failing link lookup as unlinked', async () => {
            const made = makeHandler();
            made.linkService.getGuildLinkForDiscordGuild.mockRejectedValue(
                new Error('db down')
            );
            const { message, reply } = makeMessage();
            await made.handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'This server is not linked to a Fluxer server.',
            });
        });
    });

    describe('kinds', () => {
        it.each([
            [[], ALL_EXPRESSION_KINDS],
            [['emojis'], ['emojis']],
            [['STICKERS'], ['stickers']],
        ])('passes the kinds for %j', async (args, kinds) => {
            const { message } = makeMessage();
            await handler.handleCommand(message, 'expressions', ...args);
            expect(transfer).toHaveBeenCalledTimes(1);
            expect(transfer).toHaveBeenCalledWith(DISCORD_GUILD, FLUXER_GUILD, {
                kinds,
                onPlanned: expect.any(Function),
            });
        });
    });

    describe('progress notice', () => {
        it('is posted before the report when something will be uploaded', async () => {
            planThenReport(transfer, { emojis: 12, stickers: 3 });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(reply).toHaveBeenCalledTimes(2);
            expect(replyEmbed(reply, 0)).toMatchObject({
                description:
                    'Copying 12 emojis and 3 stickers to the Fluxer server… this can take a while.',
                color: EmbedColors.Info,
            });
            expect(replyEmbed(reply, 1).title).toBe('Emoji & sticker transfer');
        });

        it('is skipped when nothing will be uploaded', async () => {
            planThenReport(transfer, { emojis: 0, stickers: 0 });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(reply).toHaveBeenCalledTimes(1);
            expect(replyEmbed(reply).title).toBe('Emoji & sticker transfer');
        });

        it('does not abort the transfer when it cannot be sent', async () => {
            planThenReport(transfer, { emojis: 1, stickers: 0 });
            const { message, reply } = makeMessage();
            reply.mockRejectedValueOnce(new Error('Missing Permissions'));
            await handler.handleCommand(message, 'expressions');
            expect(reply).toHaveBeenCalledTimes(2);
            expect(replyEmbed(reply, 1).title).toBe('Emoji & sticker transfer');
        });
    });

    describe('report', () => {
        it('is green when everything was copied', async () => {
            transfer.mockResolvedValue({
                emojis: { created: ['wave'], skipped: [], failed: [] },
                stickers: { created: ['hi', 'bye'], skipped: [], failed: [] },
            });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            const embed = replyEmbed(reply);
            expect(embed).toMatchObject({
                title: 'Emoji & sticker transfer',
                color: EmbedColors.Success,
            });
            expect(embed.description).toContain(
                'Copied 1 emoji and 2 stickers to the Fluxer server.'
            );
            expect(embed.description).toContain('- Copied: `wave`');
            expect(embed.description).toContain('- Copied: `hi`, `bye`');
        });

        it('is informational when everything was skipped', async () => {
            transfer.mockResolvedValue({
                emojis: {
                    created: [],
                    skipped: [{ name: 'wave', reason: 'already on Fluxer' }],
                    failed: [],
                },
                stickers: { created: [], skipped: [], failed: [] },
            });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions', 'emojis');
            const embed = replyEmbed(reply);
            expect(embed).toMatchObject({
                title: 'Emoji transfer',
                color: EmbedColors.Info,
            });
            expect(embed.description).toContain('Nothing to copy');
            expect(embed.description).toContain(
                '- Skipped (already on Fluxer): `wave`'
            );
            expect(embed.description).not.toContain('Stickers');
        });

        it('is yellow when some failed', async () => {
            transfer.mockResolvedValue({
                emojis: {
                    created: ['ok'],
                    skipped: [],
                    failed: [{ name: 'big', reason: 'HTTP 413' }],
                },
                stickers: { created: [], skipped: [], failed: [] },
            });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            const embed = replyEmbed(reply);
            expect(embed.color).toBe(EmbedColors.Warning);
            expect(embed.description).toContain('- Failed: `big` (HTTP 413)');
        });

        it('is red when nothing was copied and something failed', async () => {
            transfer.mockResolvedValue({
                emojis: { created: [], skipped: [], failed: [] },
                stickers: {
                    created: [],
                    skipped: [],
                    failed: [{ name: 'big', reason: 'HTTP 413' }],
                },
            });
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply).color).toBe(EmbedColors.Error);
        });
    });

    describe('errors', () => {
        it('replies with the message of a rejecting service', async () => {
            transfer.mockRejectedValue(
                new Error('Could not access the linked Fluxer server.')
            );
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description: 'Could not access the linked Fluxer server.',
                color: EmbedColors.Error,
            });
        });

        it('reports a transfer that is already running', async () => {
            transfer.mockRejectedValue(
                new ExpressionTransferInProgressError(FLUXER_GUILD)
            );
            const { message, reply } = makeMessage();
            await handler.handleCommand(message, 'expressions');
            expect(replyEmbed(reply)).toMatchObject({
                description:
                    'An emoji/sticker transfer into this Fluxer server is already running; wait for it to finish.',
                color: EmbedColors.Error,
            });
        });
    });
});
