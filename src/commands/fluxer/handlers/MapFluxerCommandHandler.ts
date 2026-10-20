import { Client, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import UserPairFluxerCommandHandler from './UserPairFluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/**
 * `map <@fluxerUser> <discordUserId>`: records that the mentioned Fluxer
 * member is the given Discord user (a user link, used to bridge pings), but
 * only when neither account is mapped yet. Existing mappings are reported
 * and left alone; `role` replaces them. Only members holding one of the
 * configured Fluxer role IDs may run it.
 */
export default class MapFluxerCommandHandler extends UserPairFluxerCommandHandler {
    constructor(
        client: Client,
        linkService: LinkService,
        discordEntityResolver: DiscordEntityResolver,
        allowedRoleIds: readonly string[]
    ) {
        super(client, linkService, discordEntityResolver, allowedRoleIds);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const pair = await this.resolveUserPair(message, 'map', args);
        if (!pair) return;
        const { guildLink, discordMember, targetUserId } = pair;
        const who = `<@${targetUserId}> and Discord user \`${discordMember.id}\` (${discordMember.user.username})`;

        let result;
        try {
            result = await this.linkService.createUserLinkIfUnmapped({
                guildLinkId: guildLink.id,
                discordUserId: discordMember.id,
                fluxerUserId: targetUserId,
            });
        } catch (err) {
            logger.error(
                `❌ Could not record identity mapping for Fluxer user ${targetUserId} ↔ Discord user ${discordMember.id}:`,
                err
            );
            await this.reply(
                message,
                `Could not record the mapping: ${(err as Error).message}`,
                EmbedColors.Error
            );
            return;
        }

        if (result.link) {
            logger.info(
                `👥 Mapped Fluxer user ${targetUserId} to Discord user ${discordMember.id} in guild link ${guildLink.id}`
            );
            await this.reply(
                message,
                `Mapped ${who}. Pings of either account are now bridged to the other.`,
                EmbedColors.Success
            );
            return;
        }

        const identical = result.existing.find(
            (link) =>
                link.discordUserId === discordMember.id &&
                link.fluxerUserId === targetUserId
        );
        if (identical) {
            await this.reply(
                message,
                `${who} are already mapped to each other; nothing changed.`,
                EmbedColors.Info
            );
            return;
        }

        const lines = [
            `Not mapped: ${who} would conflict with an existing mapping.`,
        ];
        for (const link of result.existing) {
            lines.push(
                `- <@${link.fluxerUserId}> is mapped to Discord user \`${link.discordUserId}\``
            );
        }
        lines.push('Use the `role` command to replace a mapping.');
        await this.reply(message, lines.join('\n'), EmbedColors.Warning);
    }
}
