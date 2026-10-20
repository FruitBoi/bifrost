import { Message, MessageAttachmentFlags } from '@fluxerjs/core';
import MessageTransformer, { TransformOptions } from './MessageTransformer';
import { WebhookMessageData } from '../WebhookService';
import { breakMentions, sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildFluxerStickerUrl } from '../../utils/buildStickerUrl';
import WebhookEmbed from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';
import MentionBridgeService, {
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
        renderUserMention?: (id: string) => string | null
    ): string {
        return breakMentions(
            sanitizeMentions(message.content, {
                renderUserMention,
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

    public async transformMessage(
        message: Message,
        discordEmojis: GeneralEmoji[] = [],
        options: TransformOptions = {}
    ): Promise<WebhookMessageData> {
        const directMentions = await this.resolveUserMentions(message, options);
        const counterpartByMentionId = new Map(
            directMentions.map((m) => [m.id, m.counterpartId])
        );
        const sanitizedContent = this.sanitizeContent(message, (id) => {
            const counterpartId = counterpartByMentionId.get(id);
            return counterpartId
                ? MentionBridgeService.mentionPlaceholder(counterpartId)
                : null;
        });
        const emojiReplacedContent = this.replaceEmojis(
            sanitizedContent,
            discordEmojis
        );

        const attachments = message.attachments
            .filter(
                (attachment) =>
                    attachment.url !== null &&
                    attachment.url !== undefined &&
                    attachment.url !== '' &&
                    !!attachment.url
            )
            .map((attachment) => ({
                url: attachment.url!,
                name: attachment.filename || 'attachment',
                spoiler:
                    attachment.flags &&
                    attachment.flags & MessageAttachmentFlags.IS_SPOILER
                        ? true
                        : false,
            }));

        message.stickers.forEach((sticker) => {
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

        const embeds: WebhookEmbed[] = message.embeds.map((embed) =>
            WebhookEmbed.fromFluxerEmbed(embed)
        );

        const allMentionUserIds = directMentions.map((m) => m.counterpartId);
        if (message.referencedMessage) {
            allMentionUserIds.push(
                ...(await this.resolveReplyMention(
                    message,
                    message.referencedMessage
                ))
            );
            const content = this.sanitizeContent(message.referencedMessage);
            embeds.unshift(
                new WebhookEmbed({
                    description: `${content}`,
                    color: 0x252529,
                    author: {
                        name: message.referencedMessage.author.username + ' ↩️',
                        iconURL:
                            message.referencedMessage.author.avatarURL() ||
                            undefined,
                    },
                    timestamp: null,
                })
            );
        }

        // Applied after breakMentions/sanitizeMentions/replaceEmojis so the
        // injected `<@id>` reaches Discord intact: mapped direct mentions were
        // placeholders until now, reply pings are prepended.
        // A user can be both (reply target and mentioned inline).
        const mentionUserIds = [...new Set(allMentionUserIds)];
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
        };
    }
}
