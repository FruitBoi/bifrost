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
import { stripReminderInvocation } from '../../reminderTrigger';
import { Reminder } from '../../../db/entities/Reminder';
import ReminderService from '../../../services/reminders/ReminderService';
import { parseReminderDeleteArgs } from '../../../services/reminders/reminderArgs';
import {
    cutReminderShort,
    formatReminderLine,
} from '../../../services/reminders/reminderFormat';
import { COMMAND_PREFIX } from '../../../utils/env';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

type ReminderSubcommand = 'list' | 'channel' | 'delete';

/** Command words that imply a subcommand (`reminders` = `reminder list`). */
const ALIAS_SUBCOMMANDS: Record<string, ReminderSubcommand> = {
    reminders: 'list',
    creminders: 'channel',
    channelreminders: 'channel',
    delreminder: 'delete',
    rmreminder: 'delete',
};

/** Subcommand words accepted after `reminder`. */
const SUBCOMMAND_WORDS: Record<string, ReminderSubcommand> = {
    list: 'list',
    channel: 'channel',
    delete: 'delete',
    del: 'delete',
    remove: 'delete',
    rm: 'delete',
};

/**
 * `reminder list | channel | delete [id] [-a]` and its aliases `reminders`,
 * `creminders` / `channelreminders` and `delreminder` / `rmreminder`:
 * shows and removes reminders created with `remindme` (issue #9).
 */
export default class ReminderDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly reminderService: ReminderService,
        private readonly triggerPrefixes: readonly string[]
    ) {
        super(client);
    }

    /** Prefix shown in hints: the first short trigger, else the bot prefix. */
    private get hintPrefix(): string {
        return this.triggerPrefixes[0] ?? COMMAND_PREFIX;
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

    /** Sends `lines` as one or more Info embeds, the first one titled. */
    private async replyLines(
        message: DiscordCommandHandlerMessage,
        title: string,
        lines: string[]
    ) {
        const embeds = chunkDescriptionLines(lines, '\n').map((chunk, i) =>
            new EmbedBuilder()
                .setTitle(i === 0 ? title : null)
                .setDescription(chunk.join('\n'))
                .setColor(EmbedColors.Info)
        );
        embeds[embeds.length - 1]
            .setFooter(this.footer(message))
            .setTimestamp();
        await this.replyEmbeds(message, embeds);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.replyError(
                message,
                'This command must be used in a server.'
            );
            return;
        }

        const raw =
            stripReminderInvocation(message.content, [
                COMMAND_PREFIX,
                ...this.triggerPrefixes,
            ]) ?? args.join(' ');

        let subcommand: ReminderSubcommand | undefined =
            ALIAS_SUBCOMMANDS[command.toLowerCase()];
        let rest = raw;
        if (!subcommand) {
            const match = /^(\S+)\s*/.exec(raw);
            subcommand = match
                ? SUBCOMMAND_WORDS[match[1].toLowerCase()]
                : undefined;
            rest = match ? raw.slice(match[0].length) : '';
        }
        if (!subcommand) {
            await message.reply(getDiscordCommandUsage('reminder'));
            return;
        }

        try {
            switch (subcommand) {
                case 'list':
                    await this.handleList(message);
                    return;
                case 'channel':
                    await this.handleChannel(message);
                    return;
                case 'delete':
                    await this.handleDelete(message, rest);
                    return;
            }
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to ${subcommand === 'delete' ? 'delete' : 'list'} reminders: ${(err as Error).message}`
            );
            logger.error(`❌ Discord reminder ${subcommand} failed:`, err);
        }
    }

    private async handleList(message: DiscordCommandHandlerMessage) {
        const reminders = await this.reminderService.listForUser(
            'discord',
            message.author.id,
            message.guildId!
        );
        if (reminders.length === 0) {
            await this.replyEmbed(
                message,
                `You have no reminders in this server. Create reminders with \`${this.hintPrefix}remindme\`.`,
                EmbedColors.Info
            );
            return;
        }

        const lines = reminders.map((r) =>
            formatReminderLine(r, `<#${r.channelId}>`)
        );
        lines.push(
            `Delete reminders with \`${this.hintPrefix}reminder delete <id>\`.`
        );
        await this.replyLines(message, 'Your reminders', lines);
    }

    private async handleChannel(message: DiscordCommandHandlerMessage) {
        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageChannels,
                'Manage Channels'
            ))
        )
            return;

        const reminders = await this.reminderService.listForChannel(
            'discord',
            message.channelId
        );
        if (reminders.length === 0) {
            await this.replyEmbed(
                message,
                'There are no reminders in this channel.',
                EmbedColors.Info
            );
            return;
        }

        const names = new Map<string, Promise<string>>();
        const usernameOf = (userId: string) => {
            let name = names.get(userId);
            if (!name) {
                name = this.resolveUsername(message, userId);
                names.set(userId, name);
            }
            return name;
        };
        const lines = await Promise.all(
            reminders.map(async (r) =>
                formatReminderLine(r, await usernameOf(r.userId))
            )
        );
        await this.replyLines(message, 'Reminders in this channel', lines);
    }

    private async resolveUsername(
        message: DiscordCommandHandlerMessage,
        userId: string
    ): Promise<string> {
        const member = await message.guild?.members
            .fetch(userId)
            .catch(() => null);
        if (member) return member.user.username;
        const user = await this.getClient()
            .users.fetch(userId)
            .catch(() => null);
        return user?.username ?? 'Unknown user';
    }

    private async handleDelete(
        message: DiscordCommandHandlerMessage,
        raw: string
    ) {
        const parsed = parseReminderDeleteArgs(raw);

        if (parsed.all) {
            const count = await this.reminderService.deleteAllForUser(
                'discord',
                message.author.id
            );
            await this.replyEmbed(
                message,
                count > 0
                    ? `Cleared ${count} reminder${count === 1 ? '' : 's'}`
                    : 'No reminders to clear',
                count > 0 ? EmbedColors.Success : EmbedColors.Info
            );
            return;
        }

        if (parsed.invalidId) {
            await this.replyError(message, 'Reminder IDs are whole numbers.');
            return;
        }
        if (parsed.id === null) {
            await this.replyError(message, 'No reminder ID provided');
            return;
        }

        const reminder = await this.reminderService.getById(parsed.id);
        if (!reminder || reminder.platform !== 'discord') {
            await this.replyError(message, 'No reminder by that ID found');
            return;
        }

        if (
            reminder.userId !== message.author.id &&
            !(await this.mayDeleteOthers(message, reminder))
        ) {
            await this.replyError(
                message,
                "You can only delete your own reminders (or others' with Manage Channels in their channel, in the same server)."
            );
            return;
        }

        if (!(await this.reminderService.delete(reminder.id))) {
            await this.replyError(message, 'No reminder by that ID found');
            return;
        }
        await this.replyEmbed(
            message,
            `Deleted reminder **#${reminder.id}**: '${cutReminderShort(reminder.message)}'`,
            EmbedColors.Success
        );
    }

    /**
     * Someone else's reminder may be deleted when it belongs to this server
     * and the author has Manage Channels in the reminder's channel (or in the
     * server, when that channel no longer exists).
     */
    private async mayDeleteOthers(
        message: DiscordCommandHandlerMessage,
        reminder: Reminder
    ): Promise<boolean> {
        if (reminder.guildId !== message.guildId || !message.guild) {
            return false;
        }
        let member: GuildMember;
        try {
            member = await message.guild.members.fetch(message.author.id);
        } catch {
            return false;
        }
        const channel = await message.guild.channels
            .fetch(reminder.channelId)
            .catch(() => null);
        const permissions = channel
            ? member.permissionsIn(channel)
            : member.permissions;
        return permissions.has(PermissionFlagsBits.ManageChannels);
    }
}
