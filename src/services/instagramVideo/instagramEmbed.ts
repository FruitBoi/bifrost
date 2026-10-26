import type { InstagramPost } from './InstagramVideoService';

/** Instagram's brand pink, used as the card's accent colour. */
const INSTAGRAM_PINK = 0xe1306c;

/** Longest caption shown in the card, in characters. */
const MAX_CAPTION_LENGTH = 1000;

/** Platform-neutral fields of the Instagram card posted with a post's media. */
export interface InstagramEmbedFields {
    url: string;
    title: string;
    description?: string;
    authorName?: string;
    authorUrl?: string;
    authorIconUrl?: string;
    footer: string;
    color: number;
}

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
 * Builds the fields of an Instagram-style embed card for a fetched post.
 * Pure and platform-neutral so both the Discord and Fluxer sides can use it.
 */
export function instagramEmbedFields(
    post: InstagramPost
): InstagramEmbedFields {
    const fields: InstagramEmbedFields = {
        url: post.sourceUrl,
        title: /\/reel\//.test(post.sourceUrl)
            ? 'Instagram reel'
            : 'Instagram post',
        footer: 'Instagram',
        color: INSTAGRAM_PINK,
    };

    if (post.username) {
        fields.authorName = `@${post.username}`;
        fields.authorUrl = `https://www.instagram.com/${post.username}/`;
        if (post.profilePicUrl) fields.authorIconUrl = post.profilePicUrl;
    }

    let caption = truncate((post.caption ?? '').trim(), MAX_CAPTION_LENGTH);
    if (caption) {
        if (post.spoiler) {
            // Break up "||" runs so the caption cannot close the spoiler early.
            caption = `||${caption.replace(/\|+/g, (run) =>
                run.length > 1 ? run.split('').join('​') : run
            )}||`;
        }
        fields.description = caption;
    }

    return fields;
}
