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
