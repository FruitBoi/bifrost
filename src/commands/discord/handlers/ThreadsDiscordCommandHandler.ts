import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import { isChannelPairLink } from '../../../db/entities/ChannelLink';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/**
 * `threads [on|off]` — shows or toggles automatic thread bridging for the
 * channel link of the current channel (or of the current thread's parent).
 */
export default class ThreadsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (!message.inGuild()) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            'This command must be used in a server.'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        const arg = args[0]?.toLowerCase();
        if (arg !== undefined && arg !== 'on' && arg !== 'off') {
            await message.reply(getDiscordCommandUsage('threads'));
            return;
        }

        // The toggle lives on the channel↔channel link. From inside a thread
        // (or when the current location's own link is not a channel pair),
        // fall back to the parent channel's link.
        let channelLink = await this.linkService
            .getChannelLinkByDiscordLocation(message.channelId)
            .catch(() => null);
        if (
            (!channelLink || !isChannelPairLink(channelLink)) &&
            message.channel.isThread() &&
            message.channel.parentId
        ) {
            channelLink = await this.linkService
                .getChannelLinkByDiscordLocation(message.channel.parentId)
                .catch(() => null);
        }
        if (!channelLink) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This channel is not linked to a Fluxer channel.\n` +
                                `Use \`${COMMAND_PREFIX}link <fluxer-channel-id>\` to link it first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }
        if (!isChannelPairLink(channelLink)) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Automatic thread bridging only applies to channel ↔ channel links. ` +
                                `This location is linked to a thread, so there is nothing to toggle here.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const channelMention = `<#${channelLink.discordChannelId}>`;

        if (arg === undefined) {
            const state = channelLink.autoSyncThreads
                ? '**enabled**'
                : '**disabled**';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Automatic thread bridging for ${channelMention} is ${state}.\n` +
                                `> Use \`${COMMAND_PREFIX}threads on\` or \`${COMMAND_PREFIX}threads off\` to change it.\n` +
                                `> Threads can always be linked manually with \`${COMMAND_PREFIX}link <fluxer-channel-or-thread-id>\` from inside a thread.`
                        )
                        .setColor(EmbedColors.Info)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const enable = arg === 'on';
        try {
            await this.linkService.setChannelAutoSyncThreads(
                channelLink.id,
                enable
            );
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            enable
                                ? `Automatic thread bridging is now **enabled** for ${channelMention}.\n` +
                                      `New threads created in either linked channel will be mirrored to the other side.`
                                : `Automatic thread bridging is now **disabled** for ${channelMention}.\n` +
                                      `Existing thread links keep working; new threads must be linked manually.`
                        )
                        .setColor(EmbedColors.Success)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
        } catch (err: unknown) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Failed to update thread bridging: ${(err as Error).message}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('❌ Threads toggle failed:', err);
        }
    }
}
