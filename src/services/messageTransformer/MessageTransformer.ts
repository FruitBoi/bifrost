import { emojiToString, GeneralEmoji, replaceEmojis } from '../../utils/emojis';
import MentionBridgeService from '../mentionBridge/MentionBridgeService';

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

    constructor(mentionBridge?: MentionBridgeService) {
        this.mentionBridge = mentionBridge ?? null;
    }

    abstract transformMessage(
        message: SourceMessage,
        otherEmojis?: GeneralEmoji[],
        options?: TransformOptions
    ): Promise<TargetMessage>;

    /**
     * Description for the quote embed of a replied-to message that has no
     * text (only attachments, stickers or embeds). Discord rejects an embed
     * with an empty description, which dropped the whole relayed reply.
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
