import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { LinkService } from '../../../services/LinkService';
import RoleIconTransferService from '../../../services/roleIconTransfer/RoleIconTransferService';
import {
    describeRoleIconPlan,
    formatRoleIconTransferReport,
    parseRoleIconsArgs,
} from '../../../services/roleIconTransfer/roleIconsCommand';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `roleicons [overwrite]` (aliases `roleemotes`, `roleemojis`): copies the
 * icons of this Discord server's roles onto the Fluxer roles with the same
 * name in the linked Fluxer server (issue #54). Fluxer roles that already
 * have an icon are skipped unless `overwrite` is given. Requires the Discord
 * `Manage Roles` permission. The transfer itself lives in
 * `RoleIconTransferService`; this handler adapts the Discord message API and
 * renders the report.
 */
export default class RoleIconsDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly roleIconTransferService: RoleIconTransferService
    ) {
        super(client);
    }

    private embed(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): EmbedBuilder {
        return new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setFooter(this.footer(message))
            .setTimestamp();
    }

    private async reply(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** An error embed followed by the command usage, in one reply. */
    private async replyUsage(
        message: DiscordCommandHandlerMessage,
        error: string
    ): Promise<void> {
        const usage = getDiscordCommandUsage('roleicons');
        await message.reply({
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot) {
            await this.reply(
                message,
                'Bots cannot use this command.',
                EmbedColors.Error
            );
            return;
        }
        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageRoles,
                'Manage Roles'
            ))
        ) {
            return;
        }

        const parsed = parseRoleIconsArgs(args);
        if (!parsed.ok) {
            await this.replyUsage(
                message,
                `Unknown argument \`${args.join(' ')}\`: give \`overwrite\` to replace existing icons, or nothing to skip roles that already have one.`
            );
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(message.guild.id)
            .catch(() => null);
        if (!guildLink) {
            await this.reply(
                message,
                'This server is not linked to a Fluxer server.',
                EmbedColors.Error
            );
            return;
        }

        try {
            const report = await this.roleIconTransferService.transfer(
                guildLink.discordGuildId,
                guildLink.fluxerGuildId,
                {
                    overwrite: parsed.overwrite,
                    onPlanned: async (plan) => {
                        const notice = describeRoleIconPlan(plan);
                        if (!notice) return;
                        // A failed notice must not abort the transfer.
                        await this.reply(
                            message,
                            notice,
                            EmbedColors.Info
                        ).catch((err: unknown) => {
                            logger.warn(
                                '⚠️ Could not post the role icon transfer notice on Discord:',
                                err
                            );
                        });
                    },
                }
            );
            const { title, description, color } =
                formatRoleIconTransferReport(report);
            await message.reply({
                embeds: [
                    this.embed(message, description, color).setTitle(title),
                ],
            });
        } catch (err: unknown) {
            logger.error('❌ Role icon transfer failed on Discord:', err);
            await this.reply(
                message,
                (err as Error).message,
                EmbedColors.Error
            );
        }
    }
}
