import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { parseLfgCommand, runLfgAction } from '../../lfgCommand';
import ThreadDirectoryService from '../../../services/threadDirectory/ThreadDirectoryService';
import { COMMAND_PREFIX } from '../../../utils/env';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';

/**
 * `lfg [role]`: lists the LFG roles linked to threads directory entries, or
 * gives (or removes) one of them to the author. Open to everyone.
 */
export default class LfgFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly threadDirectoryService: ThreadDirectoryService
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);
        const embed = (description: string, color: number) =>
            new EmbedBuilder()
                .setDescription(description)
                .setColor(color)
                .setFooter(footer)
                .setTimestamp();

        if (!message.guildId) {
            await message.reply({
                embeds: [
                    embed(
                        'This command must be used in a server.',
                        EmbedColors.Error
                    ),
                ],
            });
            return;
        }
        if (message.author.bot) {
            await message.reply({
                embeds: [
                    embed('Bots cannot use this command.', EmbedColors.Error),
                ],
            });
            return;
        }

        const action = parseLfgCommand({
            content: message.content,
            prefix: COMMAND_PREFIX,
            args,
        });
        const result = await runLfgAction(
            this.threadDirectoryService,
            'fluxer',
            message.guildId,
            message.author.id,
            action
        );
        if (!('list' in result)) {
            await message.reply({
                embeds: [embed(result.description, result.color)],
            });
            return;
        }

        const embeds = [embed(result.header, EmbedColors.Info)];
        for (const chunk of chunkDescriptionLines(result.lines, '\n')) {
            embeds.push(embed(chunk.join('\n'), EmbedColors.Info));
        }
        await this.replyEmbeds(message, embeds);
    }
}
