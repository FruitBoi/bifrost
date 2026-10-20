import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import LinkProvisioner, {
    ResolvedLinkTarget,
} from '../../../services/LinkProvisioner';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/** Renders a resolved target: `#name` for channels, `🧵 parent › name` for threads. */
function describeTarget(target: ResolvedLinkTarget): string {
    if (target.kind === 'thread') {
        const parent = target.parentName ? `#${target.parentName}` : 'thread';
        return `🧵 ${parent} › ${target.name}`;
    }
    return `#${target.name}`;
}

export default class LinkDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {
        super(client);
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
                    `> Provide a Fluxer guild ID to bridge servers, or a Fluxer channel or thread ID to link it to the channel or thread you run this in.`
            );
            return;
        }

        // 1. Try Fluxer guild
        const fluxerGuild = await this.fluxerEntityResolver
            .fetchGuild(id)
            .catch(() => null);
        if (fluxerGuild) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageGuild,
                    'Manage Guild'
                ))
            )
                return;
            const guildName = (fluxerGuild as { name?: string }).name ?? id;
            try {
                await this.linkService.createGuildLink(message.guildId!, id);
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `This Discord server is now bridged with Fluxer guild **${guildName}**.\n` +
                                    `Use \`${COMMAND_PREFIX}link <fluxer-channel-or-thread-id>\` in any channel or thread to start linking.`
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
                logger.error('Link guild failed:', err);
            }
            return;
        }

        // 2. Try Fluxer channel or thread (requires existing guild link)
        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(message.guildId!)
            .catch(() => null);
        if (!guildLink) {
            await this.replyError(
                message,
                `Could not find a Fluxer guild with ID \`${id}\`. ` +
                    `(Link a Fluxer guild first with \`${COMMAND_PREFIX}link <fluxer-guild-id>\`)`
            );
            return;
        }

        const fluxer = await this.linkProvisioner
            .resolveFluxerTarget(guildLink.fluxerGuildId, id)
            .catch(() => null);
        if (!fluxer) {
            await this.replyError(
                message,
                `Could not find a Fluxer guild, text channel or thread with ID \`${id}\` in the linked Fluxer guild.`
            );
            return;
        }

        const discord = await this.linkProvisioner
            .resolveDiscordTarget(message.guildId!, message.channelId)
            .catch(() => null);
        if (!discord) {
            await this.replyError(
                message,
                'This command must be run in a text channel or in a thread of a text channel.'
            );
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

        const discordLocation = discord.threadId ?? discord.channelId;
        const fluxerLocation = fluxer.threadId ?? fluxer.channelId;
        if (
            await this.linkService.getChannelLinkByDiscordLocation(
                discordLocation
            )
        ) {
            await this.replyError(
                message,
                `This ${discord.kind} is already linked. Use \`${COMMAND_PREFIX}list\` to see active links.`
            );
            return;
        }
        if (
            await this.linkService.getChannelLinkByFluxerLocation(
                fluxerLocation
            )
        ) {
            await this.replyError(
                message,
                `Fluxer ${fluxer.kind} **${describeTarget(fluxer)}** is already linked. Use \`${COMMAND_PREFIX}list\` to see active links.`
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
                            `Linked **${describeTarget(discord)}** (<#${discordLocation}>) ↔ **${describeTarget(fluxer)}** successfully.`
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
            logger.error('Link failed:', err);
        }
    }
}
