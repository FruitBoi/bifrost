/**
 * Finds GIFs and videos a Discord message only links to (issue #53), so the
 * bridge can download them and upload the file to Fluxer instead of relaying
 * a bare link.
 *
 * Two shapes are recognised:
 * - Direct links to Discord's CDN (`cdn.discordapp.com`,
 *   `media.discordapp.net`) ending in `.gif`/`.mp4`/`.webm`/`.mov`. These
 *   expire, so relaying the link alone breaks after a while. Other hosts are
 *   never fetched without an embed vouching for them.
 * - Links Discord unfurled into a GIF or video embed: `gifv` embeds from the
 *   GIF picker (Tenor, Giphy, Klipy), `video` embeds whose video is a real
 *   file (not a YouTube-style player page) and `image` embeds of a `.gif`.
 *
 * Links the poster wrapped in `<...>` (no preview) and links inside inline
 * code or code blocks are skipped. Pure: no I/O.
 */

import { SPOILER_MARKER } from '../../utils/spoilers';

/** Structural subset of a discord.js Embed (callers map `embed.data.type`, `embed.url`, `embed.video`, `embed.image`, `embed.thumbnail`). */
export type LinkedMediaEmbed = {
    type?: string | null;
    url?: string | null;
    video?: { url?: string | null; proxyURL?: string | null } | null;
    image?: { url?: string | null; proxyURL?: string | null } | null;
    thumbnail?: { url?: string | null; proxyURL?: string | null } | null;
};

export type LinkedMedia = {
    /** The link exactly as written in the message content. */
    link: string;
    /** Direct file URL to download and upload. */
    url: string;
    /** File name with extension, e.g. `dancing-cat.gif`, `clip.mp4`. */
    name: string;
    /** True when the link was inside a ||spoiler||. */
    spoiler: boolean;
};

/** Default cap on media files taken from one message. */
export const MAX_LINKED_MEDIA = 4;

/** Hosts whose media links are downloaded without an embed. */
const DISCORD_CDN_HOSTS = new Set([
    'cdn.discordapp.com',
    'media.discordapp.net',
]);

const MEDIA_EXT_RE = /\.(gif|mp4|webm|mov)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i;
const GIF_EXT_RE = /\.gif$/i;

/**
 * Tenor's mp4 rendition: `media.tenor.com/<id>AAAPo/<slug>.mp4`. The last
 * five characters of the path id are the format code; `AAAAC` is the gif.
 */
const TENOR_MP4_RE =
    /^https?:\/\/media\.tenor\.com\/([A-Za-z0-9_-]+)AAAPo\/([^/?#]+)\.mp4(?:[?#].*)?$/i;

/**
 * An http(s) URL up to the end of its token. The token stops at whitespace,
 * `<`, `>` and `|`, so `||url||` and `<url>` leave their markup outside the
 * match; trailing punctuation is trimmed afterwards.
 */
const URL_RE = /https?:\/\/[^\s<>|]+/gi;

/** Code blocks first, then double- and single-backtick inline code. */
const CODE_RE = /```[\s\S]*?```|``[\s\S]*?``|`[^`]*`/g;

/** A link found in message content. */
interface ContentLink {
    link: string;
    spoiler: boolean;
}

/** `text` with every code span replaced by spaces, so indices still line up. */
function blankCode(text: string): string {
    return text.replace(CODE_RE, (code) => ' '.repeat(code.length));
}

/**
 * The `[start, end)` ranges of `text` that lie inside a closed `||spoiler||`
 * pair. Backslash-escaped pipes do not count and a trailing unmatched `||`
 * opens nothing.
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

/**
 * Drops trailing punctuation and markdown from a matched URL: `.`, `,`, `*`,
 * `_`, ... and a `)` that has no `(` inside the URL (`(see https://x/y)`).
 */
function trimUrl(url: string): string {
    let out = url;
    for (;;) {
        const last = out[out.length - 1];
        if (/[.,;:!?'"*_~]/.test(last)) {
            out = out.slice(0, -1);
        } else if (
            last === ')' &&
            (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length
        ) {
            out = out.slice(0, -1);
        } else {
            return out;
        }
    }
}

/**
 * Bare links in `content`, in order, without duplicates: not wrapped in
 * `<...>` and not inside code.
 */
function contentLinks(content: string): ContentLink[] {
    if (!content) return [];

    const text = blankCode(content);
    const spoilers = spoilerRanges(text);
    const links: ContentLink[] = [];
    const seen = new Set<string>();

    const re = new RegExp(URL_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const raw = match[0];
        const link = trimUrl(raw);
        const end = start + link.length;

        // `<url>` suppresses the embed; the poster asked for no preview.
        if (text[start - 1] === '<' && text[start + raw.length] === '>') {
            continue;
        }

        // The scheme must start a word, so `xhttps://...` is not a link.
        if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue;

        if (seen.has(link)) continue;
        seen.add(link);

        const spoiler = spoilers.some(
            ([from, to]) => start >= from && end <= to
        );
        links.push({ link, spoiler });
    }
    return links;
}

/** `url` parsed, or null when it is not a valid http(s) URL. */
function parseUrl(url: string | null | undefined): URL | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
            ? parsed
            : null;
    } catch {
        return null;
    }
}

/**
 * Loose comparison key for a link: scheme, `www.`, host case, fragment and
 * trailing slash do not matter.
 */
function linkKey(url: string | null | undefined): string | null {
    const parsed = parseUrl(url);
    if (!parsed) return null;
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`;
}

/** True when the path of `url` (query ignored) matches `ext`. */
function pathMatches(url: string | null | undefined, ext: RegExp): boolean {
    const parsed = parseUrl(url);
    return parsed !== null && ext.test(parsed.pathname);
}

/** The decoded last path segment of `url`, or '' when there is none. */
function lastSegment(url: string): string {
    const parsed = parseUrl(url);
    if (!parsed) return '';
    const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
        return decodeURIComponent(segment).replace(/[/\\]/g, '_');
    } catch {
        return segment;
    }
}

/**
 * A readable slug from a GIF page link: `tenor.com/view/dancing-cat-gif-123`
 * gives `dancing-cat-gif`, `giphy.com/gifs/dancing-cat-AbC1` gives
 * `dancing-cat`. Null for other links or ids without a slug.
 */
function pageSlug(link: string): string | null {
    const parsed = parseUrl(link);
    if (!parsed) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const match =
        host === 'tenor.com'
            ? /^\/(?:[a-z-]+\/)?view\/(.+)-\d+\/?$/i.exec(parsed.pathname)
            : host === 'giphy.com'
              ? /^\/gifs\/(?:.+\/)?(.+)-[A-Za-z0-9]+\/?$/.exec(parsed.pathname)
              : null;
    if (!match) return null;
    const slug = match[1].replace(/[^A-Za-z0-9_-]/g, '');
    return slug || null;
}

/**
 * File name for `url`: its last path segment, unless that is missing, has no
 * media extension or is a generic name like `giphy.mp4`, in which case the
 * page slug (or `fallback`) is used with the URL's extension.
 */
function fileName(url: string, link: string, fallback: string): string {
    const segment = lastSegment(url);
    const ext = MEDIA_EXT_RE.exec(segment)?.[0].toLowerCase();
    const base = ext ? segment.slice(0, -ext.length) : '';
    const fallbackExt = fallback.slice(fallback.lastIndexOf('.'));
    const generic =
        !base || /^(giphy|tenor|klipy|source|video|media)$/i.test(base);
    if (!generic) return segment;
    const slug = pageSlug(link);
    return slug ? `${slug}${ext ?? fallbackExt}` : ext ? segment : fallback;
}

/** The file behind a `gifv` embed, preferring a real GIF over the mp4. */
function gifvMedia(
    embed: LinkedMediaEmbed,
    link: string
): { url: string; name: string } | null {
    const video = embed.video?.url ?? null;
    const tenor = video ? TENOR_MP4_RE.exec(video) : null;
    if (tenor) {
        let slug = tenor[2];
        try {
            slug = decodeURIComponent(slug);
        } catch {
            // keep it encoded
        }
        return {
            url: `https://media.tenor.com/${tenor[1]}AAAAC/${tenor[2]}.gif`,
            name: `${slug.replace(/[/\\]/g, '_')}.gif`,
        };
    }
    const image = embed.image?.url ?? null;
    if (image && pathMatches(image, GIF_EXT_RE)) {
        return { url: image, name: fileName(image, link, 'gif.gif') };
    }
    if (video && parseUrl(video)) {
        return { url: video, name: fileName(video, link, 'video.mp4') };
    }
    return null;
}

/** The downloadable file behind an embed, or null when it has none. */
function embedMedia(
    embed: LinkedMediaEmbed,
    link: string
): { url: string; name: string } | null {
    switch (embed.type) {
        case 'gifv':
            return gifvMedia(embed, link);
        case 'video': {
            const video = embed.video?.url ?? null;
            if (!video || !pathMatches(video, VIDEO_EXT_RE)) return null;
            return { url: video, name: fileName(video, link, 'video.mp4') };
        }
        case 'image': {
            const image = embed.image?.url ?? embed.thumbnail?.url ?? null;
            if (!image || !pathMatches(image, GIF_EXT_RE)) return null;
            return { url: image, name: fileName(image, link, 'gif.gif') };
        }
        default:
            return null;
    }
}

/** True for a direct media link on Discord's CDN. */
function isDiscordCdnMedia(link: string): boolean {
    const parsed = parseUrl(link);
    return (
        parsed !== null &&
        DISCORD_CDN_HOSTS.has(parsed.hostname.toLowerCase()) &&
        MEDIA_EXT_RE.test(parsed.pathname)
    );
}

/**
 * GIFs and videos linked in `content` that can be downloaded and uploaded as
 * files, in content order, deduplicated by link, at most `maxItems`.
 * `embeds` are the message's embeds; a link only counts through an embed
 * whose `url` matches it, except direct Discord CDN media links.
 */
export function findLinkedMedia(
    content: string,
    embeds: LinkedMediaEmbed[],
    maxItems: number = MAX_LINKED_MEDIA
): LinkedMedia[] {
    if (maxItems <= 0) return [];

    const media: LinkedMedia[] = [];
    for (const { link, spoiler } of contentLinks(content)) {
        if (media.length >= maxItems) break;

        if (isDiscordCdnMedia(link)) {
            media.push({
                link,
                url: link,
                name: fileName(link, link, 'video.mp4'),
                spoiler,
            });
            continue;
        }

        const key = linkKey(link);
        if (!key) continue;
        for (const embed of embeds) {
            if (linkKey(embed.url) !== key) continue;
            const found = embedMedia(embed, link);
            if (found) {
                media.push({ link, ...found, spoiler });
                break;
            }
        }
    }
    return media;
}

/**
 * `content` with nothing left when it is only the `media` links (plus
 * whitespace and spoiler bars), since Discord hides a lone GIF link too.
 * Any other content is returned unchanged.
 */
export function stripLinkedMediaLinks(
    content: string,
    media: LinkedMedia[]
): string {
    if (media.length === 0) return content;
    let rest = content;
    // Longest first, so a link that prefixes another is not cut out of it.
    const links = media
        .map((item) => item.link)
        .sort((a, b) => b.length - a.length);
    for (const link of links) {
        rest = rest.split(link).join(' ');
    }
    return rest.replace(/\|\|/g, '').trim() === '' ? '' : content;
}

/** True for a link to a GIF page Discord unfurls into a `gifv` embed. */
function isGifPageLink(link: string): boolean {
    const parsed = parseUrl(link);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname;
    if (host === 'tenor.com') return /^\/(?:[a-z-]+\/)?view\/./i.test(path);
    if (host === 'giphy.com') return /^\/(?:gifs|media)\/./i.test(path);
    if (host === 'klipy.com') return /^\/./.test(path);
    return false;
}

/**
 * True when `content` has a bare Tenor/Giphy/Klipy GIF page link that no
 * embed in `embeds` covers yet, i.e. Discord has not unfurled it so far and
 * waiting briefly for the embed update is worthwhile.
 */
export function hasPendingGifLink(
    content: string,
    embeds: LinkedMediaEmbed[]
): boolean {
    const embedKeys = new Set(
        embeds.map((embed) => linkKey(embed.url)).filter(Boolean)
    );
    return contentLinks(content).some(
        ({ link }) => isGifPageLink(link) && !embedKeys.has(linkKey(link))
    );
}
