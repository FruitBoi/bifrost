import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getHelpPages } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class HelpFluxerCommandHandler extends FluxerCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(message: Message): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
        const pages = getHelpPages('fluxer');
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
