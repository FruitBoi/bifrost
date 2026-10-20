import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import LinkProvisioner from '../../../services/LinkProvisioner';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../../../db/entities/ChannelLink';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingUnlink =
    | { type: 'guild'; fluxerGuildId: string }
    | { type: 'link'; link: ChannelLink };

export default class UnlinkDiscordCommandHandler extends DiscordCommandHandler {
    private pending = new Map<
        string,
        { action: PendingUnlink; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingUnlink) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingUnlink | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
    }

    private async replyError(
        message: DiscordCommandHandlerMessage,
        description: string
    ) {
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
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        // Confirm flow
        if (args[0]?.toLowerCase() === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await this.replyError(
                    message,
                    `No pending unlink action. Run \`${COMMAND_PREFIX}unlink <id>\` first.`
                );
                return;
            }

            if (pending.type === 'guild') {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageGuild,
                        'Manage Guild'
                    ))
                )
                    return;
                try {
                    const guildLink =
                        await this.linkService.getGuildLinkForDiscordGuild(
                            message.guildId!
                        );
                    if (!guildLink) {
                        throw new Error('Guild not linked');
                    }
                    await this.linkProvisioner.removeGuildLink(guildLink);
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Server bridge removed. All channel and thread links have been deleted.`
                                )
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await this.replyError(
                        message,
                        `Failed to unlink guild: ${(err as Error).message}`
                    );
                    logger.error('Unlink guild failed:', err);
                }
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
            try {
                const link = await this.linkService.getChannelLinkById(
                    pending.link.id
                );
                if (!link) {
                    throw new Error('Link not found');
                }
                await this.linkProvisioner.removeLink(link);
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`Bridge removed.`)
                            .setColor(EmbedColors.Success)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
            } catch (err: unknown) {
                await this.replyError(
                    message,
                    `Failed to unlink: ${(err as Error).message}`
                );
                logger.error('Unlink failed:', err);
            }
            return;
        }

        // Detection phase
        const id = args[0];
        if (!id) {
            await this.replyError(
                message,
                `Usage: \`${COMMAND_PREFIX}unlink <id>\`\n` +
                    `> Provide the Fluxer guild ID to unbridge servers, or a Fluxer channel or thread ID to remove that link.\n` +
                    `> Then run \`${COMMAND_PREFIX}unlink confirm\` to proceed.\n` +
                    `> Use \`${COMMAND_PREFIX}list\` to see active links and their IDs.`
            );
            return;
        }

        // 1. Check if ID matches a guild link by Fluxer guild ID
        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(id)
            .catch(() => null);
        if (guildLink) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageGuild,
                    'Manage Guild'
                ))
            )
                return;
            this.setPending(message.author.id, {
                type: 'guild',
                fluxerGuildId: id,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the bridge between this Discord server and Fluxer guild \`${id}\`, ` +
                                `including **all** channel and thread links.\n` +
                                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 2. Check if ID matches a link by Fluxer channel or thread ID
        const link = await this.linkService
            .getChannelLinkByFluxerLocation(id)
            .catch(() => null);
        if (link) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageWebhooks,
                    'Manage Webhooks'
                ))
            )
                return;
            this.setPending(message.author.id, { type: 'link', link });
            const fluxerKind = link.fluxerThreadId ? 'thread' : 'channel';
            const discordPrefix = link.discordThreadId ? '🧵 ' : '';
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This will remove the bridge for Fluxer ${fluxerKind} \`${fluxerLocationId(link)}\` ↔ ${discordPrefix}<#${discordLocationId(link)}>.\n` +
                                `Nothing is deleted on either platform; they just stop mirroring each other.\n` +
                                `Run \`${COMMAND_PREFIX}unlink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        await this.replyError(
            message,
            `No active link found for ID \`${id}\`.\n` +
                `Use \`${COMMAND_PREFIX}list\` to see active links.`
        );
    }
}
