import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { LinkService } from '../../../services/LinkService';
import IdentityClaimService from '../../../services/identityClaim/IdentityClaimService';
import { runIamCommand } from '../../../services/identityClaim/iamCommand';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `iam` (issue #3): links your Fluxer account to your Discord account so
 * pings reach you on both sides. Reply `iam` to the bridged copy of a message
 * you wrote on Discord; the bot asks that Discord account to confirm with
 * `iam yes`. `iam yes` / `iam no` answer a request, `iam remove` unlinks and
 * a bare `iam` shows your link. Open to every member.
 */
export default class IamFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly identityClaimService: IdentityClaimService
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const reply = (description: string, color: number) =>
            message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(description)
                        .setColor(color)
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
                allowedMentions: { parse: [], repliedUser: false },
            });

        if (!message.guildId) {
            await reply(
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot) return;

        try {
            const guildLink = await this.linkService
                .getGuildLinkForFluxerGuild(message.guildId)
                .catch(() => null);
            const result = await runIamCommand(this.identityClaimService, {
                platform: 'fluxer',
                userId: message.author.id,
                displayName:
                    message.member?.displayName ??
                    message.author.globalName ??
                    message.author.username,
                guildLink,
                repliedMessageId: message.messageReference?.messageId ?? null,
                args,
            });
            if (!result) {
                await message.reply(getFluxerCommandUsage('iam'));
                return;
            }
            await reply(result.description, result.color);
        } catch (err) {
            logger.error('❌ iam command failed:', err);
            await reply(
                `Something went wrong: ${(err as Error).message}`,
                EmbedColors.Error
            );
        }
    }
}
