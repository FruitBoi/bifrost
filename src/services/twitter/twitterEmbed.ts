import type { InstagramEmbedFields } from '../instagramVideo/instagramEmbed';
import type { TwitterPost } from './TwitterMediaService';

/** Twitter's brand blue, used as the card's accent colour. */
const TWITTER_BLUE = 0x1d9bf0;

/** Longest tweet text shown in the card, in characters. */
const MAX_TEXT_LENGTH = 1000;

/** Platform-neutral fields of the tweet card (same shape as the Instagram one). */
export type TwitterEmbedFields = InstagramEmbedFields;

/**
 * Cuts text to at most `max` characters without splitting a surrogate pair,
 * appending an ellipsis when something was cut.
 */
function truncate(text: string, max: number): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * Builds the fields of a tweet card for a fetched post.
 * Pure and platform-neutral so both the Discord and Fluxer sides can use it.
 */
export function twitterEmbedFields(post: TwitterPost): TwitterEmbedFields {
    const fields: TwitterEmbedFields = {
        url: post.sourceUrl,
        title: post.displayName ? `Tweet by ${post.displayName}` : 'Post on X',
        footer: 'X (Twitter)',
        color: TWITTER_BLUE,
    };

    if (post.username) {
        fields.authorName = post.displayName
            ? `${post.displayName} (@${post.username})`
            : `@${post.username}`;
        fields.authorUrl = `https://x.com/${post.username}`;
        if (post.profilePicUrl) fields.authorIconUrl = post.profilePicUrl;
    }

    let text = truncate((post.text ?? '').trim(), MAX_TEXT_LENGTH);
    if (text) {
        if (post.spoiler) {
            // Break up "||" runs so the text cannot close the spoiler early.
            text = `||${text.replace(/\|+/g, (run) =>
                run.length > 1 ? run.split('').join('​') : run
            )}||`;
        }
        fields.description = text;
    }

    return fields;
}
