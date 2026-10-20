import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import { isChannelPairLink } from '../../../db/entities/ChannelLink';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/**
 * `threads [on|off]`: shows or sets automatic thread bridging for the channel
 * link of the current channel (or of the parent channel when run in a thread).
 */
export default class ThreadsFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (!message.guildId) {
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
                PermissionsBitField.Flags.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        const arg = args[0]?.toLowerCase();
        if (arg !== undefined && arg !== 'on' && arg !== 'off') {
            await message.reply(getFluxerCommandUsage('threads'));
            return;
        }

        // Resolve the link of this channel, or of the parent channel when
        // run inside a thread.
        let channelLink = await this.linkService
            .getChannelLinkByFluxerLocation(message.channelId)
            .catch(() => null);
        if (!channelLink || !isChannelPairLink(channelLink)) {
            const channel =
                message.channel ??
                (await message.resolveChannel().catch(() => null));
            if (channel?.isThread() && channel.parentId) {
                const parentLink = await this.linkService
                    .getChannelLinkByFluxerLocation(channel.parentId)
                    .catch(() => null);
                if (parentLink) channelLink = parentLink;
            }
        }
        if (!channelLink) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This channel is not linked. Link it first with \`${COMMAND_PREFIX}link <discord-channel-id>\`.`
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
                            'Automatic thread bridging only applies to channel ↔ channel links. ' +
                                'Run this command in a linked channel (or in a thread whose parent channel is linked).'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (arg === undefined) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Automatic thread bridging for <#${channelLink.fluxerChannelId}> is currently **${channelLink.autoSyncThreads ? 'on' : 'off'}**.\n` +
                                `Use \`${COMMAND_PREFIX}threads on\` or \`${COMMAND_PREFIX}threads off\` to change it.`
                        )
                        .setColor(EmbedColors.Info)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const enabled = arg === 'on';
        try {
            await this.linkService.setChannelAutoSyncThreads(
                channelLink.id,
                enabled
            );
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            enabled
                                ? `New threads in <#${channelLink.fluxerChannelId}> will now be bridged to Discord automatically.`
                                : `New threads in <#${channelLink.fluxerChannelId}> will no longer be bridged automatically. Existing thread links are kept; use \`${COMMAND_PREFIX}link <discord-thread-id>\` inside a thread to bridge one manually.`
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
