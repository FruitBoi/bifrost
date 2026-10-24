import {
    Message,
    MessageAttachment,
    MessageAttachmentFlags,
    MessageSticker,
    PermissionFlags,
} from '@fluxerjs/core';
import MessageTransformer, { TransformOptions } from './MessageTransformer';
import { WebhookAttachment, WebhookMessageData } from '../WebhookService';
import { breakMentions, sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildFluxerStickerUrl } from '../../utils/buildStickerUrl';
import WebhookEmbed, { WebhookEmbedFooter } from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';
import MentionBridgeService, {
    ResolvedRoleMention,
    ResolvedUserMention,
} from '../mentionBridge/MentionBridgeService';

export default class FluxerMessageTransformer extends MessageTransformer<
    Message,
    WebhookMessageData
> {
    /**
     * Resolves the `<@id>` user mentions in the raw content to their mapped
     * Discord users. Unmapped ones are logged and relayed as plaintext.
     */
    private async resolveUserMentions(
        message: Message,
        options: TransformOptions
    ): Promise<ResolvedUserMention[]> {
        if (!this.mentionBridge) return [];
        const ids = MentionBridgeService.extractUserMentionIds(message.content);
        if (ids.length === 0) return [];
        return this.mentionBridge.resolveUserMentions({
            platform: 'fluxer',
            guildId: message.guildId ?? null,
            mentions: ids.map((id) => ({
                id,
                username: message.client.users.get(id)?.username ?? null,
            })),
            isEdit: options.isEdit,
        });
    }

    /**
     * Resolves the `<@&id>` role mentions in the raw content to the Discord
     * roles of the same name. Unmatched ones, and roles the author could not
     * ping on Fluxer, are logged and relayed as plaintext.
     */
    private async resolveRoleMentions(
        message: Message,
        options: TransformOptions
    ): Promise<ResolvedRoleMention[]> {
        if (!this.mentionBridge) return [];
        const ids = MentionBridgeService.extractRoleMentionIds(message.content);
        if (ids.length === 0) return [];
        return this.mentionBridge.resolveRoleMentions({
            platform: 'fluxer',
            guildId: message.guildId ?? null,
            mentions: ids.map((id) => {
                const role = message.guild?.roles.get(id);
                return {
                    id,
                    name: role?.name ?? null,
                    mentionable: role?.mentionable ?? false,
                };
            }),
            authorCanMentionAnyRole:
                message.member?.permissions.has(
                    PermissionFlags.MentionEveryone
                ) ?? false,
            isEdit: options.isEdit,
        });
    }

    /**
     * When a reply pings the author of a bridged message, resolves the Discord
     * user that the relayed copy must ping. Empty when there is nobody to ping.
     */
    private async resolveReplyMention(
        message: Message,
        referencedMessage: Message
    ): Promise<string[]> {
        if (!this.mentionBridge) return [];
        const repliedAuthorId = referencedMessage.author.id;
        const userId = await this.mentionBridge.resolveReplyPing({
            platform: 'fluxer',
            replierId: message.author.id,
            repliedMessageId: referencedMessage.id,
            repliedAuthorId,
            replyPings: message.mentions.some((u) => u.id === repliedAuthorId),
        });
        return userId ? [userId] : [];
    }

    private sanitizeContent(
        message: Message,
        renderUserMention?: (id: string) => string | null,
        renderRoleMention?: (id: string) => string | null,
        content: string = message.content
    ): string {
        return breakMentions(
            sanitizeMentions(content, {
                renderUserMention,
                renderRoleMention,
                resolveUser: (id) => {
                    const user = message.client.users.get(id);
                    return user ? user.username : null;
                },
                resolveRole: (id) => {
                    if (!message.guild) return null;
                    const role = message.guild.roles.get(id);
                    return role ? role.name : null;
                },
                resolveChannel: (id) => {
                    const channel = message.client.channels.get(id);
                    return channel ? channel.name : null;
                },
            })
        );
    }

    private buildAttachments(
        messageAttachments: Iterable<MessageAttachment>,
        stickers: MessageSticker[]
    ): WebhookAttachment[] {
        const attachments: WebhookAttachment[] = [];
        for (const attachment of messageAttachments) {
            if (!attachment.url) continue;
            attachments.push({
                url: attachment.url,
                name: attachment.filename || 'attachment',
                spoiler:
                    attachment.flags &&
                    attachment.flags & MessageAttachmentFlags.IS_SPOILER
                        ? true
                        : false,
                size: attachment.size,
            });
        }

        stickers.forEach((sticker) => {
            attachments.push({
                url: buildFluxerStickerUrl(
                    sticker.id,
                    sticker.animated || false,
                    160
                ),
                name: sticker.name + '.webp',
                spoiler: false,
            });
        });
        return attachments;
    }

    private buildForwardSourceFooter(message: Message): WebhookEmbedFooter {
        const reference = message.messageReference;
        const guild = reference?.guildId
            ? message.client.guilds.get(reference.guildId)
            : null;
        const channel = reference
            ? message.client.channels.get(reference.channelId)
            : null;
        const channelName = channel?.name ? `#${channel.name}` : null;

        if (guild && channelName) {
            return { text: `From ${channelName} in ${guild.name}` };
        }
        if (guild) {
            return { text: `From ${guild.name}` };
        }
        return { text: 'From another server' };
    }

    public async transformMessage(
        message: Message,
        discordEmojis: GeneralEmoji[] = [],
        options: TransformOptions = {}
    ): Promise<WebhookMessageData> {
        const directMentions = await this.resolveUserMentions(message, options);
        const roleMentions = await this.resolveRoleMentions(message, options);
        const counterpartByMentionId = new Map(
            directMentions.map((m) => [m.id, m.counterpartId])
        );
        const counterpartByRoleId = new Map(
            roleMentions.map((m) => [m.id, m.counterpartId])
        );
        const sanitizedContent = this.sanitizeContent(
            message,
            (id) => {
                const counterpartId = counterpartByMentionId.get(id);
                return counterpartId
                    ? MentionBridgeService.mentionPlaceholder(counterpartId)
                    : null;
            },
            (id) => {
                const counterpartId = counterpartByRoleId.get(id);
                return counterpartId
                    ? MentionBridgeService.roleMentionPlaceholder(counterpartId)
                    : null;
            }
        );
        const emojiReplacedContent = this.replaceEmojis(
            sanitizedContent,
            discordEmojis
        );

        const attachments = this.buildAttachments(
            message.attachments.values(),
            message.stickers
        );

        const embeds: WebhookEmbed[] = message.embeds.map((embed) =>
            WebhookEmbed.fromFluxerEmbed(embed)
        );

        // A forward carries no content of its own: the forwarded text, files
        // and embeds live in its snapshot. Without this the webhook payload
        // is empty and Discord rejects it (50006).
        const snapshot = message.messageSnapshots?.[0];
        if (snapshot) {
            attachments.push(
                ...this.buildAttachments(
                    snapshot.attachments ?? [],
                    snapshot.stickers ?? []
                )
            );
            embeds.push(
                ...(snapshot.embeds ?? []).map((embed) =>
                    WebhookEmbed.fromFluxerEmbed(embed)
                )
            );
            const content = this.sanitizeContent(
                message,
                undefined,
                undefined,
                snapshot.content ?? ''
            );
            embeds.unshift(
                new WebhookEmbed({
                    description:
                        content.trim() !== ''
                            ? content
                            : this.describeTextlessMessage({
                                  attachments:
                                      snapshot.attachments?.length ?? 0,
                                  stickers: snapshot.stickers?.length ?? 0,
                                  embeds: snapshot.embeds?.length ?? 0,
                              }),
                    color: 0x252529,
                    author: { name: 'Forwarded message ⏩' },
                    footer: this.buildForwardSourceFooter(message),
                    timestamp: null,
                })
            );
        }

        const allMentionUserIds = directMentions.map((m) => m.counterpartId);
        const referenced = message.referencedMessage;
        if (referenced) {
            allMentionUserIds.push(
                ...(await this.resolveReplyMention(message, referenced))
            );
            const content = this.sanitizeContent(referenced);
            embeds.unshift(
                new WebhookEmbed({
                    description:
                        content.trim() !== ''
                            ? content
                            : this.describeTextlessMessage({
                                  attachments: referenced.attachments.size,
                                  stickers: referenced.stickers.length,
                                  embeds: referenced.embeds.length,
                              }),
                    color: 0x252529,
                    author: {
                        name: referenced.author.username + ' ↩️',
                        iconURL: referenced.author.avatarURL() || undefined,
                    },
                    timestamp: null,
                })
            );
        }

        // Applied after breakMentions/sanitizeMentions/replaceEmojis so the
        // injected `<@id>` / `<@&id>` reaches Discord intact: mapped direct
        // and role mentions were placeholders until now, reply pings are
        // prepended. A user can be both (reply target and mentioned inline).
        const mentionUserIds = [...new Set(allMentionUserIds)];
        const mentionRoleIds = [
            ...new Set(roleMentions.map((m) => m.counterpartId)),
        ];
        const content =
            MentionBridgeService.restoreMentionPlaceholders(
                emojiReplacedContent
            );
        return {
            content:
                mentionUserIds.length > 0
                    ? MentionBridgeService.applyMentions(
                          content,
                          mentionUserIds
                      )
                    : content,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
            embeds,
            ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
            ...(mentionRoleIds.length > 0 ? { mentionRoleIds } : {}),
        };
    }
}
