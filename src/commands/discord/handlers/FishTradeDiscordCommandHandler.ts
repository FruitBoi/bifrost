import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import {
    buildFishTradeSummary,
    parseFishTradeArgs,
    runFishTradingDay,
} from '../../../services/fishTrading/fishTrading';
import { MarketDataError } from '../../../services/fishTrading/marketData';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

const USAGE =
    '`fishtrade [fish name] [-ticker <symbol> | $SYMBOL] [-cash <amount>] [-sim] [-seed <n>]`';

const COLORS = {
    success: EmbedColors.Success,
    error: EmbedColors.Error,
    info: EmbedColors.Info,
} as const;

/**
 * `fishtrade` (issue #34): the user's fish day-trades one session with a
 * trend-following algorithm. By default it paper-trades real one-minute
 * prices of a real ticker; `-sim` / `-seed` use the simulated fish exchange.
 * No real orders; open to everyone.
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
                await runFishTradingDay(parsed.options)
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
            if (err instanceof MarketDataError) {
                await this.replyError(message, err.message);
                return;
            }
            logger.error('❌ Fish trading failed:', err);
            await this.replyError(
                message,
                `The fish tripped over the keyboard: ${(err as Error).message}`
            );
        }
    }
}
