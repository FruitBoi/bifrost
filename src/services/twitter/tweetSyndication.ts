/**
 * Twitter/X public embed data (issue #56).
 *
 * Embedded tweets (publish.twitter.com, react-tweet, ...) load their data from
 * Twitter's public syndication endpoint,
 * `https://cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en&token=<token>`,
 * which needs no login, cookies or API key; the token is derived from the id.
 * This module builds that URL, fetches it with a byte cap and a time limit,
 * and turns the JSON into the few fields the bridge uses: author, plain text
 * and media (photos, and mp4 variants of videos and GIFs).
 *
 * Missing, deleted, protected and age-restricted tweets come back as a 404,
 * an empty body or a `TweetTombstone`; those are reported as `missing`, as
 * opposed to `failed` (network error, unexpected status, bad JSON), which may
 * be worth a retry by other means.
 *
 * Media URLs come from a remote response, so the caller must check them with
 * {@link isTwitterCdnUrl} (redirects too) before downloading anything.
 */

/** User agent for every request: says who we are, pretends nothing. */
export const TWITTER_USER_AGENT =
    'Mozilla/5.0 (compatible; Bifrost/1.0; +https://github.com/FruitBoi/bifrost)';

/** Most of the syndication JSON that is read. */
export const MAX_SYNDICATION_BYTES = 2 * 1024 * 1024;

/** Most media items a tweet holds. */
export const MAX_TWEET_MEDIA = 4;

/** Hosts Twitter serves media and avatars from (any subdomain). */
const CDN_HOST_SUFFIX = '.twimg.com';

export interface TweetMedia {
    /** `video` covers animated GIFs too (Twitter serves them as mp4). */
    kind: 'video' | 'image';
    /**
     * Candidate URLs, best first: for images the large then the medium
     * rendition, for videos the mp4 variants by falling bitrate.
     */
    urls: string[];
    /** Video length in seconds when the data says so; null for images or when unknown. */
    durationSeconds: number | null;
}

export interface SyndicatedTweet {
    /** Tweet id from the data. */
    id: string;
    /** Author handle without "@", or null. */
    screenName: string | null;
    /** Author display name, or null. */
    name: string | null;
    /** Author avatar URL, or null. */
    profileImageUrl: string | null;
    /** Tweet text as plain text: t.co links expanded, media link and reply mentions removed, entities decoded. Null when empty. */
    text: string | null;
    /** Usable media in tweet order, at most {@link MAX_TWEET_MEDIA}. */
    media: TweetMedia[];
}

export type TweetFetchResult =
    | { status: 'ok'; tweet: SyndicatedTweet }
    /** The tweet does not exist or is not public (404, empty body, tombstone). */
    | { status: 'missing' }
    /** Could not tell: network error, other HTTP status, oversized or bad JSON. */
    | { status: 'failed'; reason: string };

/**
 * The token the syndication endpoint expects for a tweet id; the same formula
 * Twitter's embed script and react-tweet use.
 */
export function syndicationToken(id: string): string {
    return ((Number(id) / 1e15) * Math.PI)
        .toString(6 ** 2)
        .replace(/(0+|\.)/g, '');
}

/** The syndication endpoint URL for a tweet id. */
export function tweetSyndicationUrl(id: string): string {
    const params = new URLSearchParams({
        id,
        lang: 'en',
        token: syndicationToken(id),
    });
    return `https://cdn.syndication.twimg.com/tweet-result?${params.toString()}`;
}

/** True for an https URL on a Twitter media CDN host (`*.twimg.com`). */
export function isTwitterCdnUrl(url: string): boolean {
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
    return (
        host.endsWith(CDN_HOST_SUFFIX) && host.length > CDN_HOST_SUFFIX.length
    );
}

/** Discards a response body we are not going to read. */
export async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/** The body if it is at most `cap` bytes, else null (stops reading at the cap). */
export async function readCapped(
    response: Response,
    cap: number
): Promise<Buffer | null> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > cap) {
        await discardBody(response);
        return null;
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/**
 * Fetches and parses a tweet's syndication data. Plain GET with an honest
 * user agent and no credentials. Never throws.
 */
export async function fetchTweet(
    id: string,
    options: { fetchImpl: typeof fetch; timeoutMs: number }
): Promise<TweetFetchResult> {
    try {
        const response = await options.fetchImpl(tweetSyndicationUrl(id), {
            headers: {
                'User-Agent': TWITTER_USER_AGENT,
                Accept: 'application/json',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (response.status === 404) {
            await discardBody(response);
            return { status: 'missing' };
        }
        if (response.status !== 200) {
            await discardBody(response);
            return { status: 'failed', reason: `HTTP ${response.status}` };
        }
        const body = await readCapped(response, MAX_SYNDICATION_BYTES);
        if (!body) {
            return {
                status: 'failed',
                reason: `response over ${MAX_SYNDICATION_BYTES} bytes`,
            };
        }
        const raw = body.toString('utf8').trim();
        if (raw === '') return { status: 'missing' };
        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch {
            return { status: 'failed', reason: 'response is not JSON' };
        }
        if (isMissing(json)) return { status: 'missing' };
        const tweet = parseTweetResult(json);
        return tweet
            ? { status: 'ok', tweet }
            : { status: 'failed', reason: 'response has no tweet data' };
    } catch (error) {
        return {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function arr(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** True for the "no such tweet" shapes: `{}`, `null` or a tombstone. */
function isMissing(json: unknown): boolean {
    if (!isObject(json)) return json === null;
    if (Object.keys(json).length === 0) return true;
    return json.__typename === 'TweetTombstone';
}

/** Decodes the HTML entities Twitter escapes in tweet text. */
export function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** `{ url, expanded_url }` pairs from an entities object. */
function urlEntities(
    entities: unknown
): Array<{ url: string; expanded: string }> {
    if (!isObject(entities)) return [];
    const pairs: Array<{ url: string; expanded: string }> = [];
    for (const entry of arr(entities.urls)) {
        if (!isObject(entry)) continue;
        const url = str(entry.url);
        const expanded = str(entry.expanded_url);
        if (url && expanded) pairs.push({ url, expanded });
    }
    return pairs;
}

/** The t.co links of attached media, which Twitter appends to the text. */
function mediaLinks(json: Json): string[] {
    const links = new Set<string>();
    const entities = isObject(json.entities) ? json.entities : {};
    for (const entry of arr(entities.media)) {
        if (isObject(entry) && str(entry.url)) links.add(entry.url as string);
    }
    for (const entry of arr(json.mediaDetails)) {
        if (isObject(entry) && str(entry.url)) links.add(entry.url as string);
    }
    return [...links];
}

/**
 * The plain text of a tweet: the long-form `note_tweet` text when present,
 * else `text` without the leading reply mentions that `display_text_range`
 * hides; t.co links expanded, the media link dropped, entities decoded.
 */
function tweetText(json: Json): string | null {
    const note = isObject(json.note_tweet)
        ? (json.note_tweet as Json).note_tweet_results
        : undefined;
    const noteResult = isObject(note) ? note.result : undefined;
    const noteText = isObject(noteResult) ? str(noteResult.text) : null;

    let text = noteText ?? str(json.text);
    if (text === null) return null;

    const urls = urlEntities(json.entities);
    if (noteText !== null && isObject(noteResult)) {
        urls.push(...urlEntities(noteResult.entity_set));
    } else {
        // Indices count code points, but are not reliable around escaped
        // entities: only cut what is plainly reply mentions at the start or
        // t.co links (the attached media) at the end.
        const range = arr(json.display_text_range);
        const chars = Array.from(text);
        const start = typeof range[0] === 'number' ? range[0] : 0;
        const end = typeof range[1] === 'number' ? range[1] : chars.length;
        const tail = chars.slice(end).join('');
        if (/^(?:\s*https:\/\/t\.co\/\w+)+\s*$/.test(tail)) {
            chars.splice(end);
        }
        const prefix = chars.slice(0, start).join('');
        if (start > 0 && /^(?:@\w+\s*)+$/.test(prefix)) {
            chars.splice(0, start);
        }
        text = chars.join('');
    }

    for (const link of mediaLinks(json)) {
        text = text.split(link).join('');
    }
    for (const { url, expanded } of urls) {
        text = text.split(url).join(expanded);
    }
    const plain = decodeEntities(text).trim();
    return plain === '' ? null : plain;
}

/** The image URL with Twitter's `name` size parameter set. */
function sizedImageUrl(url: string, size: string): string {
    try {
        const parsed = new URL(url);
        parsed.searchParams.set('name', size);
        return parsed.toString();
    } catch {
        return url;
    }
}

/** One `mediaDetails` entry as {@link TweetMedia}, or null when unusable. */
function parseMedia(entry: unknown): TweetMedia | null {
    if (!isObject(entry)) return null;
    const type = entry.type;
    if (type === 'photo') {
        const url = str(entry.media_url_https);
        if (!url) return null;
        return {
            kind: 'image',
            urls: [sizedImageUrl(url, 'large'), sizedImageUrl(url, 'medium')],
            durationSeconds: null,
        };
    }
    if (type !== 'video' && type !== 'animated_gif') return null;
    const info = isObject(entry.video_info) ? entry.video_info : {};
    const variants = arr(info.variants)
        .filter(isObject)
        .filter(
            (variant) =>
                variant.content_type === 'video/mp4' && str(variant.url)
        )
        .map((variant) => ({
            url: variant.url as string,
            bitrate: typeof variant.bitrate === 'number' ? variant.bitrate : 0,
        }))
        .sort((a, b) => b.bitrate - a.bitrate);
    if (variants.length === 0) return null;
    const millis = info.duration_millis;
    return {
        kind: 'video',
        urls: [...new Set(variants.map((variant) => variant.url))],
        durationSeconds:
            typeof millis === 'number' && millis > 0 ? millis / 1000 : null,
    };
}

/**
 * Parses a syndication `tweet-result` JSON body, or null when it is not a
 * tweet (tombstones, empty objects and anything without an id).
 */
export function parseTweetResult(json: unknown): SyndicatedTweet | null {
    if (!isObject(json) || isMissing(json)) return null;
    if (json.__typename !== undefined && json.__typename !== 'Tweet') {
        return null;
    }
    const id = str(json.id_str);
    if (!id) return null;

    const user = isObject(json.user) ? json.user : {};
    const media = arr(json.mediaDetails)
        .map(parseMedia)
        .filter((item): item is TweetMedia => item !== null)
        .slice(0, MAX_TWEET_MEDIA);

    return {
        id,
        screenName: str(user.screen_name),
        name: str(user.name),
        profileImageUrl: str(user.profile_image_url_https),
        text: tweetText(json),
        media,
    };
}
