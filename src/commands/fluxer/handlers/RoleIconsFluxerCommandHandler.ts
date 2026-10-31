import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
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
 * icons of the roles of the Discord server linked to this Fluxer server onto
 * the roles with the same name in this server (issue #54). Only the
 * Discord → Fluxer direction exists. Roles here that already have an icon
 * are skipped unless `overwrite` is given. Requires the Fluxer `Manage
 * Roles` permission. The transfer itself lives in `RoleIconTransferService`;
 * this handler adapts the Fluxer message API and renders the report.
 */
export default class RoleIconsFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly roleIconTransferService: RoleIconTransferService
    ) {
        super(client);
    }

    private embed(
        message: Message,
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
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** An error embed followed by the command usage, in one reply. */
    private async replyUsage(message: Message, error: string): Promise<void> {
        const usage = getFluxerCommandUsage('roleicons');
        await message.reply({
            ...usage,
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot || message.webhookId) {
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
                PermissionFlags.ManageRoles,
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
            .getGuildLinkForFluxerGuild(message.guildId)
            .catch(() => null);
        if (!guildLink) {
            await this.reply(
                message,
                'This server is not linked to a Discord server.',
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
                                '⚠️ Could not post the role icon transfer notice on Fluxer:',
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
            logger.error('❌ Role icon transfer failed on Fluxer:', err);
            await this.reply(
                message,
                (err as Error).message,
                EmbedColors.Error
            );
        }
    }
}
