import {
    Client,
    EmbedBuilder,
    GuildMember,
    PermissionFlagsBits,
} from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { stripCommandInvocation } from '../../commandTrigger';
import {
    CLEAN_COMMAND_NAMES,
    cleanFailureMessage,
    parseCleanArgs,
} from '../../../services/clean/cleanArgs';
import {
    CleanSource,
    collectMessagesToClean,
    DISCORD_BULK_DELETE_MAX_AGE_MS,
} from '../../../services/clean/cleanFilter';
import {
    cleanDeleteFailureMessage,
    deleteInBatches,
} from '../../../services/clean/cleanDelete';
import { COMMAND_PREFIX, DELETE_INVOCATION } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/** How long the confirmation embed stays in the channel before it is removed. */
export const CLEAN_CONFIRMATION_DELETE_DELAY_MS = 5_000;

/**
 * `clean <num> [user] [switches]` (aliases `clear`, `cl`): bulk-deletes the
 * last `num` matching messages in the channel, YAGPDB-style (issue #12).
 * A moderator command: only members holding one of the configured
 * `roles.moderator` IDs may run it. Reachable with the bot prefix and with
 * the short trigger prefixes (`?clean 10`). The filters live in
 * `services/clean`; this handler adapts Discord messages to them and
 * mirrors the confirmation flow of YAGPDB (a short-lived "Deleted n
 * message(s)!" notice).
 */
export default class CleanDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly moderatorRoleIds: readonly string[],
        private readonly triggerPrefixes: readonly string[]
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

    private async replyError(
        message: DiscordCommandHandlerMessage,
        description: string
    ) {
        await message.reply({
            embeds: [this.embed(message, description, EmbedColors.Error)],
        });
    }

    /** Replies with the usage embed, preceded by an error embed when given. */
    private async replyUsage(
        message: DiscordCommandHandlerMessage,
        error?: string
    ) {
        const usage = getDiscordCommandUsage('clean');
        if (!error) {
            await message.reply(usage);
            return;
        }
        await message.reply({
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    /**
     * Sends a confirmation into the channel (not as a reply: the invoking
     * message is gone by the time anyone reads it) and removes it again after
     * {@link CLEAN_CONFIRMATION_DELETE_DELAY_MS}, without waiting for that.
     */
    private async sendTransient(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): Promise<void> {
        if (!message.channel.isSendable()) return;
        const sent = await message.channel.send({
            embeds: [this.embed(message, description, color)],
        });
        setTimeout(() => {
            sent.delete().catch(() => {});
        }, CLEAN_CONFIRMATION_DELETE_DELAY_MS);
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
            await this.replyError(message, 'Bots cannot use this command.');
            return;
        }

        if (!(await this.requireRole(message, this.moderatorRoleIds))) {
            return;
        }

        const raw =
            stripCommandInvocation(
                message.content,
                [COMMAND_PREFIX, ...this.triggerPrefixes],
                CLEAN_COMMAND_NAMES
            ) ?? args.join(' ');
        const parsed = parseCleanArgs(raw);
        if (!parsed.ok) {
            await this.replyUsage(
                message,
                cleanFailureMessage(parsed) ?? undefined
            );
            return;
        }

        // Voice channels count as text-based in discord.js; cleaning is for
        // text channels, announcement channels and threads.
        const channel = message.channel;
        if (
            !channel.isTextBased() ||
            channel.isVoiceBased() ||
            !('bulkDelete' in channel)
        ) {
            await this.replyError(
                message,
                'Messages can only be cleaned in text channels and threads.'
            );
            return;
        }

        let me: GuildMember | null = message.guild.members.me;
        if (!me) {
            me = await message.guild.members.fetchMe().catch(() => null);
        }
        if (
            !me ||
            !me
                .permissionsIn(channel)
                .has([
                    PermissionFlagsBits.ManageMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                ])
        ) {
            await this.replyError(
                message,
                'I need the `Manage Messages` and `Read Message History` permissions in this channel to clean it.'
            );
            return;
        }

        const source: CleanSource = {
            async fetchBefore(beforeId, limit) {
                const fetched = await channel.messages.fetch({
                    limit,
                    before: beforeId,
                });
                return [...fetched.values()].map((m) => ({
                    id: m.id,
                    authorId: m.author.id,
                    authorIsBot: m.author.bot,
                    content: m.content,
                    createdAt: m.createdAt,
                    pinned: m.pinned,
                    hasAttachments: m.attachments.size > 0,
                }));
            },
        };

        try {
            const ids = await collectMessagesToClean(
                source,
                parsed.options,
                message.id,
                { maxDeletableAgeMs: DISCORD_BULK_DELETE_MAX_AGE_MS }
            );

            if (ids.length === 0) {
                await this.sendTransient(
                    message,
                    'No messages matched.',
                    EmbedColors.Info
                );
            } else {
                const result = await deleteInBatches(
                    ids,
                    async (batch) =>
                        (await channel.bulkDelete(batch, true)).size
                );
                if (result.error !== null) {
                    logger.error('❌ Clean failed on Discord:', result.error);
                    await this.replyError(
                        message,
                        cleanDeleteFailureMessage(result)
                    );
                    return;
                }
                await this.sendTransient(
                    message,
                    `Deleted ${result.deleted} message(s)! :')`,
                    EmbedColors.Success
                );
            }

            // The invocation goes too, like YAGPDB does. With DELETE_INVOCATION
            // the dispatcher deletes every invocation itself once the handler
            // returns (and logs a failure if it is already gone), so only
            // delete it here when the dispatcher will not.
            if (!DELETE_INVOCATION) {
                message.delete().catch(() => {});
            }
        } catch (err: unknown) {
            logger.error('❌ Clean failed on Discord:', err);
            await this.replyError(
                message,
                `Failed to delete messages: ${(err as Error).message}`
            );
        }
    }
}
