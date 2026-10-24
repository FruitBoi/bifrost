import {
    Message,
    MessageFlags,
    MessageSnapshot,
    OmitPartialGroupDMChannel,
    PermissionFlagsBits,
    TextChannel,
} from 'discord.js';
import { WebhookAttachment, WebhookMessageData } from '../WebhookService';
import MessageTransformer, { TransformOptions } from './MessageTransformer';
import { sanitizeMentions } from '../../utils/sanitizeMentions';
import { buildDiscordStickerUrl } from '../../utils/buildStickerUrl';
import { getPollMessage } from '../../utils/pollMessageFormatter';
import WebhookEmbed, { WebhookEmbedFooter } from '../WebhookEmbed';
import { GeneralEmoji } from '../../utils/emojis';
import MentionBridgeService, {
    ResolvedRoleMention,
    ResolvedUserMention,
} from '../mentionBridge/MentionBridgeService';
import {
    applyReplyQuote,
    createReplyQuote,
    ReplyQuote,
} from '../replyQuote/replyQuote';

type DiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default class DiscordMessageTransformer extends MessageTransformer<
    DiscordMessage,
    WebhookMessageData
> {
    private stickerFormatToExtension(format: number): string {
        switch (format) {
            case 1:
                return 'png';
            case 2:
                return 'png';
            case 3:
                return 'json';
            case 4:
                return 'gif';
            default:
                return 'png';
        }
    }

    private buildAttachments(
        source: Pick<DiscordMessage, 'attachments' | 'stickers'>
    ): WebhookAttachment[] {
        const attachments: WebhookAttachment[] =
            source.attachments?.map((attachment) => ({
                url: attachment.url,
                name: attachment.name || 'attachment',
                spoiler: attachment.spoiler,
                size: attachment.size,
            })) ?? [];

        source.stickers?.forEach((sticker) => {
            attachments.push({
                url: buildDiscordStickerUrl(sticker.id, 160),
                name:
                    sticker.name +
                    '.' +
                    this.stickerFormatToExtension(sticker.format),
                spoiler: false,
            });
        });

        return attachments;
    }

    private buildRichEmbeds(
        source: Pick<DiscordMessage, 'embeds'>
    ): WebhookEmbed[] {
        return source.embeds
            .filter((embed) => embed.data.type === 'rich')
            .map((embed) => WebhookEmbed.fromDiscordEmbed(embed));
    }

    private sanitizeContent(
        message: Pick<DiscordMessage, 'content' | 'client' | 'guild'>,
        renderUserMention?: (id: string) => string | null,
        renderRoleMention?: (id: string) => string | null,
        content: string = message.content
    ): string {
        return sanitizeMentions(content, {
            renderUserMention,
            renderRoleMention,
            resolveUser: (id) => {
                const user = message.client.users.cache.get(id);
                return user ? user.username : null;
            },
            resolveRole: (id) => {
                if (!message.guild) return null;
                const role = message.guild.roles.cache.get(id);
                return role ? role.name : null;
            },
            resolveChannel: (id) => {
                const channel = message.client.channels.cache.get(id);
                return channel
                    ? channel instanceof TextChannel
                        ? channel.name
                        : channel.id
                    : null;
            },
        });
    }

    private buildForwardSourceFooter(
        message: DiscordMessage
    ): WebhookEmbedFooter | null {
        const reference = message.reference;
        if (!reference) return null;

        const guild = reference.guildId
            ? message.client.guilds.cache.get(reference.guildId)
            : null;
        const channel = message.client.channels.cache.get(reference.channelId);
        const channelName =
            channel instanceof TextChannel ? `#${channel.name}` : null;

        if (guild && channelName) {
            return { text: `From ${channelName} in ${guild.name}` };
        }
        if (guild) {
            return { text: `From ${guild.name}` };
        }
        return { text: 'From another server' };
    }

    /**
     * Resolves the `<@id>` user mentions in the raw content to their mapped
     * Fluxer users. Unmapped ones are logged and relayed as plaintext.
     */
    private async resolveUserMentions(
        message: Pick<DiscordMessage, 'content' | 'client' | 'guildId'>,
        options: TransformOptions
    ): Promise<ResolvedUserMention[]> {
        if (!this.mentionBridge) return [];
        const ids = MentionBridgeService.extractUserMentionIds(message.content);
        if (ids.length === 0) return [];
        return this.mentionBridge.resolveUserMentions({
            platform: 'discord',
            guildId: message.guildId ?? null,
            mentions: ids.map((id) => ({
                id,
                username: message.client.users.cache.get(id)?.username ?? null,
            })),
            isEdit: options.isEdit,
        });
    }

    /**
     * Resolves the `<@&id>` role mentions in the raw content to the Fluxer
     * roles of the same name. Unmatched ones, and roles the author could not
     * ping on Discord, are logged and relayed as plaintext.
     */
    private async resolveRoleMentions(
        message: Pick<
            DiscordMessage,
            'content' | 'guild' | 'guildId' | 'member'
        >,
        options: TransformOptions
    ): Promise<ResolvedRoleMention[]> {
        if (!this.mentionBridge) return [];
        const ids = MentionBridgeService.extractRoleMentionIds(message.content);
        if (ids.length === 0) return [];
        return this.mentionBridge.resolveRoleMentions({
            platform: 'discord',
            guildId: message.guildId ?? null,
            mentions: ids.map((id) => {
                const role = message.guild?.roles.cache.get(id);
                return {
                    id,
                    name: role?.name ?? null,
                    mentionable: role?.mentionable ?? false,
                };
            }),
            authorCanMentionAnyRole:
                message.member?.permissions.has(
                    PermissionFlagsBits.MentionEveryone
                ) ?? false,
            isEdit: options.isEdit,
        });
    }

    /**
     * When a reply pings the author of a bridged message, resolves the Fluxer
     * user that the relayed copy must ping. Empty when there is nobody to ping.
     */
    private async resolveReplyMention(
        message: DiscordMessage,
        referencedMessage: {
            id: string | null;
            author: { id: string } | null;
        }
    ): Promise<string[]> {
        if (
            !this.mentionBridge ||
            !referencedMessage.id ||
            !referencedMessage.author
        )
            return [];
        const repliedAuthorId = referencedMessage.author.id;
        const userId = await this.mentionBridge.resolveReplyPing({
            platform: 'discord',
            replierId: message.author.id,
            repliedMessageId: referencedMessage.id,
            repliedAuthorId,
            replyPings: message.mentions.users.has(repliedAuthorId),
        });
        return userId ? [userId] : [];
    }

    /**
     * Carries a forward's snapshot over: its files and embeds, plus an embed
     * quoting its text (or a bare label when it has none).
     */
    private addForwardedMessage(
        message: DiscordMessage,
        snapshot: MessageSnapshot,
        attachments: WebhookAttachment[],
        embeds: WebhookEmbed[]
    ): void {
        attachments.push(...this.buildAttachments(snapshot));
        embeds.push(...this.buildRichEmbeds(snapshot));

        const content = this.sanitizeContent(snapshot);
        if (content && content.trim() !== '') {
            const author = snapshot.author;
            embeds.unshift(
                new WebhookEmbed({
                    description: content,
                    color: 0x0b0d0e,
                    author: {
                        name: author
                            ? `${author.username} ⏩`
                            : 'Forwarded message ⏩',
                        iconURL: author?.avatarURL() || undefined,
                    },
                    footer: this.buildForwardSourceFooter(message),
                })
            );
        } else if (attachments.length > 0 || embeds.length > 0) {
            embeds.unshift(
                new WebhookEmbed({
                    description: 'Forwarded message ⏩',
                    color: 0x0b0d0e,
                    footer: this.buildForwardSourceFooter(message),
                })
            );
        }
    }

    /**
     * The quote of the message being replied to: a linked subtext line, or an
     * embed when the line does not fit (see {@link buildResult}).
     */
    private async buildReplyQuote(
        message: DiscordMessage,
        referencedMessage: DiscordMessage
    ): Promise<ReplyQuote> {
        // The quote may end up in the content, so it must never ping.
        const sanitized = this.sanitizeContent(
            referencedMessage,
            undefined,
            undefined,
            MentionBridgeService.breakEveryoneMentions(
                referencedMessage.content ?? ''
            )
        );
        const url = await this.resolveReplyUrl('discord', {
            messageId: referencedMessage.id ?? message.reference?.messageId,
            guildId:
                referencedMessage.guildId ??
                message.reference?.guildId ??
                message.guildId,
            channelId:
                referencedMessage.channelId ?? message.reference?.channelId,
        });
        return createReplyQuote({
            authorName: referencedMessage.author.username,
            authorIconURL: referencedMessage.author.avatarURL() || undefined,
            url,
            text: sanitized.trim() !== '' ? sanitized : null,
            textlessDescription: this.describeTextlessMessage({
                attachments: referencedMessage.attachments?.size ?? 0,
                stickers: referencedMessage.stickers?.size ?? 0,
                embeds: referencedMessage.embeds?.length ?? 0,
            }),
            color: 0x0b0d0e,
        });
    }

    private buildResult(
        message: DiscordMessage,
        rawContent: string,
        attachments: WebhookAttachment[],
        embeds: WebhookEmbed[],
        allMentionUserIds: string[],
        allMentionRoleIds: string[],
        mentionEveryone: boolean,
        replyQuote: ReplyQuote | null = null
    ): WebhookMessageData {
        // Mapped direct mentions sit in the content as placeholders until now
        // so that sanitising could not touch them; reply pings are prepended.
        // A user can be both (reply target and mentioned inline). Role
        // mentions stay inline where they were written.
        const mentionUserIds = [...new Set(allMentionUserIds)];
        const mentionRoleIds = [...new Set(allMentionRoleIds)];
        const restored =
            MentionBridgeService.restoreMentionPlaceholders(rawContent);
        let content =
            mentionUserIds.length > 0
                ? MentionBridgeService.applyMentions(restored, mentionUserIds)
                : restored;
        // Last, so the quote sits above reply pings and the text.
        if (replyQuote) content = applyReplyQuote(content, replyQuote, embeds);
        return {
            content,
            username: message.author.username,
            avatarURL: message.author.avatarURL() || '',
            attachments: attachments,
            embeds,
            ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
            ...(mentionRoleIds.length > 0 ? { mentionRoleIds } : {}),
            ...(mentionEveryone ? { mentionEveryone } : {}),
        };
    }

    public async transformMessage(
        message: DiscordMessage,
        fluxerEmojis: GeneralEmoji[] = [],
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
        // Discord only reports an @everyone / @here ping when the author was
        // allowed to make it; any other one is broken so the copy cannot ping.
        const pingsEveryone = message.mentions.everyone;
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
            },
            pingsEveryone
                ? MentionBridgeService.everyonePlaceholders(message.content)
                : MentionBridgeService.breakEveryoneMentions(message.content)
        );
        const emojiReplacedContent = this.replaceEmojis(
            sanitizedContent,
            fluxerEmojis
        );

        const attachments = this.buildAttachments(message);

        const isPollPresent =
            message.poll &&
            message.poll.question.text &&
            message.poll.answers.some((a) => a.text) &&
            message.poll.expiresTimestamp;

        const messageContent = isPollPresent
            ? getPollMessage(
                  message.poll!.question.text!,
                  message
                      .poll!.answers.map((a) => a.text)
                      .filter((t): t is string => !!t),
                  message.poll!.expiresTimestamp!
              )
            : emojiReplacedContent;

        const embeds: WebhookEmbed[] = this.buildRichEmbeds(message);
        // Polls carry generated content; direct mentions are not part of it.
        const mentionUserIds: string[] = isPollPresent
            ? []
            : directMentions.map((m) => m.counterpartId);
        const mentionRoleIds: string[] = isPollPresent
            ? []
            : roleMentions.map((m) => m.counterpartId);
        const mentionEveryone = pingsEveryone && !isPollPresent;

        let replyQuote: ReplyQuote | null = null;
        if (message.reference) {
            if (message.flags.has(MessageFlags.HasSnapshot)) {
                const snapshot = message.messageSnapshots.first();
                if (snapshot) {
                    this.addForwardedMessage(
                        message,
                        snapshot,
                        attachments,
                        embeds
                    );
                }
            } else {
                const referencedMessage = await message.fetchReference();
                if (referencedMessage) {
                    // Polls carry generated content; never prepend a mention
                    // to them.
                    if (!isPollPresent) {
                        mentionUserIds.push(
                            ...(await this.resolveReplyMention(
                                message,
                                referencedMessage
                            ))
                        );
                    }
                    replyQuote = await this.buildReplyQuote(
                        message,
                        referencedMessage
                    );
                }
            }
        }

        return this.buildResult(
            message,
            messageContent,
            attachments,
            embeds,
            mentionUserIds,
            mentionRoleIds,
            mentionEveryone,
            replyQuote
        );
    }
}
