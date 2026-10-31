import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { MusicController } from '../../../services/music/types';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';
import { MUSIC_DISABLED_MESSAGE, runMusicCommand } from '../../musicCommon';

/**
 * `music <url | search words> | skip | stop | pause | resume | queue`
 * (also `play` / `p`): a music bot for the voice channel the user is in.
 */
export default class MusicFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly getMusic: () => MusicController | null
    ) {
        super(client);
    }

    private async reply(message: Message, description: string, color: number) {
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

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId) {
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

        const { text, error } = await runMusicCommand({
            music,
            platform: 'fluxer',
            guildId: message.guildId,
            userId: message.author.id,
            requesterName:
                message.member?.displayName ??
                (message.author as { displayName?: string }).displayName ??
                message.author.username,
            args,
            announce: (content) => {
                message.send({ content }).catch((err: unknown) => {
                    logger.error('[Music] ❌ Failed to announce:', err);
                });
            },
        });
        await this.reply(
            message,
            text,
            error ? EmbedColors.Error : EmbedColors.Success
        );
    }
}
