import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import LinkProvisioner, {
    ResolvedLinkTarget,
} from '../../../services/LinkProvisioner';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/** Human-readable label for a resolved link target. */
export function describeTarget(target: ResolvedLinkTarget): string {
    if (target.kind === 'thread') {
        const parent = target.parentName ? `#${target.parentName}` : 'thread';
        return `🧵 ${parent} › ${target.name}`;
    }
    return `#${target.name}`;
}

export default class LinkFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner,
        private readonly discordEntityResolver: DiscordEntityResolver
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

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        // Legacy confirm step: links are now created immediately.
        if (args[0]?.toLowerCase() === 'confirm') {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Confirmation is no longer needed. Run \`${COMMAND_PREFIX}link <id>\` directly to create the link.`
                        )
                        .setColor(EmbedColors.Info)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const id = args[0];
        if (!id) {
            await this.replyError(
                message,
                `Usage: \`${COMMAND_PREFIX}link <id>\`\n` +
                    `> Provide a Discord guild ID to bridge servers, or a Discord channel or thread ID to bridge it with the channel or thread you are in.\n` +
                    `> The link is created immediately.`
            );
            return;
        }

        // 1. Try Discord guild
        const discordGuild = await this.discordEntityResolver
            .fetchGuild(id)
            .catch(() => null);
        if (discordGuild) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionsBitField.Flags.ManageGuild,
                    'Manage Guild'
                ))
            )
                return;
            try {
                await this.linkService.createGuildLink(id, message.guildId!);
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `This Fluxer server is now bridged with Discord guild **${discordGuild.name}**.\n` +
                                    `Use \`${COMMAND_PREFIX}link <discord-channel-or-thread-id>\` in any channel or thread to start linking.`
                            )
                            .setColor(EmbedColors.Success)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
            } catch (err: unknown) {
                await this.replyError(
                    message,
                    `Failed to link guild: ${(err as Error).message}`
                );
                logger.error('❌ Link guild failed:', err);
            }
            return;
        }

        // 2. Try Discord channel or thread (requires existing guild link)
        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId!)
            .catch(() => null);
        if (!guildLink) {
            await this.replyError(
                message,
                `Could not find a Discord guild with ID \`${id}\`. (Link a Discord guild first with \`${COMMAND_PREFIX}link <discord-guild-id>\`)`
            );
            return;
        }

        const discord = await this.linkProvisioner
            .resolveDiscordTarget(guildLink.discordGuildId, id)
            .catch(() => null);
        if (!discord) {
            await this.replyError(
                message,
                `Could not find a Discord guild, text channel or thread with ID \`${id}\` in the linked Discord server.`
            );
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

        const fluxer = await this.linkProvisioner
            .resolveFluxerTarget(message.guildId!, message.channelId)
            .catch(() => null);
        if (!fluxer) {
            await this.replyError(
                message,
                'This command must be run inside a text channel or a thread of one.'
            );
            return;
        }

        if (await this.linkService.getChannelLinkByDiscordLocation(id)) {
            await this.replyError(
                message,
                `${describeTarget(discord)} on Discord is already linked. Use \`${COMMAND_PREFIX}list\` to see active links.`
            );
            return;
        }
        if (
            await this.linkService.getChannelLinkByFluxerLocation(
                message.channelId
            )
        ) {
            await this.replyError(
                message,
                `${describeTarget(fluxer)} is already linked. Use \`${COMMAND_PREFIX}unlink <id>\` first.`
            );
            return;
        }

        try {
            await this.linkProvisioner.createLink({
                guildLink,
                discord,
                fluxer,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Linked **${describeTarget(fluxer)}** ↔ **${describeTarget(discord)}** on Discord successfully.`
                        )
                        .setColor(EmbedColors.Success)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to link: ${(err as Error).message}`
            );
            logger.error('❌ Link failed:', err);
        }
    }
}
