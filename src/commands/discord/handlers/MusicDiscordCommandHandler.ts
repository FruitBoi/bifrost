import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { MusicController } from '../../../services/music/types';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';
import { MUSIC_DISABLED_MESSAGE, runMusicCommand } from '../../musicCommon';

/**
 * `music <url | search words> | skip | stop | pause | resume | queue`
 * (also `play` / `p`): a music bot for the voice channel the user is in.
 */
export default class MusicDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly getMusic: () => MusicController | null
    ) {
        super(client);
    }

    private async reply(
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
            allowedMentions: { parse: [] },
        });
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.reply(
                message,
                'This command can only be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        const music = this.getMusic();
        if (!music) {
            await this.reply(
                message,
                MUSIC_DISABLED_MESSAGE,
                EmbedColors.Error
            );
            return;
        }

        const channel = message.channel;
        const { text, error } = await runMusicCommand({
            music,
            platform: 'discord',
            guildId: message.guildId,
            userId: message.author.id,
            requesterName:
                message.member?.displayName ??
                message.author.displayName ??
                message.author.username,
            args,
            announce: (content) => {
                if (!channel.isSendable()) return;
                channel
                    .send({ content, allowedMentions: { parse: [] } })
                    .catch((err: unknown) =>
                        logger.error('[Music] ❌ Failed to announce:', err)
                    );
            },
            onSearching: () => {
                if (channel.isSendable()) {
                    channel.sendTyping().catch(() => undefined);
                }
            },
        });
        await this.reply(
            message,
            text,
            error ? EmbedColors.Error : EmbedColors.Success
        );
    }
}
