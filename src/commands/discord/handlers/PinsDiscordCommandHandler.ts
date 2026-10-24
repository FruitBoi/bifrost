import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import PinBridgeService, {
    PinSyncError,
    PinSyncResult,
} from '../../../services/pinBridge/PinBridgeService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../../commands/commandList';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/** One line per non-zero counter, or a note when nothing had to change. */
export function summarizePinSync(result: PinSyncResult): string {
    const lines: string[] = [];
    if (result.pinnedOnDiscord > 0)
        lines.push(`📌 Pinned on Discord: **${result.pinnedOnDiscord}**`);
    if (result.pinnedOnFluxer > 0)
        lines.push(`📌 Pinned on Fluxer: **${result.pinnedOnFluxer}**`);
    if (result.copiedToDiscord > 0)
        lines.push(`➡️ Copied to Discord: **${result.copiedToDiscord}**`);
    if (result.copiedToFluxer > 0)
        lines.push(`➡️ Copied to Fluxer: **${result.copiedToFluxer}**`);
    if (result.alreadyInSync > 0)
        lines.push(`✅ Already in sync: **${result.alreadyInSync}**`);
    if (result.failed > 0) lines.push(`⚠️ Failed: **${result.failed}**`);
    return lines.length > 0 ? lines.join('\n') : 'Pins were already in sync.';
}

/**
 * `pins sync`: syncs the pinned messages of the current linked channel or
 * thread between Discord and Fluxer. New pins and unpins on bridged messages
 * are synced automatically by the pin bridge.
 */
export default class PinsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly pinBridgeService: PinBridgeService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);
        const reply = (description: string, color: number) =>
            message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(description)
                        .setColor(color)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });

        if (!message.inGuild()) {
            await reply(
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }

        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageMessages,
                'Manage Messages'
            ))
        )
            return;

        if (args.length !== 1 || args[0].toLowerCase() !== 'sync') {
            await message.reply(getDiscordCommandUsage('pins'));
            return;
        }

        // Pins belong to the exact channel or thread, so no parent fallback.
        const channelLink = await this.linkService
            .getChannelLinkByDiscordLocation(message.channelId)
            .catch(() => null);
        if (!channelLink) {
            await reply(
                `This channel is not linked to a Fluxer channel.\n` +
                    `Use \`${COMMAND_PREFIX}link <fluxer-channel-id>\` to link it first.`,
                EmbedColors.Error
            );
            return;
        }

        await reply('Syncing pinned messages…', EmbedColors.Info);
        try {
            const result =
                await this.pinBridgeService.syncPastPins(channelLink);
            await reply(
                summarizePinSync(result),
                result.failed > 0 ? EmbedColors.Warning : EmbedColors.Success
            );
        } catch (err: unknown) {
            if (err instanceof PinSyncError) {
                await reply(
                    err.reason === 'already_running'
                        ? 'A pin sync for this channel is already running.'
                        : err.message,
                    EmbedColors.Error
                );
                return;
            }
            await reply(
                `Failed to sync pinned messages: ${(err as Error).message}`,
                EmbedColors.Error
            );
            logger.error('❌ Pin sync failed:', err);
        }
    }
}
