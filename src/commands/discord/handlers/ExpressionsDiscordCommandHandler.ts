import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { LinkService } from '../../../services/LinkService';
import ExpressionTransferService from '../../../services/expressionTransfer/ExpressionTransferService';
import {
    describePlan,
    formatExpressionTransferReport,
    parseExpressionsArgs,
} from '../../../services/expressionTransfer/expressionsCommand';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `expressions [emojis | stickers]` (aliases `emotes`, `emojis`): copies this
 * Discord server's custom emojis and stickers into the linked Fluxer server
 * under the same names (issue #17), so that bridged messages and reactions
 * can show them. Names that already exist on Fluxer are skipped, so the
 * command can be re-run after new emojis were added. Requires the Discord
 * `Manage Expressions` permission. The transfer itself lives in
 * `ExpressionTransferService`; this handler adapts the Discord message API
 * and renders the report.
 */
export default class ExpressionsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly expressionTransferService: ExpressionTransferService
    ) {
        super(client);
    }

    private embed(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): EmbedBuilder {
        return new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setFooter(this.footer(message))
            .setTimestamp();
    }

    private async reply(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** An error embed followed by the command usage, in one reply. */
    private async replyUsage(
        message: DiscordCommandHandlerMessage,
        error: string
    ): Promise<void> {
        const usage = getDiscordCommandUsage('expressions');
        await message.reply({
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot) {
            await this.reply(
                message,
                'Bots cannot use this command.',
                EmbedColors.Error
            );
            return;
        }
        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageGuildExpressions,
                'Manage Expressions'
            ))
        ) {
            return;
        }

        const parsed = parseExpressionsArgs(args);
        if (!parsed.ok) {
            await this.replyUsage(
                message,
                `Unknown argument \`${args.join(' ')}\`: give \`emojis\` or \`stickers\` to copy only that kind, or nothing to copy both.`
            );
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(message.guild.id)
            .catch(() => null);
        if (!guildLink) {
            await this.reply(
                message,
                'This server is not linked to a Fluxer server.',
                EmbedColors.Error
            );
            return;
        }

        try {
            const report = await this.expressionTransferService.transfer(
                guildLink.discordGuildId,
                guildLink.fluxerGuildId,
                {
                    kinds: parsed.kinds,
                    onPlanned: async (plan) => {
                        const notice = describePlan(plan);
                        if (!notice) return;
                        // A failed notice must not abort the transfer.
                        await this.reply(
                            message,
                            notice,
                            EmbedColors.Info
                        ).catch((err: unknown) => {
                            logger.warn(
                                '⚠️ Could not post the expression transfer notice on Discord:',
                                err
                            );
                        });
                    },
                }
            );
            const { title, description, color } =
                formatExpressionTransferReport(report, parsed.kinds);
            await message.reply({
                embeds: [
                    this.embed(message, description, color).setTitle(title),
                ],
            });
        } catch (err: unknown) {
            logger.error('❌ Expression transfer failed on Discord:', err);
            await this.reply(
                message,
                (err as Error).message,
                EmbedColors.Error
            );
        }
    }
}
