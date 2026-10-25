import type { RoleIdsResolver } from '../../../services/commandRoles/CommandRoleService';
import {
    Channel,
    Client,
    EmbedBuilder,
    Guild,
    GuildMember,
    Message,
    PermissionFlags,
} from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { memberPermissionsIn } from './RemindMeFluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { stripCommandInvocation } from '../../commandTrigger';
import {
    CLEAN_COMMAND_NAMES,
    cleanFailureMessage,
    parseCleanArgs,
} from '../../../services/clean/cleanArgs';
import {
    CleanCandidate,
    CleanSource,
    collectMessagesToClean,
} from '../../../services/clean/cleanFilter';
import {
    cleanDeleteFailureMessage,
    deleteInBatches,
} from '../../../services/clean/cleanDelete';
import { COMMAND_PREFIX, DELETE_INVOCATION } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/** How long the "Deleted n message(s)" confirmation stays before it is removed. */
export const CLEAN_CONFIRMATION_TTL_MS = 5_000;

/** A Fluxer message reduced to what the clean filters look at. */
function toCleanCandidate(message: Message): CleanCandidate {
    return {
        id: message.id,
        authorId: message.author.id,
        authorIsBot: message.author.bot || message.webhookId !== null,
        content: message.content,
        createdAt: message.createdAt,
        pinned: message.pinned,
        hasAttachments: message.attachments.size > 0,
    };
}

/**
 * `clean <num> [user] [switches]` (aliases `clear`, `cl`): bulk-deletes the
 * last `num` messages of the channel that pass the filters (issue #12,
 * modelled on YAGPDB's `clean`). A moderator command: only members holding
 * one of the configured moderator roles may use it. Besides `!b clean ...`
 * it is triggered by the configured short prefixes (`?clean 10`,
 * `!clean 10`). Argument parsing and message selection are shared with the
 * Discord side (`services/clean`); this class adapts the Fluxer API.
 *
 * Fluxer's bulk-delete route has no age limit (unlike Discord's two weeks),
 * so every selected message is deleted.
 */
export default class CleanFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly moderatorRoleIds: RoleIdsResolver,
        private readonly triggerPrefixes: readonly string[]
    ) {
        super(client);
    }

    private embed(message: Message, description: string, color: number) {
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

    /** An error line followed by the command usage, in one reply. */
    private async replyUsage(
        message: Message,
        error: string | null
    ): Promise<void> {
        const usage = getFluxerCommandUsage('clean');
        const embeds = [...(usage.embeds ?? [])];
        if (error) {
            embeds.unshift(this.embed(message, error, EmbedColors.Error));
        }
        await message.reply({ ...usage, embeds });
    }

    /**
     * Posts `description` as a standalone message (not a reply: the invoking
     * message is about to be deleted) and removes it again after
     * {@link CLEAN_CONFIRMATION_TTL_MS}, without waiting for that.
     */
    private async sendTransient(
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        const sent = await message.send({
            embeds: [this.embed(message, description, color)],
        });
        setTimeout(() => {
            sent.delete().catch(() => {});
        }, CLEAN_CONFIRMATION_TTL_MS);
    }

    /** The bot's own member in `guild`: from the cache, else fetched. */
    private async fetchOwnMember(guild: Guild): Promise<GuildMember | null> {
        if (guild.members.me) return guild.members.me;
        const userId = this.getClient().user?.id;
        if (!userId) return null;
        return guild.fetchMember(userId).catch((err: unknown) => {
            logger.warn(
                `⚠️ Could not fetch the bot's own member in Fluxer guild ${guild.id}:`,
                err
            );
            return null;
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
        const roleIds = message.guildId
            ? await this.moderatorRoleIds(message.guildId)
            : [];
        if (!(await this.requireRole(message, roleIds))) {
            return;
        }

        // Read the arguments from the raw content so quoted switch values
        // (`-r "foo bar"`) survive; fall back to the split args.
        const raw =
            stripCommandInvocation(
                message.content,
                [COMMAND_PREFIX, ...this.triggerPrefixes],
                CLEAN_COMMAND_NAMES
            ) ?? args.join(' ');
        const parsed = parseCleanArgs(raw);
        if (!parsed.ok) {
            await this.replyUsage(message, cleanFailureMessage(parsed));
            return;
        }

        const channel: Channel | null =
            message.channel ??
            (await message.resolveChannel().catch(() => null));
        if (!channel || !(channel.isText() || channel.isThread())) {
            await this.reply(
                message,
                'Messages can only be cleaned in text channels and threads.',
                EmbedColors.Error
            );
            return;
        }

        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        const me = guild ? await this.fetchOwnMember(guild) : null;
        const myPermissions = me ? memberPermissionsIn(me, channel) : null;
        if (
            !myPermissions ||
            !myPermissions.has(PermissionFlags.ManageMessages) ||
            !myPermissions.has(PermissionFlags.ReadMessageHistory)
        ) {
            await this.reply(
                message,
                'I need the `Manage Messages` and `Read Message History` permissions in this channel to clean it.',
                EmbedColors.Error
            );
            return;
        }

        const source: CleanSource = {
            fetchBefore: async (beforeId, limit) => {
                const page = await channel.messages.fetch({
                    limit,
                    before: beforeId,
                });
                return [...page.values()].map(toCleanCandidate);
            },
        };

        try {
            // No `maxDeletableAgeMs`: Fluxer bulk-deletes messages of any age.
            const ids = await collectMessagesToClean(
                source,
                parsed.options,
                message.id
            );
            if (ids.length === 0) {
                await this.sendTransient(
                    message,
                    'No messages matched.',
                    EmbedColors.Info
                );
            } else {
                const result = await deleteInBatches(ids, async (batch) => {
                    await channel.bulkDelete(batch);
                    return batch.length;
                });
                if (result.error !== null) {
                    logger.error('❌ Clean failed on Fluxer:', result.error);
                    await this.reply(
                        message,
                        cleanDeleteFailureMessage(result),
                        EmbedColors.Error
                    );
                    return;
                }
                logger.info(
                    `🧹 Cleaned ${result.deleted} message(s) in Fluxer channel ${channel.id} for ${message.author.id}`
                );
                await this.sendTransient(
                    message,
                    `Deleted ${result.deleted} message(s)! :')`,
                    EmbedColors.Success
                );
            }
        } catch (err) {
            logger.error('❌ Clean failed on Fluxer:', err);
            await this.reply(
                message,
                `Failed to delete messages: ${(err as Error).message}`,
                EmbedColors.Error
            );
            return;
        }

        // The invoking message goes too (YAGPDB does the same). With
        // DELETE_INVOCATION the dispatcher in fluxer.ts already deletes it
        // after every command; deleting it here as well would make that
        // deletion fail and log an error.
        if (!DELETE_INVOCATION) {
            await message.delete().catch(() => {});
        }
    }
}
