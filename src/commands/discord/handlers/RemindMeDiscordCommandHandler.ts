import {
    Client,
    EmbedBuilder,
    GuildBasedChannel,
    Message,
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
    NOT_YOUR_REMINDER_MESSAGE,
    nothingToSnoozeMessage,
    parseRemindMeArgs,
    parseSnoozeArgs,
    ReminderWhen,
    SNOOZE_ONLY_TIME_MESSAGE,
    SnoozeArgs,
} from '../../../services/reminders/reminderArgs';
import {
    formatReminderDuration,
    formatReminderTime,
} from '../../../services/reminders/reminderFormat';
import { ReminderDateSpec } from '../../../services/reminders/reminderDate';
import { Reminder } from '../../../db/entities/Reminder';
import { ReminderMessage } from '../../../db/entities/ReminderMessage';
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
 * user is asked to set it with `timezone`. `remindme snooze <time>` (or
 * `again`) sets the replied-to reminder, or the last one that went off,
 * again (issue #58).
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
    ): Promise<Message> {
        return message.reply({
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
        const snooze = parseSnoozeArgs(raw);
        if (snooze.snooze) {
            await this.snooze(message, message.guildId, snooze);
            return;
        }

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

        await this.schedule(
            message,
            message.guildId,
            channelId,
            parsed.when,
            parsed.message
        );
    }

    /**
     * Sets the reminder for `when`: a date in the user's time zone, or a
     * delay from now. Shared by `remindme` and its snooze form (issue #58).
     */
    private async schedule(
        message: DiscordCommandHandlerMessage,
        guildId: string,
        channelId: string,
        when: ReminderWhen,
        text: string
    ): Promise<void> {
        const where =
            channelId === message.channelId ? '' : ` in <#${channelId}>`;
        if (when.kind === 'date') {
            await this.createDateReminder(
                message,
                guildId,
                channelId,
                when.spec,
                text,
                where
            );
            return;
        }

        const { delayMs } = when;
        try {
            const result = await this.reminderService.create({
                platform: 'discord',
                userId: message.author.id,
                guildId,
                channelId,
                message: text,
                delayMs,
            });
            if (!result.ok) {
                const error = this.failureMessage(result.reason);
                if (error) await this.replyError(message, error);
                else await this.replyUsage(message);
                return;
            }

            const { reminder } = result;
            const sent = await this.replyEmbed(
                message,
                `Set reminder **#${reminder.id}** in ${formatReminderDuration(delayMs)} from now (${formatReminderTime(reminder.dueAt, 'discord')})${where}\n` +
                    `View your reminders with \`${this.hintPrefix}reminders\``,
                EmbedColors.Success
            );
            await this.recordSet(sent, reminder);
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to create the reminder: ${(err as Error).message}`
            );
            logger.error('❌ Creating a Discord reminder failed:', err);
        }
    }

    /**
     * Remembers a "Reminder set" reply so that replying to it with
     * `remindme snooze <time>` sets the same reminder again (issue #58).
     */
    private async recordSet(sent: Message, reminder: Reminder): Promise<void> {
        await this.reminderService.recordMessage({
            platform: 'discord',
            messageId: sent.id,
            kind: 'set',
            userId: reminder.userId,
            guildId: reminder.guildId,
            channelId: reminder.channelId,
            message: reminder.message,
        });
    }

    /**
     * `remindme snooze|again <time>` (issue #58): sets the reminder the
     * command replies to (its "Reminder set" reply or the delivered
     * reminder) again at the new time, in the same channel and with the same
     * text. Without such a reply, the user's last delivered reminder in this
     * server is used.
     */
    private async snooze(
        message: DiscordCommandHandlerMessage,
        guildId: string,
        args: Extract<SnoozeArgs, { snooze: true }>
    ): Promise<void> {
        if (!args.ok) {
            switch (args.reason) {
                case 'invalid_time':
                    await this.replyUsage(message, INVALID_DURATION_MESSAGE);
                    return;
                case 'unexpected_text':
                    await this.replyUsage(message, SNOOZE_ONLY_TIME_MESSAGE);
                    return;
                default:
                    await this.replyUsage(message);
                    return;
            }
        }

        let source: ReminderMessage | null;
        try {
            source = await this.findSnoozeSource(message, guildId);
        } catch (err: unknown) {
            logger.error(
                '❌ Looking up a Discord reminder to snooze failed:',
                err
            );
            await this.replyError(
                message,
                `Failed to find the reminder to snooze: ${(err as Error).message}`
            );
            return;
        }
        if (source === null) {
            await this.replyError(
                message,
                nothingToSnoozeMessage(this.hintPrefix)
            );
            return;
        }
        if (source.userId !== message.author.id) {
            await this.replyError(message, NOT_YOUR_REMINDER_MESSAGE);
            return;
        }

        logger.info(
            `😴 Discord reminder snoozed by ${message.author.id} (from ${source.kind} message ${source.messageId})`
        );
        await this.schedule(
            message,
            source.guildId,
            source.channelId,
            args.when,
            source.message
        );
    }

    /**
     * The reminder message the command replies to, when it is one; else the
     * user's last delivered reminder in this server (issue #58).
     */
    private async findSnoozeSource(
        message: DiscordCommandHandlerMessage,
        guildId: string
    ): Promise<ReminderMessage | null> {
        const repliedId = message.reference?.messageId;
        if (repliedId) {
            const replied = await this.reminderService.findMessage(
                'discord',
                repliedId
            );
            if (replied) return replied;
        }
        return this.reminderService.lastDelivered(
            'discord',
            message.author.id,
            guildId
        );
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
            const sent = await this.replyEmbed(
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
            await this.recordSet(sent, result.reminder);
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to create the reminder: ${(err as Error).message}`
            );
            logger.error('❌ Creating a Discord date reminder failed:', err);
        }
    }
}
