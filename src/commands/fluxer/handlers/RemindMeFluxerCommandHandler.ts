import {
    Channel,
    Client,
    EmbedBuilder,
    GuildMember,
    Message,
    PermissionFlags,
    PermissionsBitField,
    TextChannel,
} from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { stripReminderInvocation } from '../../reminderTrigger';
import ReminderService from '../../../services/reminders/ReminderService';
import ReminderTimezoneService from '../../../services/reminders/ReminderTimezoneService';
import { ReminderDateSpec } from '../../../services/reminders/reminderDate';
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
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * The prefix shown in reminder hints: the first short trigger when one is
 * configured (`?reminders`), otherwise the bot prefix (`!b reminders`).
 */
export function reminderHintPrefix(triggerPrefixes: readonly string[]): string {
    return triggerPrefixes[0] ?? COMMAND_PREFIX;
}

/** True for channels a reminder can be posted into: text channels and threads. */
export function isReminderTargetChannel(channel: Channel): boolean {
    return channel instanceof TextChannel || channel.isThread();
}

/**
 * The member's effective permissions in `channel` (roles + overwrites), or
 * the guild-level permissions when the channel is not a guild channel or the
 * overwrite computation fails (e.g. uncached roles).
 */
export function memberPermissionsIn(
    member: GuildMember,
    channel: Channel | null
): PermissionsBitField {
    if (channel?.isGuild()) {
        try {
            return member.permissionsIn(channel);
        } catch (err) {
            logger.warn(
                `⚠️ Could not compute Fluxer permissions of ${member.id} in channel ${channel.id}, using guild-level permissions:`,
                err
            );
        }
    }
    return member.permissions;
}

/**
 * `remindme <time> <message>` (alias `remind`), optionally with
 * `-channel <#channel>`: schedules a reminder that pings the author in the
 * channel when the time is up (issue #9, modelled on YAGPDB). Besides
 * `!b remindme ...` the command is triggered by the configured short
 * prefixes (`?remindme ...`, `!remindme ...`). The time may also be a date
 * or time of day (`Oct 26 20:15`, `Monday 7pm`, `tomorrow`; issue #27),
 * read in the user's time zone; without one the reminder waits while the
 * user is asked to set it with `timezone`.
 */
export default class RemindMeFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly reminderService: ReminderService,
        private readonly timezoneService: ReminderTimezoneService,
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

    /** An error line followed by the command usage, in one reply. */
    private async replyUsage(message: Message, error?: string): Promise<void> {
        const usage = getFluxerCommandUsage('remindme');
        const embeds = [...(usage.embeds ?? [])];
        if (error) {
            embeds.unshift(
                new EmbedBuilder()
                    .setDescription(error)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp()
            );
        }
        await message.reply({ ...usage, embeds });
    }

    private failureMessage(
        reason: Parameters<typeof reminderFailureMessage>[0]
    ): string | null {
        return reminderFailureMessage(
            reason,
            reminderHintPrefix(this.triggerPrefixes)
        );
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
                'Cannot create reminders for bots.',
                EmbedColors.Error
            );
            return;
        }

        // Read the arguments from the raw content so the reminder message
        // keeps its whitespace and newlines; fall back to the split args.
        const raw =
            stripReminderInvocation(message.content, [
                COMMAND_PREFIX,
                ...this.triggerPrefixes,
            ]) ?? args.join(' ');
        const parsed = parseRemindMeArgs(raw);
        if (!parsed.ok) {
            switch (parsed.reason) {
                case 'invalid_time':
                    await this.replyUsage(message, INVALID_TIME_MESSAGE);
                    return;
                case 'missing_channel':
                    await this.replyUsage(
                        message,
                        'Please mention a channel or give its ID after `-channel`.'
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
                await this.reply(
                    message,
                    'Please mention a channel or give its ID.',
                    EmbedColors.Error
                );
                return;
            }

            const guild =
                message.guild ??
                (await message.resolveGuild().catch(() => null));
            if (!guild) {
                await this.reply(
                    message,
                    'Could not resolve this server.',
                    EmbedColors.Error
                );
                return;
            }

            const channel = await this.fluxerEntityResolver.fetchChannel(
                guild,
                targetId
            );
            if (!channel || !isReminderTargetChannel(channel)) {
                await this.reply(
                    message,
                    channel
                        ? 'Reminders can only be set in text channels and threads.'
                        : 'Channel not found in this server.',
                    EmbedColors.Error
                );
                return;
            }

            const member = await guild
                .fetchMember(message.author.id)
                .catch(() => null);
            if (!member) {
                await this.reply(
                    message,
                    'Could not fetch your member information.',
                    EmbedColors.Error
                );
                return;
            }
            const permissions = memberPermissionsIn(member, channel);
            if (
                !permissions.has(PermissionFlags.ViewChannel) ||
                !permissions.has(PermissionFlags.SendMessages)
            ) {
                await this.reply(
                    message,
                    `You need View Channel and Send Messages in <#${channel.id}> to set a reminder there.`,
                    EmbedColors.Error
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
        let result;
        try {
            result = await this.reminderService.create({
                platform: 'fluxer',
                userId: message.author.id,
                guildId: message.guildId,
                channelId,
                message: parsed.message,
                delayMs,
            });
        } catch (err) {
            logger.error(
                `❌ Could not create Fluxer reminder for user ${message.author.id}:`,
                err
            );
            await this.reply(
                message,
                `Could not create the reminder: ${(err as Error).message}`,
                EmbedColors.Error
            );
            return;
        }

        if (!result.ok) {
            const description = this.failureMessage(result.reason);
            if (description === null) {
                await this.replyUsage(message);
            } else {
                await this.reply(message, description, EmbedColors.Error);
            }
            return;
        }

        const { reminder } = result;
        const p = reminderHintPrefix(this.triggerPrefixes);
        logger.info(
            `⏰ Fluxer reminder #${reminder.id} set by ${message.author.id} in channel ${channelId} for ${reminder.dueAt.toISOString()}`
        );
        await this.reply(
            message,
            `Reminder **#${reminder.id}** set for ${formatReminderDuration(delayMs)} from now (${formatReminderTime(reminder.dueAt, 'fluxer')})${where}\nView your reminders with \`${p}reminders\``,
            EmbedColors.Success
        );
    }

    /**
     * A date/time reminder (issue #27): resolved in the user's stored zone,
     * or parked in the timezone service while the user is asked for one.
     */
    private async createDateReminder(
        message: Message,
        guildId: string,
        channelId: string,
        spec: ReminderDateSpec,
        text: string,
        where: string
    ): Promise<void> {
        const userId = message.author.id;
        const p = reminderHintPrefix(this.triggerPrefixes);
        try {
            const zone = await this.timezoneService.getTimeZone(
                'fluxer',
                userId
            );
            if (zone === null) {
                this.timezoneService.setPending('fluxer', userId, {
                    guildId,
                    channelId,
                    originChannelId: message.channelId,
                    spec,
                    message: text,
                });
                logger.info(
                    `🕰️ Fluxer date reminder by ${userId} waits for their time zone`
                );
                await this.reply(
                    message,
                    timezonePromptMessage(p),
                    EmbedColors.Info
                );
                return;
            }

            const result = await this.timezoneService.createDateReminder(
                'fluxer',
                userId,
                { guildId, channelId, spec, message: text },
                zone
            );
            if (!result.ok) {
                const error = this.failureMessage(result.reason);
                if (result.reason === 'invalid_date' || error === null) {
                    await this.replyUsage(message, error ?? undefined);
                } else {
                    await this.reply(message, error, EmbedColors.Error);
                }
                return;
            }
            logger.info(
                `⏰ Fluxer reminder #${result.reminder.id} set by ${userId} in channel ${channelId} for ${result.reminder.dueAt.toISOString()} (${zone})`
            );
            await this.reply(
                message,
                dateReminderConfirmation(
                    'fluxer',
                    result.reminder,
                    result.delayMs,
                    zone,
                    where,
                    p
                ),
                EmbedColors.Success
            );
        } catch (err) {
            logger.error(
                `❌ Could not create Fluxer date reminder for user ${userId}:`,
                err
            );
            await this.reply(
                message,
                `Could not create the reminder: ${(err as Error).message}`,
                EmbedColors.Error
            );
        }
    }
}
