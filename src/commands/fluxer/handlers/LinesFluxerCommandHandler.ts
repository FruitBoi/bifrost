import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import ClaudeLinesService from '../../../services/claudeLines/ClaudeLinesService';
import { buildClaudeLinesSummary } from '../../linesSummary';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `lines` (issue #19): shows how many lines of code Claude has written in the
 * bot's GitHub repository. Open to everyone.
 */
export default class LinesFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly claudeLinesService: ClaudeLinesService
    ) {
        super(client);
    }

    private async replyError(message: Message, description: string) {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    public async handleCommand(message: Message): Promise<void> {
        if (message.author.bot) {
            await this.replyError(message, 'Bots cannot use this command.');
            return;
        }
        if (!this.claudeLinesService.isConfigured()) {
            await this.replyError(
                message,
                'The lines counter is not configured on this bot (BF_GITHUB_TOKEN is not set).'
            );
            return;
        }

        try {
            const result = await this.claudeLinesService.getStats();
            if (!result.ok) {
                await this.replyError(
                    message,
                    result.reason === 'not_configured'
                        ? 'The lines counter is not configured on this bot (BF_GITHUB_TOKEN is not set).'
                        : `Could not fetch the commit history from GitHub: ${result.detail ?? 'unknown error'}`
                );
                return;
            }
            const summary = buildClaudeLinesSummary(result.stats);
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(summary.title)
                        .setDescription(summary.description)
                        .addFields(...summary.fields)
                        .setColor(EmbedColors.Info)
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
            });
        } catch (err: unknown) {
            logger.error('❌ Fetching Claude line stats failed:', err);
            await this.replyError(
                message,
                `Could not fetch the commit history from GitHub: ${(err as Error).message}`
            );
        }
    }
}
