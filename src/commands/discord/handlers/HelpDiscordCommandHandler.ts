import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getHelpPages } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class HelpDiscordCommandHandler extends DiscordCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(message: DiscordCommandHandlerMessage): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlagsBits.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
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
}
