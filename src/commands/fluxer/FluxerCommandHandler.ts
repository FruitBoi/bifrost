import {
    Client,
    EmbedBuilder,
    GuildMember,
    Message,
    PermissionResolvable,
} from '@fluxerjs/core';
import CommandHandler from '../CommandHandler';
import logger from '../../utils/logging/logger';
import { batchEmbeds, EmbedColors } from '../../utils/embeds';
import { DELETE_INVOCATION } from '../../utils/env';

// @fluxerjs/core does not expose ownerId on the Guild type declaration
interface FluxerGuildWithOwner {
    ownerId?: string;
}

type EmbedSender = (payload: { embeds: EmbedBuilder[] }) => Promise<unknown>;

export default abstract class FluxerCommandHandler extends CommandHandler<
    Client,
    Message
> {
    protected footer(message: Message) {
        if (!DELETE_INVOCATION) return null;
        const time = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
        });
        return {
            text: `${message.author.username} used ${message.content} • ${time}`,
            iconURL:
                (
                    message.author as { avatarURL?: () => string | undefined }
                ).avatarURL?.() ?? undefined,
        };
    }

    /**
     * Send `embeds` across as many messages as the per-message embed limits require
     * (see {@link batchEmbeds}): the first batch through `sendFirst`, every later batch
     * through `send`. A single batch is sent exactly as before, in one message.
     */
    protected async sendEmbeds(
        embeds: EmbedBuilder[],
        send: EmbedSender,
        sendFirst: EmbedSender = send
    ): Promise<void> {
        const batches = batchEmbeds(embeds);
        for (let i = 0; i < batches.length; i++) {
            await (i === 0 ? sendFirst : send)({ embeds: batches[i] });
        }
    }

    /**
     * Reply to `message` with `embeds`; any batch that does not fit in the reply is sent
     * as a standalone follow-up message in the same channel.
     */
    protected async replyEmbeds(
        message: Message,
        embeds: EmbedBuilder[]
    ): Promise<void> {
        await this.sendEmbeds(
            embeds,
            (payload) => message.send(payload),
            (payload) => message.reply(payload)
        );
    }

    /** Reply to `message` with a single error-coloured embed. */
    private async replyAccessDenied(
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

    /**
     * The author of `message` as a member of its guild, or null (after
     * replying "Could not fetch your member information.") when the guild
     * or the member cannot be resolved.
     */
    private async fetchAuthorMember(
        message: Message
    ): Promise<GuildMember | null> {
        let authorMember: GuildMember | null = null;
        try {
            const guild = message.guild ?? (await message.resolveGuild());
            if (!guild) {
                logger.warn(
                    `⚠️ Could not resolve Fluxer guild ${message.guildId} for member lookup`
                );
            }
            authorMember =
                (await guild?.fetchMember(message.author.id)) || null;
        } catch (error) {
            logger.error(
                '❌ Error fetching member for FluxerCommandHandler:',
                error
            );
        }

        if (!authorMember) {
            await this.replyAccessDenied(
                message,
                'Could not fetch your member information.'
            );
        }
        return authorMember;
    }

    protected async requirePermission(
        message: Message,
        permission: PermissionResolvable,
        permissionDisplayName?: string
    ): Promise<boolean> {
        const authorMember = await this.fetchAuthorMember(message);
        if (!authorMember) return false;

        if (!authorMember.permissions.has(permission)) {
            const displayName = permissionDisplayName || permission;
            await this.replyAccessDenied(
                message,
                `You need the \`${displayName}\` permission to use this command.`
            );
            return false;
        }
        return true;
    }

    /**
     * Whether the author holds at least one of `roleIds` in the guild of
     * `message` (callers pass the per-server allowlist, issue #43;
     * an empty list never passes). Like {@link requirePermission}, a failure is reported to the
     * author ("Could not fetch your member information." or "You do not have
     * a role that is allowed to use this command.") and yields false.
     */
    protected async requireRole(
        message: Message,
        roleIds: readonly string[]
    ): Promise<boolean> {
        const authorMember = await this.fetchAuthorMember(message);
        if (!authorMember) return false;

        if (!roleIds.some((id) => authorMember.roles.has(id))) {
            await this.replyAccessDenied(
                message,
                'You do not have a role that is allowed to use this command.'
            );
            return false;
        }
        return true;
    }

    protected async requireOwner(message: Message): Promise<boolean> {
        let guild = message.guild;
        try {
            guild ??= await message.resolveGuild();
        } catch (error) {
            logger.error('❌ Error resolving guild for requireOwner:', error);
        }
        if (
            (guild as unknown as FluxerGuildWithOwner)?.ownerId !==
            message.author.id
        ) {
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
