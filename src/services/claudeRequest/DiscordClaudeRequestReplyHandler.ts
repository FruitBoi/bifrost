import { EmbedBuilder, Message } from 'discord.js';
import { EmbedColors } from '../../utils/embeds';
import logger from '../../utils/logging/logger';
import ClaudeRequestNotifyService from './ClaudeRequestNotifyService';
import ClaudeRequestService, {
    describeClaudeRequestReplyResult,
} from './ClaudeRequestService';

const KIND_COLORS = {
    success: EmbedColors.Success,
    warning: EmbedColors.Warning,
    error: EmbedColors.Error,
} as const;

/**
 * Replies to "Claude request implemented/closed" notices on Discord
 * (issue #35): when someone holding one of the `clauderequest` roles replies
 * to a notice the bot posted, the reply is commented on the GitHub issue,
 * the issue is reopened and tracked again so they hear back when it closes.
 * Anyone else (or a reply to any other message) is left alone, silently, so
 * the message is just chat.
 */
export default class DiscordClaudeRequestReplyHandler {
    constructor(
        private readonly claudeRequestService: ClaudeRequestService,
        private readonly notifyService: ClaudeRequestNotifyService,
        private readonly allowedRoleIds: readonly string[]
    ) {}

    /**
     * Handles `message` if it is a permitted reply to a notice. Resolves
     * true when it was consumed as such (whatever GitHub said), false
     * otherwise. Never rejects. Call it only for non-command messages.
     */
    async handle(message: Message): Promise<boolean> {
        try {
            if (message.author.bot || message.webhookId) return false;
            if (!message.inGuild()) return false;
            const referencedId = message.reference?.messageId;
            if (!referencedId) return false;
            const text = message.content.trim();
            if (!text) return false;

            const notice = await this.notifyService.findNotice(
                'discord',
                referencedId
            );
            if (!notice) return false;
            if (!(await this.hasAllowedRole(message))) return false;

            const result = await this.claudeRequestService.reopenWithReply({
                issueNumber: notice.issueNumber,
                text,
                platform: 'discord',
                authorId: message.author.id,
                authorName: message.author.username,
                guildName: message.guild.name,
                channelName:
                    'name' in message.channel ? message.channel.name : null,
                messageUrl: message.url,
            });
            const outcome = describeClaudeRequestReplyResult(result);
            if (!outcome) return false;

            if (result.ok) {
                logger.info(
                    `🤖 Discord user ${message.author.id} replied to Claude request #${result.number}${result.reopened ? ' and reopened it' : ''}`
                );
            }
            // Track first so a failed confirmation cannot cost the close
            // notification.
            if (result.ok && result.reopened) {
                await this.notifyService.track({
                    platform: 'discord',
                    issueNumber: notice.issueNumber,
                    issueUrl: notice.issueUrl,
                    title: notice.title,
                    userId: message.author.id,
                    guildId: message.guildId,
                    channelId: message.channelId,
                    messageId: message.id,
                });
            }
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(outcome.description)
                        .setColor(KIND_COLORS[outcome.kind])
                        .setTimestamp(),
                ],
                allowedMentions: { parse: [], repliedUser: false },
            });
            return true;
        } catch (err) {
            logger.error(
                '❌ Failed to handle a reply to a Claude request notice on Discord:',
                err
            );
            return false;
        }
    }

    /** Same check as `requireRole`, but silent: no reply on failure. */
    private async hasAllowedRole(message: Message<true>): Promise<boolean> {
        try {
            const member = await message.guild.members.fetch(message.author.id);
            return this.allowedRoleIds.some((id) => member.roles.cache.has(id));
        } catch {
            return false;
        }
    }
}
