import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { stripReminderInvocation } from '../../reminderTrigger';
import { runTimezoneCommand } from '../../timezoneCommand';
import ReminderTimezoneService from '../../../services/reminders/ReminderTimezoneService';
import { reminderHintPrefix } from './RemindMeFluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `timezone [zone | clear]` (alias `tz`): shows, sets or removes the time
 * zone that date/time reminders (`remindme Monday 7pm`) are read in, and
 * sets the reminder that was waiting for it (issue #27). Reachable with the
 * bot prefix and the short reminder triggers (`?timezone Europe/London`).
 */
export default class TimezoneFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly timezoneService: ReminderTimezoneService,
        private readonly triggerPrefixes: readonly string[]
    ) {
        super(client);
    }

    private embed(
        message: Message,
        description: string,
        color: number
    ): EmbedBuilder {
        return new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setFooter(this.footer(message))
            .setTimestamp();
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (message.author.bot) {
            await message.reply({
                embeds: [
                    this.embed(
                        message,
                        'Bots cannot set a time zone.',
                        EmbedColors.Error
                    ),
                ],
            });
            return;
        }

        const raw =
            stripReminderInvocation(message.content, [
                COMMAND_PREFIX,
                ...this.triggerPrefixes,
            ]) ?? args.join(' ');
        try {
            const parts = await runTimezoneCommand(
                this.timezoneService,
                'fluxer',
                message.author.id,
                raw,
                message.channelId,
                reminderHintPrefix(this.triggerPrefixes)
            );
            await message.reply({
                embeds: parts.map((part) =>
                    this.embed(message, part.description, part.color)
                ),
            });
        } catch (err) {
            logger.error(
                `❌ Fluxer timezone command failed for user ${message.author.id}:`,
                err
            );
            await message.reply({
                embeds: [
                    this.embed(
                        message,
                        `Could not update your time zone: ${(err as Error).message}`,
                        EmbedColors.Error
                    ),
                ],
            });
        }
    }
}
