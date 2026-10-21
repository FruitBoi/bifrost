import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
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
 * `expressions [emojis | stickers]` (aliases `emotes`, `emojis`): copies the
 * custom emojis and stickers of the Discord server linked to this Fluxer
 * server into this server under the same names (issue #17), so that bridged
 * messages and reactions can show them. Only the Discord → Fluxer direction
 * exists. Names that already exist here are skipped, so the command can be
 * re-run after new emojis were added on Discord. Requires the Fluxer
 * `Manage Expressions` permission. The transfer itself lives in
 * `ExpressionTransferService`; this handler adapts the Fluxer message API
 * and renders the report.
 */
export default class ExpressionsFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly expressionTransferService: ExpressionTransferService
    ) {
        super(client);
    }

    private embed(
        message: Message,
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
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** An error embed followed by the command usage, in one reply. */
    private async replyUsage(message: Message, error: string): Promise<void> {
        const usage = getFluxerCommandUsage('expressions');
        await message.reply({
            ...usage,
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot || message.webhookId) {
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
                PermissionFlags.ManageExpressions,
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
            .getGuildLinkForFluxerGuild(message.guildId)
            .catch(() => null);
        if (!guildLink) {
            await this.reply(
                message,
                'This server is not linked to a Discord server.',
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
                                '⚠️ Could not post the expression transfer notice on Fluxer:',
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
            logger.error('❌ Expression transfer failed on Fluxer:', err);
            await this.reply(
                message,
                (err as Error).message,
                EmbedColors.Error
            );
        }
    }
}
