import { Client, EmbedBuilder } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { LinkService } from '../../../services/LinkService';
import IdentityClaimService from '../../../services/identityClaim/IdentityClaimService';
import { runIamCommand } from '../../../services/identityClaim/iamCommand';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

/**
 * `iam` (issue #3): links your Discord account to your Fluxer account so
 * pings reach you on both sides. Reply `iam` to the bridged copy of a message
 * you wrote on Fluxer; the bot asks that Fluxer account to confirm with
 * `iam yes`. `iam yes` / `iam no` answer a request, `iam remove` unlinks and
 * a bare `iam` shows your link. Open to every member.
 */
export default class IamDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly identityClaimService: IdentityClaimService
    ) {
        super(client);
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
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

        if (!message.inGuild()) {
            await reply(
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot) return;

        try {
            const guildLink = await this.linkService
                .getGuildLinkForDiscordGuild(message.guildId)
                .catch(() => null);
            // Slash commands have no reply reference.
            const repliedMessageId =
                (message as { reference?: { messageId?: string } | null })
                    .reference?.messageId ?? null;
            const result = await runIamCommand(this.identityClaimService, {
                platform: 'discord',
                userId: message.author.id,
                displayName:
                    message.member?.displayName ??
                    message.author.displayName ??
                    message.author.username,
                guildLink,
                repliedMessageId,
                args,
            });
            if (!result) {
                await message.reply(getDiscordCommandUsage('iam'));
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
