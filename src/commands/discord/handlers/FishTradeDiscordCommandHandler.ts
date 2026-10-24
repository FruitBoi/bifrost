import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import {
    buildFishTradeSummary,
    parseFishTradeArgs,
    simulateFishTradingDay,
} from '../../../services/fishTrading/fishTrading';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

const USAGE = '`fishtrade [fish name] [-seed <n>] [-cash <amount>]`';

const COLORS = {
    success: EmbedColors.Success,
    error: EmbedColors.Error,
    info: EmbedColors.Info,
} as const;

/**
 * `fishtrade` (issue #34): simulates one trading day of the user's fish
 * day-trading a made-up fish ticker with a trend-following algorithm. Purely
 * simulated; open to everyone.
 */
export default class FishTradeDiscordCommandHandler extends DiscordCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    private async replyError(
        message: DiscordCommandHandlerMessage,
        description: string
    ) {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (message.author.bot) {
            await this.replyError(message, 'Bots cannot use this command.');
            return;
        }

        try {
            const parsed = parseFishTradeArgs(args);
            if (!parsed.ok) {
                await this.replyError(
                    message,
                    `${parsed.error}\nUsage: ${USAGE}`
                );
                return;
            }
            const summary = buildFishTradeSummary(
                simulateFishTradingDay(parsed.options)
            );
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(summary.title)
                        .setDescription(summary.description)
                        .addFields(summary.fields)
                        .setColor(COLORS[summary.color])
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
            });
        } catch (err: unknown) {
            logger.error('❌ Fish trading simulation failed:', err);
            await this.replyError(
                message,
                `The fish tripped over the keyboard: ${(err as Error).message}`
            );
        }
    }
}
