import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import ClaudeRequestService, {
    ClaudeRequestFailure,
    MAX_CLAUDE_REQUEST_LENGTH,
    stripClaudeRequestInvocation,
} from '../../../services/claudeRequest/ClaudeRequestService';
import ClaudeRequestNotifyService from '../../../services/claudeRequest/ClaudeRequestNotifyService';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `clauderequest <request>` (issue #18): files the rest of the message as a
 * GitHub issue labelled for Claude and replies with the link. Restricted to
 * the roles configured in `roles.claudeRequest`.
 */
export default class ClaudeRequestDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly claudeRequestService: ClaudeRequestService,
        private readonly allowedRoleIds: readonly string[],
        private readonly claudeRequestNotifyService: ClaudeRequestNotifyService | null = null
    ) {
        super(client);
    }

    private async replyEmbed(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ) {
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

    private async replyError(
        message: DiscordCommandHandlerMessage,
        description: string
    ) {
        await this.replyEmbed(message, description, EmbedColors.Error);
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
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.replyError(
                message,
                'This command must be used in a server.'
            );
            return;
        }
        if (message.author.bot) {
            await this.replyError(message, 'Bots cannot submit requests.');
            return;
        }
        if (!(await this.requireRole(message, this.allowedRoleIds))) return;

        if (!this.claudeRequestService.isConfigured()) {
            await this.replyError(
                message,
                this.failureMessage('not_configured') as string
            );
            return;
        }

        // Read from the raw content so newlines survive; fall back to args.
        const text = (
            stripClaudeRequestInvocation(message.content, COMMAND_PREFIX) ??
            args.join(' ')
        ).trim();
        if (!text) {
            await message.reply(getDiscordCommandUsage('clauderequest'));
            return;
        }

        try {
            const result = await this.claudeRequestService.submit({
                text,
                platform: 'discord',
                authorId: message.author.id,
                authorName: message.author.username,
                guildName: message.guild.name,
                channelName:
                    'name' in message.channel ? message.channel.name : null,
                messageUrl: message.url,
            });
            if (result.ok) {
                logger.info(
                    `🤖 Claude request #${result.number} filed by Discord user ${message.author.id}`
                );
                await this.replyEmbed(
                    message,
                    `Submitted Claude request [#${result.number}](${result.url}).${this.claudeRequestNotifyService ? " I'll let you know here when it's done." : ''}`,
                    EmbedColors.Success
                );
                await this.claudeRequestNotifyService?.track({
                    platform: 'discord',
                    issueNumber: result.number,
                    issueUrl: result.url,
                    title: result.title,
                    userId: message.author.id,
                    guildId: message.guild.id,
                    channelId: message.channelId,
                    messageId: message.id,
                });
                return;
            }
            const description = this.failureMessage(
                result.reason,
                result.retryAfterMs,
                result.detail
            );
            if (description) await this.replyError(message, description);
            else await message.reply(getDiscordCommandUsage('clauderequest'));
        } catch (err: unknown) {
            logger.error('❌ Submitting a Claude request failed:', err);
            await this.replyError(
                message,
                `Could not create the GitHub issue: ${(err as Error).message}`
            );
        }
    }
}
