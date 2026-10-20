import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import LinkProvisioner from '../../../services/LinkProvisioner';
import { GuildLink } from '../../../db/entities/GuildLink';
import { VoiceLink } from '../../../db/entities/VoiceLink';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { COMMAND_PREFIX, ENABLE_VOICE_BRIDGE } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';

type PendingVoiceAction = { type: 'remove'; voiceLinkId: string };

/**
 * `voice <fluxerVoiceChannelId> <discordVoiceChannelId> | unlink <id> |
 * on <id> | off <id> | confirm` — pairs a Fluxer voice channel with a
 * Discord voice channel. Linking happens immediately; `unlink` shows a preview
 * and is executed with `confirm`. `on`/`off` toggle a link without removing
 * it, and with no arguments the server's voice links are listed.
 */
export default class VoiceFluxerCommandHandler extends FluxerCommandHandler {
    private pending = new Map<
        string,
        { action: PendingVoiceAction; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingVoiceAction) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingVoiceAction | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
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

    private async replyEmbed(
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(color)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    /** Discord voice channel label for display: a link with the name, or the ID. */
    private async discordLabel(
        guildLink: GuildLink,
        discordChannelId: string
    ): Promise<string> {
        const target = await this.linkProvisioner
            .resolveDiscordVoiceTarget(
                guildLink.discordGuildId,
                discordChannelId
            )
            .catch(() => null);
        const url = `https://discord.com/channels/${guildLink.discordGuildId}/${discordChannelId}`;
        return `[🔊 ${target?.name ?? discordChannelId}](${url})`;
    }

    /**
     * Looks up the voice link for a Fluxer voice channel and makes sure it
     * belongs to this server's guild link.
     */
    private async voiceLinkFor(
        guildLink: GuildLink,
        fluxerChannelId: string
    ): Promise<VoiceLink | null> {
        const voiceLink = await this.linkService
            .getVoiceLinkForFluxerChannel(fluxerChannelId)
            .catch(() => null);
        if (!voiceLink || voiceLink.guildLinkId !== guildLink.id) return null;
        return voiceLink;
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId) {
            await this.replyError(
                message,
                'This command must be used in a server.'
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

        if (!ENABLE_VOICE_BRIDGE) {
            await this.replyError(
                message,
                'Voice bridging is disabled on this bot. Set `BF_ENABLE_VOICE_BRIDGE=true` to enable it.'
            );
            return;
        }

        const sub = args[0]?.toLowerCase();

        if (sub === 'confirm') {
            await this.handleConfirm(message);
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

        if (sub === undefined) {
            await this.handleList(message, guildLink);
            return;
        }

        if (sub === 'unlink') {
            await this.handleUnlink(message, guildLink, args[1]);
            return;
        }

        if (sub === 'on' || sub === 'off') {
            await this.handleToggle(message, guildLink, args[1], sub === 'on');
            return;
        }

        await this.handleCreate(message, guildLink, args[0], args[1]);
    }

    private async handleList(message: Message, guildLink: GuildLink) {
        try {
            const voiceLinks = await this.linkService.getVoiceLinksForGuildLink(
                guildLink.id
            );
            if (voiceLinks.length === 0) {
                await message.reply(getFluxerCommandUsage('voice'));
                return;
            }

            const lines = await Promise.all(
                voiceLinks.map(async (voiceLink) => {
                    const discordLabel = await this.discordLabel(
                        guildLink,
                        voiceLink.discordChannelId
                    );
                    const state = voiceLink.enabled
                        ? '✅ enabled'
                        : '⛔ disabled';
                    // Fluxer on left, Discord on right (viewing from Fluxer)
                    return `🔊 <#${voiceLink.fluxerChannelId}> ←→ ${discordLabel} · ${state}\n  └ \`${voiceLink.fluxerChannelId}\` · \`${voiceLink.discordChannelId}\``;
                })
            );
            const chunks = chunkDescriptionLines(lines);
            const embeds = chunks.map((chunk, i) =>
                new EmbedBuilder()
                    .setTitle(i === 0 ? 'Fluxer ↔ Discord | Voice Links' : null)
                    .setDescription(chunk.join('\n\n'))
                    .setColor(EmbedColors.Info)
            );
            embeds[embeds.length - 1]
                .setFooter(this.footer(message))
                .setTimestamp();
            await this.replyEmbeds(message, embeds);
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to list voice links: ${(err as Error).message}`
            );
            logger.error('Error listing voice links:', err);
        }
    }

    private async handleCreate(
        message: Message,
        guildLink: GuildLink,
        fluxerChannelId: string,
        discordChannelId: string | undefined
    ) {
        if (!discordChannelId) {
            await message.reply(getFluxerCommandUsage('voice'));
            return;
        }

        try {
            const fluxer = await this.linkProvisioner.resolveFluxerVoiceTarget(
                guildLink.fluxerGuildId,
                fluxerChannelId
            );
            if (!fluxer) {
                await this.replyError(
                    message,
                    `\`${fluxerChannelId}\` is not a voice channel of this server.`
                );
                return;
            }
            const discord =
                await this.linkProvisioner.resolveDiscordVoiceTarget(
                    guildLink.discordGuildId,
                    discordChannelId
                );
            if (!discord) {
                await this.replyError(
                    message,
                    `\`${discordChannelId}\` is not a voice channel of the linked Discord guild.`
                );
                return;
            }

            if (
                await this.linkService.getVoiceLinkForFluxerChannel(fluxer.id)
            ) {
                await this.replyError(
                    message,
                    `<#${fluxer.id}> is already linked to a Discord voice channel. Run \`${COMMAND_PREFIX}voice unlink ${fluxer.id}\` first.`
                );
                return;
            }
            if (
                await this.linkService.getVoiceLinkForDiscordChannel(discord.id)
            ) {
                await this.replyError(
                    message,
                    `Discord voice channel **${discord.name}** (\`${discord.id}\`) is already linked to a Fluxer voice channel.`
                );
                return;
            }

            const voiceLink = await this.linkProvisioner.createVoiceLink(
                guildLink,
                discord.id,
                fluxer.id
            );
            await this.replyEmbed(
                message,
                `Linked voice channel 🔊 <#${voiceLink.fluxerChannelId}> with Discord voice channel 🔊 **${discord.name}** (\`${voiceLink.discordChannelId}\`).\n` +
                    `Only one voice link per server pair can be live at a time; the bridge joins whichever linked channel pair has people on both sides first.\n` +
                    `This is a one-time setup: the link is saved, and the bot joins both channels on its own once there are people in both, and leaves again when either side empties.`,
                EmbedColors.Success
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to create voice link: ${(err as Error).message}`
            );
            logger.error('Voice link failed:', err);
        }
    }

    private async handleUnlink(
        message: Message,
        guildLink: GuildLink,
        fluxerChannelId: string | undefined
    ) {
        if (!fluxerChannelId) {
            await message.reply(getFluxerCommandUsage('voice'));
            return;
        }

        const voiceLink = await this.voiceLinkFor(guildLink, fluxerChannelId);
        if (!voiceLink) {
            await this.replyError(
                message,
                `Voice channel \`${fluxerChannelId}\` is not linked in this server.`
            );
            return;
        }

        const discordLabel = await this.discordLabel(
            guildLink,
            voiceLink.discordChannelId
        );
        this.setPending(message.author.id, {
            type: 'remove',
            voiceLinkId: voiceLink.id,
        });
        await this.replyEmbed(
            message,
            `This removes the voice link between 🔊 <#${voiceLink.fluxerChannelId}> and Discord voice channel ${discordLabel} (\`${voiceLink.discordChannelId}\`). A live bridge is disconnected immediately.\n` +
                `Run \`${COMMAND_PREFIX}voice confirm\` to proceed.`,
            EmbedColors.Warning
        );
    }

    private async handleToggle(
        message: Message,
        guildLink: GuildLink,
        fluxerChannelId: string | undefined,
        enabled: boolean
    ) {
        if (!fluxerChannelId) {
            await message.reply(getFluxerCommandUsage('voice'));
            return;
        }

        const voiceLink = await this.voiceLinkFor(guildLink, fluxerChannelId);
        if (!voiceLink) {
            await this.replyError(
                message,
                `Voice channel \`${fluxerChannelId}\` is not linked in this server.`
            );
            return;
        }

        try {
            await this.linkService.setVoiceLinkEnabled(voiceLink.id, enabled);
            await this.replyEmbed(
                message,
                enabled
                    ? `Voice link for 🔊 <#${voiceLink.fluxerChannelId}> is now **enabled**.`
                    : `Voice link for 🔊 <#${voiceLink.fluxerChannelId}> is now **disabled**. The link is kept but the bridge will not join.`,
                EmbedColors.Success
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to ${enabled ? 'enable' : 'disable'} voice link: ${(err as Error).message}`
            );
            logger.error('Voice link toggle failed:', err);
        }
    }

    private async handleConfirm(message: Message) {
        const pending = this.takePending(message.author.id);
        if (!pending) {
            await this.replyError(
                message,
                `No pending voice unlink. Run \`${COMMAND_PREFIX}voice unlink <fluxerVoiceChannelId>\` first.`
            );
            return;
        }

        try {
            const voiceLink = await this.linkProvisioner.removeVoiceLink(
                pending.voiceLinkId
            );
            await this.replyEmbed(
                message,
                `Removed the voice link for 🔊 <#${voiceLink.fluxerChannelId}> (Discord voice channel \`${voiceLink.discordChannelId}\`).`,
                EmbedColors.Success
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to remove voice link: ${(err as Error).message}`
            );
            logger.error('Voice unlink failed:', err);
        }
    }
}
