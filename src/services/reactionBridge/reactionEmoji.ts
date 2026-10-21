import { GeneralEmoji } from '../../utils/emojis';

/**
 * A reaction emoji in a platform-neutral shape. Standard (Unicode) emojis
 * have `id: null` and carry the character itself in `name`; custom guild
 * emojis carry the emoji name and the platform-specific id.
 */
export interface ReactionEmoji {
    name: string;
    id: string | null;
    animated: boolean;
}

/**
 * Key that identifies a reaction emoji on a message: the Unicode character
 * for standard emojis, `name:id` for custom ones (the same convention both
 * discord.js and @fluxerjs/core use for their reaction caches).
 */
export function reactionEmojiKey(emoji: ReactionEmoji): string {
    return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

/**
 * Builds a {@link ReactionEmoji} from the loosely typed emoji objects both
 * SDKs put on reaction events (`id` may be `null` or `undefined`, `animated`
 * may be missing). Returns null when the emoji has no name, which happens
 * for custom emojis that were deleted from their guild.
 */
export function toReactionEmoji(emoji: {
    name?: string | null;
    id?: string | null;
    animated?: boolean | null;
}): ReactionEmoji | null {
    if (!emoji.name) return null;
    return {
        name: emoji.name,
        id: emoji.id ?? null,
        animated: emoji.animated ?? false,
    };
}

/**
 * Finds the emoji to react with on the other platform.
 *
 * Standard emojis are the same everywhere and map to themselves. A custom
 * emoji maps to the other guild's custom emoji with the same name (the rule
 * message bridging uses too, see `MessageTransformer.replaceEmojis`), and
 * to null when the other guild has none: the reaction is then not bridged.
 */
export function mapReactionEmoji(
    emoji: ReactionEmoji,
    otherEmojis: readonly GeneralEmoji[]
): ReactionEmoji | null {
    if (!emoji.id) return emoji;
    const match = otherEmojis.find((e) => e.name === emoji.name);
    if (!match) return null;
    return { name: match.name, id: match.id, animated: match.animated };
}
