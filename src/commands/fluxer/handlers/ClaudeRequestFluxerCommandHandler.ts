import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import ClaudeRequestService, {
    ClaudeRequestFailure,
    MAX_CLAUDE_REQUEST_LENGTH,
    stripClaudeRequestInvocation,
} from '../../../services/claudeRequest/ClaudeRequestService';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `clauderequest <request>` (issue #18): files the rest of the message as a
 * GitHub issue labelled for Claude and replies with the link. Restricted to
 * the roles configured in `roles.claudeRequest`.
 */
export default class ClaudeRequestFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly claudeRequestService: ClaudeRequestService,
        private readonly allowedRoleIds: readonly string[]
    ) {
        super(client);
    }

    private async reply(
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(color)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    private failureMessage(
        reason: ClaudeRequestFailure,
        retryAfterMs?: number,
        detail?: string
    ): string | null {
        switch (reason) {
            case 'not_configured':
                return 'Claude requests are not configured on this bot (BF_GITHUB_TOKEN is not set).';
            case 'too_long':
                return `Requests can be at most ${MAX_CLAUDE_REQUEST_LENGTH} characters.`;
            case 'cooldown':
                return `Please wait ${Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))} seconds before submitting another request.`;
            case 'github_error':
                return `Could not create the GitHub issue: ${detail ?? 'unknown error'}`;
            case 'empty':
                return null;
        }
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
        if (message.author.bot) {
            await this.reply(
                message,
                'Bots cannot submit requests.',
                EmbedColors.Error
            );
            return;
        }
        if (!(await this.requireRole(message, this.allowedRoleIds))) return;

        if (!this.claudeRequestService.isConfigured()) {
            await this.reply(
                message,
                this.failureMessage('not_configured') as string,
                EmbedColors.Error
            );
            return;
        }

        // Read from the raw content so newlines survive; fall back to args.
        const text = (
            stripClaudeRequestInvocation(message.content, COMMAND_PREFIX) ??
            args.join(' ')
        ).trim();
        if (!text) {
            await message.reply(getFluxerCommandUsage('clauderequest'));
            return;
        }

        try {
            const channelName = (message.channel as { name?: string } | null)
                ?.name;
            const result = await this.claudeRequestService.submit({
                text,
                platform: 'fluxer',
                authorId: message.author.id,
                authorName: message.author.username,
                guildName: message.guild?.name ?? null,
                channelName: channelName ?? null,
                // No Fluxer message-link helper exists in the codebase.
                messageUrl: null,
            });
            if (result.ok) {
                logger.info(
                    `🤖 Claude request #${result.number} filed by Fluxer user ${message.author.id}`
                );
                await this.reply(
                    message,
                    `Submitted Claude request [#${result.number}](${result.url}).`,
                    EmbedColors.Success
                );
                return;
            }
            const description = this.failureMessage(
                result.reason,
                result.retryAfterMs,
                result.detail
            );
            if (description) {
                await this.reply(message, description, EmbedColors.Error);
            } else {
                await message.reply(getFluxerCommandUsage('clauderequest'));
            }
        } catch (err: unknown) {
            logger.error('❌ Submitting a Claude request failed:', err);
            await this.reply(
                message,
                `Could not create the GitHub issue: ${(err as Error).message}`,
                EmbedColors.Error
            );
        }
    }
}
