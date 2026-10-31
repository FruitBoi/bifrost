/**
 * Finds Instagram post links in a chat message (issue #45).
 *
 * Only public post shapes are recognised: `/p/<code>`, `/reel/<code>`,
 * `/reels/<code>` and `/tv/<code>` on instagram.com (optionally `www.` or
 * `m.`), with or without a leading `/<username>/` segment. The same paths on
 * the embed-fixer redirect sites (kkinstagram, ddinstagram, vxinstagram, ...;
 * issue #52) count too and are canonicalised to instagram.com. Profiles,
 * stories, explore pages and other look-alike domains are ignored. Links the poster wrapped
 * in `<...>` (the "no preview" syntax on Discord and Fluxer) and links inside
 * inline code or code blocks are skipped too.
 */

import { SPOILER_MARKER } from '../../utils/spoilers';

export interface InstagramLink {
    /** Canonical post URL, e.g. https://www.instagram.com/reel/ABC123/ (query/fragment stripped). */
    url: string;
    /** True when the link sat inside a ||spoiler|| in the message. */
    spoiler: boolean;
}

/**
 * An Instagram post URL up to the end of its token. Group 1 is the post type,
 * group 2 the shortcode. The token stops at whitespace, `<`, `>` and `|`, so
 * `||url||` and `<url>` leave their markup outside the match.
 */
const INSTAGRAM_URL_RE =
    /https?:\/\/(?:www\.|m\.|d\.|g\.)?(?:instagram|kkinstagram|ddinstagram|vxinstagram|uuinstagram|eeinstagram|instagramez)\.com\/(?:[A-Za-z0-9._]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]+)(?:[/?#][^\s<>|]*)?/gi;

/** Code blocks first, then double- and single-backtick inline code. */
const CODE_RE = /```[\s\S]*?```|``[\s\S]*?``|`[^`]*`/g;

/** `text` with every code span replaced by spaces, so indices still line up. */
function blankCode(text: string): string {
    return text.replace(CODE_RE, (code) => ' '.repeat(code.length));
}

/**
 * The `[start, end)` ranges of `text` that lie inside a closed `||spoiler||`
 * pair. Backslash-escaped pipes do not count, like in `utils/spoilers`, and a
 * trailing unmatched `||` opens nothing.
 */
function spoilerRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let openAt = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
        } else if (text.startsWith(SPOILER_MARKER, i)) {
            if (openAt < 0) {
                openAt = i + SPOILER_MARKER.length;
            } else {
                ranges.push([openAt, i]);
                openAt = -1;
            }
            i += SPOILER_MARKER.length - 1;
        }
    }
    return ranges;
}

/** Canonical form of a post link: `https://www.instagram.com/<type>/<code>/`. */
function canonicalUrl(type: string, code: string): string {
    const kind = type.toLowerCase() === 'reels' ? 'reel' : type.toLowerCase();
    return `https://www.instagram.com/${kind}/${code}/`;
}

/** Instagram post/reel/tv links in `content`, deduplicated by canonical URL, in order, at most `max`. */
export function findInstagramLinks(
    content: string,
    max: number
): InstagramLink[] {
    if (!content || max <= 0) return [];

    const text = blankCode(content);
    const spoilers = spoilerRanges(text);
    const links: InstagramLink[] = [];
    const seen = new Set<string>();

    const re = new RegExp(INSTAGRAM_URL_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null && links.length < max) {
        const start = match.index;
        const end = start + match[0].length;

        // `<url>` suppresses the embed; the poster asked for no preview.
        if (text[start - 1] === '<' && text[end] === '>') continue;

        // The scheme must start a word, so `xhttps://...` is not a link.
        if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue;

        const url = canonicalUrl(match[1], match[2]);
        if (seen.has(url)) continue;
        seen.add(url);

        const spoiler = spoilers.some(
            ([from, to]) => start >= from && end <= to
        );
        links.push({ url, spoiler });
    }
    return links;
}

/** The shortcode of a canonical post URL (`ABC123` for `.../reel/ABC123/`). */
export function instagramShortcode(url: string): string | null {
    const match = /instagram\.com\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/i.exec(
        url
    );
    return match ? match[1] : null;
}
