/**
 * Parser for Instagram's public embed page (issue #48).
 *
 * `https://www.instagram.com/p/<code>/embed/captioned/` is the page Instagram
 * serves to third-party sites that embed a post. Its inline script carries a
 * `"contextJSON":"<JSON as a string>"` value with the post's media data
 * (`gql_data.shortcode_media`: type, video/image URLs, duration, owner,
 * caption, carousel children). For some posts (seen with plain images)
 * `contextJSON` is null; then the server-rendered HTML still has the image,
 * the author and the caption, which are read from it instead.
 *
 * Pure: an HTML string in, a {@link InstagramEmbedPost} (or null) out. Media
 * URLs are returned as found; the caller must check them with
 * {@link isInstagramCdnUrl} before downloading anything.
 */

export interface InstagramEmbedMedia {
    kind: 'video' | 'image';
    /** Direct media URL (video file, or full-size image). */
    url: string;
    /** Video length in seconds when the page says so; null for images or when unknown. */
    durationSeconds: number | null;
}

export interface InstagramEmbedPost {
    /** `GraphVideo`, `GraphImage`, `GraphSidecar`, ...; null when the page does not say. */
    mediaType: string | null;
    /** Shortcode from the page data, or null. */
    shortcode: string | null;
    /** Author username without "@", or null. */
    username: string | null;
    /** Author profile picture URL, or null. */
    profilePicUrl: string | null;
    /** Caption as plain text, or null when there is none. */
    caption: string | null;
    /** True when Instagram flags the post as copyright blocked. */
    copyrightBlocked: boolean;
    /**
     * Usable media in post order. Videos without a video URL are left out
     * (their poster image is not the post), so this can be empty, e.g. for a
     * video post whose page carries no `contextJSON`.
     */
    items: InstagramEmbedMedia[];
}

/** Hosts Instagram serves post media from (any subdomain). */
const CDN_HOST_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net'];

/** True for an https URL on an Instagram/Facebook media CDN host. */
export function isInstagramCdnUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port !== '' && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase();
    return CDN_HOST_SUFFIXES.some(
        (suffix) => host.endsWith(suffix) && host.length > suffix.length
    );
}

/** Named HTML entities seen in embed pages; numeric ones are handled too. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

/** Decodes `&amp;`, `&#064;`, `&#x40;` and the other common entities. */
export function decodeHtmlEntities(text: string): string {
    return text.replace(
        /&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi,
        (entity, body: string) => {
            if (body[0] === '#') {
                const hex = body[1] === 'x' || body[1] === 'X';
                const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
                if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
                    return entity;
                }
                try {
                    return String.fromCodePoint(code);
                } catch {
                    return entity;
                }
            }
            return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
        }
    );
}

/**
 * The decoded `contextJSON` object of the page, or null when it is missing,
 * null or malformed. The value is a JSON string inside a JSON array, so the
 * string literal is scanned (honouring backslash escapes), decoded, and the
 * result parsed again.
 */
function readContextJson(html: string): unknown {
    const match = /"contextJSON"\s*:\s*"/.exec(html);
    if (!match) return null;
    const start = match.index + match[0].length - 1;
    let end = start + 1;
    while (end < html.length) {
        const char = html[end];
        if (char === '\\') end += 2;
        else if (char === '"') break;
        else end++;
    }
    if (end >= html.length) return null;
    try {
        const text: unknown = JSON.parse(html.slice(start, end + 1));
        return typeof text === 'string' ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Json)
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** One media node (the post itself or a carousel child) as an item, or null. */
function mediaItem(node: Json): InstagramEmbedMedia | null {
    const isVideo = node.is_video === true || node.__typename === 'GraphVideo';
    if (isVideo) {
        const url = asString(node.video_url);
        if (!url) return null;
        const duration = node.video_duration;
        return {
            kind: 'video',
            url,
            durationSeconds:
                typeof duration === 'number' &&
                Number.isFinite(duration) &&
                duration > 0
                    ? duration
                    : null,
        };
    }
    const url = asString(node.display_url);
    return url ? { kind: 'image', url, durationSeconds: null } : null;
}

/** The post from the decoded `contextJSON`, or null when it has no media data. */
function postFromContext(context: unknown): InstagramEmbedPost | null {
    const root = asObject(context);
    const media = asObject(asObject(root?.gql_data)?.shortcode_media);
    if (!root || !media) return null;
    const info = asObject(root.context);

    const children = asObject(media.edge_sidecar_to_children)?.edges;
    const nodes =
        Array.isArray(children) && children.length > 0
            ? children.map((edge) => asObject(asObject(edge)?.node))
            : [media];
    const items = nodes
        .map((node) => (node ? mediaItem(node) : null))
        .filter((item): item is InstagramEmbedMedia => item !== null);

    const owner = asObject(media.owner);
    const captionEdges = asObject(media.edge_media_to_caption)?.edges;
    const caption = Array.isArray(captionEdges)
        ? asString(asObject(asObject(captionEdges[0])?.node)?.text)
        : null;

    return {
        mediaType: asString(media.__typename) ?? asString(info?.type),
        shortcode: asString(media.shortcode) ?? asString(info?.shortcode),
        username: asString(owner?.username),
        profilePicUrl: asString(owner?.profile_pic_url),
        caption: caption?.trim() || null,
        copyrightBlocked: info?.copyright_blocked === true,
        items,
    };
}

/** Value of attribute `name` in the tag `tag`, entity-decoded, or null. */
function attribute(tag: string, name: string): string | null {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return match ? decodeHtmlEntities(match[1]) || null : null;
}

/** Plain text of the server-rendered caption block, or null. */
function htmlCaption(html: string): string | null {
    const start = html.indexOf('<div class="Caption">');
    if (start < 0) return null;
    let body = html.slice(start + '<div class="Caption">'.length);
    // The caption ends at the "View all N comments" block or its own </div>.
    const ends = [
        body.indexOf('<div class="CaptionComments"'),
        body.indexOf('</div>'),
    ].filter((index) => index >= 0);
    if (ends.length > 0) body = body.slice(0, Math.min(...ends));

    body = body.replace(
        /^\s*<a\b[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/,
        ''
    );
    const text = decodeHtmlEntities(
        body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    ).trim();
    return text || null;
}

/** The post from the server-rendered HTML, or null when it is not an embed page. */
function postFromHtml(html: string): InstagramEmbedPost | null {
    const typeMatch = /\sdata-media-type="([A-Za-z]+)"/.exec(html);
    const hasEmbed = html.includes('class="EmbeddedMedia');
    if (!typeMatch && !hasEmbed) return null;
    const mediaType = typeMatch ? typeMatch[1] : null;

    // Only a single-image post is fully shown by the HTML: for a video the
    // image is just its poster frame, and a carousel shows its first slide.
    const items: InstagramEmbedMedia[] = [];
    if (mediaType === 'GraphImage') {
        const tag = /<img\b[^>]*class="EmbeddedMediaImage"[^>]*>/.exec(html);
        const url = tag ? attribute(tag[0], 'src') : null;
        if (url) items.push({ kind: 'image', url, durationSeconds: null });
    }

    const usernameMatch =
        /class="UsernameText"[^>]*>([^<]+)</.exec(html) ??
        /class="CaptionUsername"[^>]*>([^<]+)</.exec(html);
    const username = usernameMatch
        ? decodeHtmlEntities(usernameMatch[1]).trim().replace(/^@/, '') || null
        : null;
    const avatarTag =
        /<a\b[^>]*class="Avatar[^"]*"[^>]*>\s*(<img\b[^>]*>)/.exec(html);

    return {
        mediaType,
        shortcode: null,
        username,
        profilePicUrl: avatarTag ? attribute(avatarTag[1], 'src') : null,
        caption: htmlCaption(html),
        copyrightBlocked: false,
        items,
    };
}

/**
 * Parses an Instagram embed page. Prefers the page's `contextJSON` data and
 * falls back to the server-rendered HTML when it is null. Null when the text
 * is not an embed page at all. Never throws.
 */
export function parseInstagramEmbedPage(
    html: string
): InstagramEmbedPost | null {
    if (typeof html !== 'string' || html === '') return null;
    try {
        return postFromContext(readContextJson(html)) ?? postFromHtml(html);
    } catch {
        return null;
    }
}
