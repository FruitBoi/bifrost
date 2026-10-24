import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { stripReminderInvocation } from '../../reminderTrigger';
import { runTimezoneCommand } from '../../timezoneCommand';
import ReminderTimezoneService from '../../../services/reminders/ReminderTimezoneService';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `timezone [zone | clear]` (alias `tz`): shows, sets or removes the time
 * zone that date/time reminders (`remindme Monday 7pm`) are read in, and
 * sets the reminder that was waiting for it (issue #27). Reachable with the
 * bot prefix and the short reminder triggers (`?timezone Europe/London`).
 */
export default class TimezoneDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly timezoneService: ReminderTimezoneService,
        private readonly triggerPrefixes: readonly string[]
    ) {
        super(client);
    }

    /** Prefix shown in hints: the first short trigger, else the bot prefix. */
    private get hintPrefix(): string {
        return this.triggerPrefixes[0] ?? COMMAND_PREFIX;
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

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
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
                'discord',
                message.author.id,
                raw,
                message.channelId,
                this.hintPrefix
            );
            await this.replyEmbeds(
                message,
                parts.map((part) =>
                    this.embed(message, part.description, part.color)
                )
            );
        } catch (err: unknown) {
            logger.error('❌ Discord timezone command failed:', err);
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
