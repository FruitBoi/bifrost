import {
    Client,
    EmbedBuilder,
    Guild,
    Message,
    PermissionFlags,
} from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { stripReminderInvocation } from '../../reminderTrigger';
import ReminderService from '../../../services/reminders/ReminderService';
import { parseReminderDeleteArgs } from '../../../services/reminders/reminderArgs';
import {
    cutReminderShort,
    formatReminderLine,
} from '../../../services/reminders/reminderFormat';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { Reminder } from '../../../db/entities/Reminder';
import { COMMAND_PREFIX } from '../../../utils/env';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';
import {
    memberPermissionsIn,
    reminderHintPrefix,
} from './RemindMeFluxerCommandHandler';

type Subcommand = 'list' | 'channel' | 'delete';

/** Command words that imply a subcommand (`reminders` = `reminder list`). */
const ALIAS_SUBCOMMANDS: Record<string, Subcommand> = {
    reminders: 'list',
    creminders: 'channel',
    channelreminders: 'channel',
    delreminder: 'delete',
    rmreminder: 'delete',
};

const SUBCOMMANDS: Record<string, Subcommand> = {
    list: 'list',
    channel: 'channel',
    delete: 'delete',
};

/**
 * `reminder list|channel|delete` (issue #9, modelled on YAGPDB):
 * - `list` (alias `reminders`): the caller's reminders in this server;
 * - `channel` (aliases `creminders`, `channelreminders`): every reminder set
 *   for the current channel, requires Manage Channels;
 * - `delete <id>` / `delete -a` (aliases `delreminder`, `rmreminder`):
 *   deletes one of the caller's reminders (or someone else's with Manage
 *   Channels in its channel) or all of the caller's reminders.
 */
export default class ReminderFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly reminderService: ReminderService,
        private readonly fluxerEntityResolver: FluxerEntityResolver,
        private readonly triggerPrefixes: readonly string[]
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

    /** Replies with a titled list, split across embeds/messages as needed. */
    private async replyList(
        message: Message,
        title: string,
        lines: string[],
        hint: string
    ): Promise<void> {
        const chunks = chunkDescriptionLines([...lines, hint], '\n');
        const embeds = chunks.map((chunk, i) =>
            new EmbedBuilder()
                .setTitle(i === 0 ? title : `${title} (continued)`)
                .setDescription(chunk.join('\n'))
                .setColor(EmbedColors.Info)
                .setFooter(
                    i === chunks.length - 1 ? this.footer(message) : null
                )
                .setTimestamp()
        );
        await this.replyEmbeds(message, embeds);
    }

    private async resolveGuild(message: Message): Promise<Guild | null> {
        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        if (!guild) {
            await this.reply(
                message,
                'Could not resolve this server.',
                EmbedColors.Error
            );
        }
        return guild;
    }

    public async handleCommand(
        message: Message,
        command: string,
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

        const raw =
            stripReminderInvocation(message.content, [
                COMMAND_PREFIX,
                ...this.triggerPrefixes,
            ]) ?? args.join(' ');

        // Aliases carry their subcommand; `reminder` reads it from the args.
        let subcommand: Subcommand | undefined =
            ALIAS_SUBCOMMANDS[command.toLowerCase()];
        let rest = raw;
        if (!subcommand) {
            const match = /^(\S+)\s*/.exec(raw);
            subcommand = match
                ? SUBCOMMANDS[match[1].toLowerCase()]
                : undefined;
            rest = match ? raw.slice(match[0].length) : '';
            if (!subcommand) {
                await message.reply(getFluxerCommandUsage('reminder'));
                return;
            }
        }

        try {
            switch (subcommand) {
                case 'list':
                    await this.list(message, message.guildId);
                    return;
                case 'channel':
                    await this.channel(message);
                    return;
                case 'delete':
                    await this.delete(message, message.guildId, rest);
                    return;
            }
        } catch (err) {
            logger.error(
                `❌ Fluxer reminder ${subcommand} failed for user ${message.author.id}:`,
                err
            );
            await this.reply(
                message,
                `Something went wrong: ${(err as Error).message}`,
                EmbedColors.Error
            );
        }
    }

    private async list(message: Message, guildId: string): Promise<void> {
        const p = reminderHintPrefix(this.triggerPrefixes);
        const reminders = await this.reminderService.listForUser(
            'fluxer',
            message.author.id,
            guildId
        );
        if (reminders.length === 0) {
            await this.reply(
                message,
                `You have no reminders in this server. Create reminders with \`${p}remindme\`.`,
                EmbedColors.Info
            );
            return;
        }
        await this.replyList(
            message,
            'Your reminders',
            reminders.map((r) => formatReminderLine(r, `<#${r.channelId}>`)),
            `Delete reminders with \`${p}reminder delete <id>\`.`
        );
    }

    private async channel(message: Message): Promise<void> {
        if (
            !(await this.requirePermission(
                message,
                PermissionFlags.ManageChannels,
                'Manage Channels'
            ))
        )
            return;

        const reminders = await this.reminderService.listForChannel(
            'fluxer',
            message.channelId
        );
        if (reminders.length === 0) {
            await this.reply(
                message,
                'There are no reminders in this channel.',
                EmbedColors.Info
            );
            return;
        }

        const guild = await this.resolveGuild(message);
        if (!guild) return;

        const names = new Map<string, string>();
        const lines: string[] = [];
        for (const reminder of reminders) {
            let who = names.get(reminder.userId);
            if (who === undefined) {
                who = await this.resolveUsername(guild, reminder.userId);
                names.set(reminder.userId, who);
            }
            lines.push(formatReminderLine(reminder, who));
        }
        const p = reminderHintPrefix(this.triggerPrefixes);
        await this.replyList(
            message,
            'Reminders in this channel',
            lines,
            `Delete reminders with \`${p}reminder delete <id>\`.`
        );
    }

    private async resolveUsername(
        guild: Guild,
        userId: string
    ): Promise<string> {
        const member = await guild.fetchMember(userId).catch(() => null);
        if (member) return member.user.username;
        const user = await this.getClient()
            .users.fetch(userId)
            .catch(() => null);
        return user?.username ?? 'Unknown user';
    }

    private async delete(
        message: Message,
        guildId: string,
        raw: string
    ): Promise<void> {
        const parsed = parseReminderDeleteArgs(raw);
        const authorId = message.author.id;

        if (parsed.all) {
            const count = await this.reminderService.deleteAllForUser(
                'fluxer',
                authorId
            );
            if (count > 0) {
                logger.info(
                    `🗑️ Cleared ${count} Fluxer reminders of user ${authorId}`
                );
            }
            await this.reply(
                message,
                count > 0
                    ? `Cleared ${count} reminder${count === 1 ? '' : 's'}`
                    : 'No reminders to clear',
                count > 0 ? EmbedColors.Success : EmbedColors.Info
            );
            return;
        }

        if (parsed.invalidId) {
            await this.reply(
                message,
                'Reminder IDs are whole numbers.',
                EmbedColors.Error
            );
            return;
        }
        if (parsed.id === null) {
            await this.reply(
                message,
                'No reminder ID provided',
                EmbedColors.Error
            );
            return;
        }

        const reminder = await this.reminderService.getById(parsed.id);
        if (!reminder || reminder.platform !== 'fluxer') {
            await this.reply(
                message,
                'No reminder by that ID found',
                EmbedColors.Error
            );
            return;
        }

        if (
            reminder.userId !== authorId &&
            !(await this.mayDeleteOthers(message, guildId, reminder))
        ) {
            await this.reply(
                message,
                "You can only delete your own reminders (or others' with Manage Channels in their channel, in the same server).",
                EmbedColors.Error
            );
            return;
        }

        const deleted = await this.reminderService.delete(reminder.id);
        if (!deleted) {
            await this.reply(
                message,
                'No reminder by that ID found',
                EmbedColors.Error
            );
            return;
        }
        logger.info(
            `🗑️ Fluxer reminder #${reminder.id} deleted by user ${authorId}`
        );
        await this.reply(
            message,
            `Deleted reminder **#${reminder.id}**: '${cutReminderShort(reminder.message)}'`,
            EmbedColors.Success
        );
    }

    /**
     * Someone else's reminder may be deleted when it belongs to this server
     * and the caller has Manage Channels in the reminder's channel (or in the
     * server when that channel no longer exists).
     */
    private async mayDeleteOthers(
        message: Message,
        guildId: string,
        reminder: Reminder
    ): Promise<boolean> {
        if (reminder.guildId !== guildId) return false;
        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        if (!guild) return false;
        const member = await guild
            .fetchMember(message.author.id)
            .catch(() => null);
        if (!member) return false;
        const channel = await this.fluxerEntityResolver.fetchChannel(
            guild,
            reminder.channelId
        );
        return memberPermissionsIn(member, channel).has(
            PermissionFlags.ManageChannels
        );
    }
}
