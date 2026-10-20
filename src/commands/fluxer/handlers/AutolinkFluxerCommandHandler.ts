import { ChannelType } from 'discord.js';
import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import LinkProvisioner from '../../../services/LinkProvisioner';
import {
    discordLocationId,
    fluxerLocationId,
} from '../../../db/entities/ChannelLink';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import { matchChannels, ChannelInfo } from '../../../utils/channelMatcher';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';

export default class AutolinkFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner,
        private readonly discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (
            !(await this.requirePermission(
                message,
                PermissionsBitField.Flags.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        const footer = this.footer(message);
        const doConfirm = args[0]?.toLowerCase() === 'confirm';

        let guildLink;
        try {
            guildLink = await this.linkService.getGuildLinkForFluxerGuild(
                message.guildId!
            );
            if (!guildLink)
                throw new Error('this guild is not linked to a Discord guild');
        } catch (error: unknown) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Cannot run autolink: ${(error as Error).message}. Use \`${COMMAND_PREFIX}link <discord-guild-id>\` first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // Get already-linked channel IDs to skip them
        const existingLinks =
            await this.linkService.getChannelLinksForFluxerGuild(
                message.guildId!
            );
        const linkedDiscordIds = new Set(
            existingLinks.map((l) => discordLocationId(l))
        );
        const linkedFluxerIds = new Set(
            existingLinks.map((l) => fluxerLocationId(l))
        );

        // Fetch all Fluxer text channels in this guild
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const fluxerGuild: any =
            message.guild ?? (await message.resolveGuild());
        const allFluxerChannels: any[] =
            (await fluxerGuild?.fetchChannels()) ?? [];
        const fluxerTextChannels: ChannelInfo[] = allFluxerChannels
            .filter(
                (ch: any) => ch.isTextBased() && !linkedFluxerIds.has(ch.id)
            )
            .map((ch: any) => ({ id: ch.id, name: ch.name as string }));
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Fetch all Discord text channels in the linked Discord guild
        const discordGuild = await this.discordEntityResolver.fetchGuild(
            guildLink.discordGuildId
        );
        if (!discordGuild) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            'Could not fetch the linked Discord guild.'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }
        const allDiscordChannels = await discordGuild.channels.fetch();
        const discordTextChannels: ChannelInfo[] = [];
        for (const [, ch] of allDiscordChannels) {
            if (
                ch &&
                ch.type === ChannelType.GuildText &&
                !linkedDiscordIds.has(ch.id)
            ) {
                discordTextChannels.push({ id: ch.id, name: ch.name });
            }
        }

        const proposals = matchChannels(
            discordTextChannels,
            fluxerTextChannels
        );

        if (proposals.length === 0) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `No confident channel name matches found among **${discordTextChannels.length}** unlinked Discord` +
                                ` and **${fluxerTextChannels.length}** unlinked Fluxer text channels.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (!doConfirm) {
            const lines = proposals.map(
                (p) =>
                    `> \`#${p.discord.name}\` ↔ \`#${p.fluxer.name}\` (${Math.round(p.score * 100)}% match)`
            );
            const unmatchedDiscord =
                discordTextChannels.length - proposals.length;
            const unmatchedFluxer =
                fluxerTextChannels.length - proposals.length;
            const unmatchedTotal = unmatchedDiscord + unmatchedFluxer;

            const headerLine = `${proposals.length} proposal${proposals.length !== 1 ? 's' : ''} found`;
            const footerLines = [
                unmatchedTotal > 0
                    ? `${unmatchedTotal} channel${unmatchedTotal !== 1 ? 's' : ''} had no confident match.`
                    : 'All unlinked channels were matched.',
                `Run \`${COMMAND_PREFIX}autolink confirm\` to link all proposals.`,
            ];
            const chunks = chunkDescriptionLines(lines, '\n');
            const embeds = chunks.map((chunk, i) => {
                const parts: string[] = [];
                if (i === 0) parts.push(headerLine, '');
                parts.push(...chunk);
                if (i === chunks.length - 1) parts.push('', ...footerLines);
                return new EmbedBuilder()
                    .setTitle(i === 0 ? 'Auto-link Wizard' : null)
                    .setDescription(parts.join('\n'))
                    .setColor(EmbedColors.Warning);
            });
            embeds[embeds.length - 1].setFooter(footer).setTimestamp();
            await this.replyEmbeds(message, embeds);
            return;
        }

        // Execute all proposed links
        let successCount = 0;
        const errors: string[] = [];

        for (const proposal of proposals) {
            try {
                await this.linkProvisioner.createLink({
                    guildLink,
                    discord: { channelId: proposal.discord.id, threadId: null },
                    fluxer: { channelId: proposal.fluxer.id, threadId: null },
                });
                successCount++;
            } catch (err: unknown) {
                logger.error(
                    `❌ Autolink failed for #${proposal.discord.name} ↔ #${proposal.fluxer.name}:`,
                    err
                );
                errors.push(
                    `\`#${proposal.discord.name}\` ↔ \`#${proposal.fluxer.name}\`: ${(err as Error).message}`
                );
            }
        }

        const summaryLine = `Successfully linked **${successCount}** of **${proposals.length}** proposed channel pair${proposals.length !== 1 ? 's' : ''}.`;

        let embeds: EmbedBuilder[];
        if (errors.length === 0) {
            embeds = [
                new EmbedBuilder()
                    .setDescription(summaryLine)
                    .setColor(EmbedColors.Success),
            ];
        } else {
            const errorLines = errors.map((e) => `> ${e}`);
            const chunks = chunkDescriptionLines(errorLines, '\n');
            embeds = chunks.map((chunk, i) => {
                const parts: string[] = [];
                if (i === 0) parts.push(summaryLine, '', 'Failures:');
                parts.push(...chunk);
                return new EmbedBuilder()
                    .setDescription(parts.join('\n'))
                    .setColor(EmbedColors.Warning);
            });
        }
        embeds[embeds.length - 1].setFooter(footer).setTimestamp();
        await this.replyEmbeds(message, embeds);
    }
}
