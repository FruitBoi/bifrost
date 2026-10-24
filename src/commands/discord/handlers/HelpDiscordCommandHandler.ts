import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getCommandHelp, getHelpPages } from '../../../commands/commandList';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';

export default class HelpDiscordCommandHandler extends DiscordCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
        if (args.length > 0) {
            await this.replyCommandHelp(message, args.join(' '));
            return;
        }
        const pages = getHelpPages('discord');
        const embeds = pages.map((page, i) =>
            new EmbedBuilder()
                .setTitle(i === 0 ? 'Bifröst Help' : 'Bifröst Help (continued)')
                .setDescription(page)
                .setColor(EmbedColors.Info)
        );
        embeds[embeds.length - 1]
            .setFooter(this.footer(message))
            .setTimestamp();
        await this.replyEmbeds(message, embeds);
    }

    private async replyCommandHelp(
        message: DiscordCommandHandlerMessage,
        query: string
    ): Promise<void> {
        const help = getCommandHelp(query, 'discord');
        const embed = help
            ? new EmbedBuilder()
                  .setTitle(help.title)
                  .setDescription(help.description)
                  .setColor(EmbedColors.Info)
            : new EmbedBuilder()
                  .setDescription(
                      `Command \`${query.replace(/`/g, '')}\` not found. Use \`${COMMAND_PREFIX}help\` to see available commands.`
                  )
                  .setColor(EmbedColors.Error);
        embed.setFooter(this.footer(message)).setTimestamp();
        await this.replyEmbeds(message, [embed]);
    }
}
