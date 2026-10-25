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

    /**
     * Checks that the author holds at least one of `roleIds` (e.g. the
     * moderator role IDs resolved for this guild, issue #43), replying with an
     * error embed when they do not or when their member cannot be fetched.
     * Callers pass the per-server allowlist; an empty list never passes.
     */
    protected async requireRole(
        message: DiscordCommandHandlerMessage,
        roleIds: readonly string[]
    ): Promise<boolean> {
        let member;
        try {
            member = await message.guild?.members.fetch(message.author.id);
            if (!member) {
                throw new Error('Member not found');
            }
        } catch {
            await this.replyErrorEmbed(
                message,
                'Could not fetch your member information.'
            );
            return false;
        }

        if (!roleIds.some((id) => member.roles.cache.has(id))) {
            await this.replyErrorEmbed(
                message,
                'You do not have a role that is allowed to use this command.'
            );
            return false;
        }

        return true;
    }

    private async replyErrorEmbed(
        message: DiscordCommandHandlerMessage,
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
