import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import MessageCountService from '../../../services/messageCount/MessageCountService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { buildMessageCountFields } from '../../messageCountSummary';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/**
 * `messagecount`: reports how many messages were bridged from each platform
 * for the guild link of the current server. Read-only, open to everyone.
 */
export default class MessageCountFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly messageCountService: MessageCountService
    ) {
        super(client);
    }

    private async replyError(
        message: Message,
        description: string
    ): Promise<void> {
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

    public async handleCommand(message: Message): Promise<void> {
        if (!message.guildId) {
            await this.replyError(
                message,
                'This command only works in a server that is linked to a Discord guild.'
            );
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId)
            .catch(() => null);
        if (!guildLink) {
            await this.replyError(
                message,
                `This server is not linked to a Discord guild. Link one first with \`${COMMAND_PREFIX}link <discord-guild-id>\`.`
            );
            return;
        }

        let counts;
        try {
            counts = await this.messageCountService.getCounts(guildLink.id);
        } catch (err) {
            logger.error('❌ Error reading message counts:', err);
            await this.replyError(
                message,
                'Could not read the message counts right now. Try again later.'
            );
            return;
        }

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Bridged messages')
                    .addFields(...buildMessageCountFields(counts))
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }
}
