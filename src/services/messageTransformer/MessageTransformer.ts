import { emojiToString, GeneralEmoji, replaceEmojis } from '../../utils/emojis';
import MentionBridgeService from '../mentionBridge/MentionBridgeService';
import { MessagePlatform } from '../../db/entities/MessageLink';
import ReplyLinkResolver from '../replyQuote/ReplyLinkResolver';
import { messageUrl } from '../replyQuote/replyQuote';
import ChannelLinkBridge from '../channelLinkBridge/ChannelLinkBridge';

export type TransformOptions = {
    /**
     * Set when re-transforming an edited message. Per-message bookkeeping
     * (such as logging unresolved mentions) already happened on first relay.
     */
    isEdit?: boolean;
};

export default abstract class MessageTransformer<SourceMessage, TargetMessage> {
    /** Absent means mentions relay as plaintext only (no cross-bridge pings). */
    protected readonly mentionBridge: MentionBridgeService | null;

    /** Absent means reply quotes link to the source-platform message only. */
    protected readonly replyLinkResolver: ReplyLinkResolver | null;

    /**
     * Absent means channel mentions relay as plain `#name` text and channel
     * links are left as they are.
     */
    protected readonly channelLinkBridge: ChannelLinkBridge | null;

    constructor(
        mentionBridge?: MentionBridgeService,
        replyLinkResolver?: ReplyLinkResolver,
        channelLinkBridge?: ChannelLinkBridge
    ) {
        this.mentionBridge = mentionBridge ?? null;
        this.replyLinkResolver = replyLinkResolver ?? null;
        this.channelLinkBridge = channelLinkBridge ?? null;
    }

    /**
     * Prepares `texts` (raw content from `platform`) for the other side:
     * links to bridged channels, threads and messages are rewritten, and the
     * returned `renderChannelMention` turns a mention of a bridged channel or
     * thread into a mention of its counterpart (null for the rest, which
     * relay as plain `#name`).
     */
    protected async bridgeChannelLinks(
        platform: MessagePlatform,
        texts: string[]
    ): Promise<{
        texts: string[];
        renderChannelMention: (id: string) => string | null;
    }> {
        const bridge = this.channelLinkBridge;
        if (!bridge) return { texts, renderChannelMention: () => null };
        const ids = [
            ...new Set(
                texts.flatMap((text) =>
                    ChannelLinkBridge.extractChannelMentionIds(text)
                )
            ),
        ];
        const counterparts = await bridge.resolveChannelMentions(platform, ids);
        const rewritten = await Promise.all(
            texts.map((text) => bridge.rewriteChannelUrls(platform, text))
        );
        return {
            texts: rewritten,
            renderChannelMention: (id) => {
                const counterpartId = counterparts.get(id);
                return counterpartId ? `<#${counterpartId}>` : null;
            },
        };
    }

    abstract transformMessage(
        message: SourceMessage,
        otherEmojis?: GeneralEmoji[],
        options?: TransformOptions
    ): Promise<TargetMessage>;

    /**
     * Quote text for a replied-to message that has no text (only
     * attachments, stickers or embeds). Discord rejects an embed with an
     * empty description, which dropped the whole relayed reply.
     */
    protected describeTextlessMessage(counts: {
        attachments: number;
        stickers: number;
        embeds: number;
    }): string {
        const plural = (n: number, word: string) =>
            n === 1 ? word : `${n} ${word}s`;
        const parts: string[] = [];
        if (counts.attachments > 0) {
            parts.push(`📎 ${plural(counts.attachments, 'attachment')}`);
        }
        if (counts.stickers > 0) {
            parts.push(`🏷️ ${plural(counts.stickers, 'sticker')}`);
        }
        if (counts.embeds > 0) {
            parts.push(`🔗 ${plural(counts.embeds, 'embed')}`);
        }
        return parts.length > 0 ? `*${parts.join(' · ')}*` : '*No text*';
    }

    /**
     * The link for a reply quote: the replied-to message as readers on the
     * target platform know it (its bridged copy, or the original when it was
     * itself a copy). Falls back to the message on the source platform, and
     * to null when not even that URL can be built (e.g. outside a guild).
     */
    protected async resolveReplyUrl(
        platform: MessagePlatform,
        replied: {
            messageId: string | null | undefined;
            guildId: string | null | undefined;
            channelId: string | null | undefined;
        }
    ): Promise<string | null> {
        if (!replied.messageId) return null;
        const counterpart = this.replyLinkResolver
            ? await this.replyLinkResolver.resolveCounterpartUrl(
                  platform,
                  replied.messageId
              )
            : null;
        if (counterpart) return counterpart;
        if (!replied.guildId || !replied.channelId) return null;
        return messageUrl(
            platform,
            replied.guildId,
            replied.channelId,
            replied.messageId
        );
    }

    protected replaceEmojis(content: string, emojis: GeneralEmoji[]): string {
        return replaceEmojis(content, (emoji) => {
            const matchingEmoji = emojis.find((e) => e.name === emoji.name);
            if (matchingEmoji) {
                return `<${matchingEmoji.animated ? 'a' : ''}:${matchingEmoji.name}:${matchingEmoji.id}>`;
            }
            return emojiToString(emoji);
        });
    }
}
