import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import {
    parseDirectoryCommand,
    runDirectoryAction,
} from '../../directoryCommand';
import ThreadDirectoryService from '../../../services/threadDirectory/ThreadDirectoryService';
import { COMMAND_PREFIX } from '../../../utils/env';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';

/**
 * `directory ...`: posts and maintains the threads directory message of the
 * current channel (or of the parent channel when run inside a thread).
 */
export default class DirectoryDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly threadDirectoryService: ThreadDirectoryService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
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

        if (!message.inGuild()) {
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

        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageChannels,
                'Manage Channels'
            ))
        )
            return;

        const inThread = message.channel.isThread();
        const channelId =
            (inThread ? message.channel.parentId : null) ?? message.channelId;
        const action = parseDirectoryCommand({
            content: message.content,
            prefix: COMMAND_PREFIX,
            args,
            currentThreadId: inThread ? message.channelId : null,
        });
        if (action.kind === 'usage') {
            await message.reply(getDiscordCommandUsage('directory'));
            return;
        }

        const result = await runDirectoryAction(
            this.threadDirectoryService,
            'discord',
            message.guildId,
            channelId,
            action
        );
        if (!('status' in result)) {
            await message.reply({
                embeds: [embed(result.description, result.color)],
            });
            return;
        }

        const embeds = [embed(result.header, EmbedColors.Info)];
        if (result.lines.length === 0) {
            embeds[0].setDescription(`${result.header}\n\nNo threads yet.`);
        }
        for (const chunk of chunkDescriptionLines(result.lines, '\n')) {
            embeds.push(embed(chunk.join('\n'), EmbedColors.Info));
        }
        await this.replyEmbeds(message, embeds);
    }
}
