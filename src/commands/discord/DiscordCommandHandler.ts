import {
    Client,
    EmbedBuilder,
    Message,
    OmitPartialGroupDMChannel,
    PermissionResolvable,
} from 'discord.js';
import CommandHandler from '../CommandHandler';
import { batchEmbeds, EmbedColors } from '../../utils/embeds';
import { DELETE_INVOCATION } from '../../utils/env';

export type DiscordCommandHandlerMessage = OmitPartialGroupDMChannel<
    Message<boolean>
>;

export default abstract class DiscordCommandHandler extends CommandHandler<
    Client,
    DiscordCommandHandlerMessage
> {
    protected footer(message: DiscordCommandHandlerMessage) {
        if (!DELETE_INVOCATION) return null;
        return {
            text: `${message.author.username} used ${message.content}`,
            iconURL: message.author.displayAvatarURL(),
        };
    }

    /**
     * Reply with embeds, splitting them into as many messages as the per-message embed
     * count and character limits require. The first batch is sent as a reply; later
     * batches are sent as follow-up messages in the same channel.
     */
    protected async replyEmbeds(
        message: DiscordCommandHandlerMessage,
        embeds: EmbedBuilder[]
    ): Promise<void> {
        const batches = batchEmbeds(embeds);
        for (const [i, batch] of batches.entries()) {
            if (i === 0 || !message.channel.isSendable()) {
                await message.reply({ embeds: batch });
            } else {
                await message.channel.send({ embeds: batch });
            }
        }
    }

    /**
     * Send embeds through `send` (e.g. `dm.send`), one call per batch that fits in a
     * single message.
     */
    protected async sendEmbeds(
        embeds: EmbedBuilder[],
        send: (options: { embeds: EmbedBuilder[] }) => Promise<unknown>
    ): Promise<void> {
        for (const batch of batchEmbeds(embeds)) {
            await send({ embeds: batch });
        }
    }

    protected async requirePermission(
        message: DiscordCommandHandlerMessage,
        permission: PermissionResolvable,
        permissionDisplayName?: string
    ): Promise<boolean> {
        let member;
        try {
            member = await message.guild?.members.fetch(message.author.id);
            if (!member) {
                throw new Error('Member not found');
            }
        } catch {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            'Could not fetch your member information.'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
            });
            return false;
        }

        if (!member.permissions.has(permission)) {
            const displayName = permissionDisplayName || permission;
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `You need the \`${displayName}\` permission to use this command.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
            });
            return false;
        }

        return true;
    }

    protected async requireOwner(
        message: DiscordCommandHandlerMessage
    ): Promise<boolean> {
        if (message.guild?.ownerId !== message.author.id) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            'Only the server owner can use this command.'
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(this.footer(message))
                        .setTimestamp(),
                ],
            });
            return false;
        }
        return true;
    }
}
