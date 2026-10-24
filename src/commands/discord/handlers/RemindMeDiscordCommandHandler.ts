import {
    Client,
    EmbedBuilder,
    GuildBasedChannel,
    PermissionFlagsBits,
} from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { stripReminderInvocation } from '../../reminderTrigger';
import ReminderService from '../../../services/reminders/ReminderService';
import ReminderTimezoneService from '../../../services/reminders/ReminderTimezoneService';
import {
    dateReminderConfirmation,
    INVALID_TIME_MESSAGE,
    reminderFailureMessage,
    timezonePromptMessage,
} from '../../timezoneCommand';
import {
    extractChannelId,
    parseRemindMeArgs,
} from '../../../services/reminders/reminderArgs';
import {
    formatReminderDuration,
    formatReminderTime,
} from '../../../services/reminders/reminderFormat';
import { ReminderDateSpec } from '../../../services/reminders/reminderDate';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/** Kept under its old name; it now mentions date/time forms (issue #27). */
export const INVALID_DURATION_MESSAGE = INVALID_TIME_MESSAGE;

/**
 * `remindme <time> <message>` (alias `remind`), optionally with
 * `-channel <#channel>`: schedules a reminder that is posted back into the
 * channel (YAGPDB-style, issue #9). Reachable with the bot prefix and with
 * the short trigger prefixes (`?remindme ...`). The time may also be a date
 * or time of day (`Oct 26 20:15`, `Monday 7pm`, `tomorrow`; issue #27),
 * read in the user's time zone; without one the reminder waits while the
 * user is asked to set it with `timezone`.
 */
export default class RemindMeDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly reminderService: ReminderService,
        private readonly timezoneService: ReminderTimezoneService,
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

    /** Replies with the usage embed, preceded by an error embed when given. */
    private async replyUsage(
        message: DiscordCommandHandlerMessage,
        error?: string
    ) {
        const usage = getDiscordCommandUsage('remindme');
        if (!error) {
            await message.reply(usage);
            return;
        }
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(error)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
                ...(usage.embeds ?? []),
            ],
        });
    }

    private failureMessage(
        reason: Parameters<typeof reminderFailureMessage>[0]
    ): string | null {
        return reminderFailureMessage(reason, this.hintPrefix);
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
            await this.replyError(message, 'Cannot create reminders for bots.');
            return;
        }

        const raw =
            stripReminderInvocation(message.content, [
                COMMAND_PREFIX,
                ...this.triggerPrefixes,
            ]) ?? args.join(' ');
        const parsed = parseRemindMeArgs(raw);
        if (!parsed.ok) {
            switch (parsed.reason) {
                case 'invalid_time':
                    await this.replyUsage(message, INVALID_DURATION_MESSAGE);
                    return;
                case 'missing_channel':
                    await this.replyUsage(
                        message,
                        '`-channel` must be followed by a channel mention or ID.'
                    );
                    return;
                default:
                    await this.replyUsage(message);
                    return;
            }
        }

        let channelId = message.channelId;
        if (parsed.channelRef !== null) {
            const targetId = extractChannelId(parsed.channelRef);
            if (!targetId) {
                await this.replyError(
                    message,
                    'Please mention a channel or give its ID.'
                );
                return;
            }

            let channel: GuildBasedChannel | null;
            try {
                channel = await message.guild.channels.fetch(targetId);
            } catch {
                channel = null;
            }
            // Voice channels count as text-based in discord.js; reminders
            // go to text channels, announcement channels and threads only.
            if (!channel || !channel.isTextBased() || channel.isVoiceBased()) {
                await this.replyError(
                    message,
                    channel
                        ? `<#${targetId}> is not a text channel.`
                        : 'Channel not found in this server.'
                );
                return;
            }

            let member;
            try {
                member = await message.guild.members.fetch(message.author.id);
            } catch {
                await this.replyError(
                    message,
                    'Could not fetch your member information.'
                );
                return;
            }
            if (
                !member
                    .permissionsIn(channel)
                    .has([
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                    ])
            ) {
                await this.replyError(
                    message,
                    `You need View Channel and Send Messages in <#${targetId}> to set a reminder there.`
                );
                return;
            }
            channelId = channel.id;
        }

        const where =
            channelId === message.channelId ? '' : ` in <#${channelId}>`;
        if (parsed.when.kind === 'date') {
            await this.createDateReminder(
                message,
                message.guildId,
                channelId,
                parsed.when.spec,
                parsed.message,
                where
            );
            return;
        }

        const { delayMs } = parsed.when;
        try {
            const result = await this.reminderService.create({
                platform: 'discord',
                userId: message.author.id,
                guildId: message.guildId,
                channelId,
                message: parsed.message,
                delayMs,
            });
            if (!result.ok) {
                const text = this.failureMessage(result.reason);
                if (text) await this.replyError(message, text);
                else await this.replyUsage(message);
                return;
            }

            const { reminder } = result;
            await this.replyEmbed(
                message,
                `Set reminder **#${reminder.id}** in ${formatReminderDuration(delayMs)} from now (${formatReminderTime(reminder.dueAt, 'discord')})${where}\n` +
                    `View your reminders with \`${this.hintPrefix}reminders\``,
                EmbedColors.Success
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to create the reminder: ${(err as Error).message}`
            );
            logger.error('❌ Creating a Discord reminder failed:', err);
        }
    }

    /**
     * A date/time reminder (issue #27): resolved in the user's stored zone,
     * or parked in the timezone service while the user is asked for one.
     */
    private async createDateReminder(
        message: DiscordCommandHandlerMessage,
        guildId: string,
        channelId: string,
        spec: ReminderDateSpec,
        text: string,
        where: string
    ): Promise<void> {
        const userId = message.author.id;
        try {
            const zone = await this.timezoneService.getTimeZone(
                'discord',
                userId
            );
            if (zone === null) {
                this.timezoneService.setPending('discord', userId, {
                    guildId,
                    channelId,
                    originChannelId: message.channelId,
                    spec,
                    message: text,
                });
                logger.info(
                    `🕰️ Discord date reminder by ${userId} waits for their time zone`
                );
                await this.replyEmbed(
                    message,
                    timezonePromptMessage(this.hintPrefix),
                    EmbedColors.Info
                );
                return;
            }

            const result = await this.timezoneService.createDateReminder(
                'discord',
                userId,
                { guildId, channelId, spec, message: text },
                zone
            );
            if (!result.ok) {
                const error = this.failureMessage(result.reason);
                if (result.reason === 'invalid_date' || error === null) {
                    await this.replyUsage(message, error ?? undefined);
                } else {
                    await this.replyError(message, error);
                }
                return;
            }
            await this.replyEmbed(
                message,
                dateReminderConfirmation(
                    'discord',
                    result.reminder,
                    result.delayMs,
                    zone,
                    where,
                    this.hintPrefix
                ),
                EmbedColors.Success
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to create the reminder: ${(err as Error).message}`
            );
            logger.error('❌ Creating a Discord date reminder failed:', err);
        }
    }
}
