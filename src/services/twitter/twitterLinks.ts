/**
 * Finds Twitter/X tweet links in a chat message (issue #56).
 *
 * Recognised shapes are `/<username>/status/<id>`, `/<username>/statuses/<id>`,
 * `/i/status/<id>` and `/i/web/status/<id>`, with any `/photo/<n>`, `/en`,
 * query or fragment suffix. They count on twitter.com and x.com (optionally
 * `www.`, `mobile.` or `m.`), on the known embed-fixer and alternative-frontend
 * aliases (fxtwitter, fixvx, ...), and on hosts discovered at runtime
 * (`extraHosts`). With `includeUnknownHosts`, any other host that merely has the
 * `/<username>/status/<id>` shape is returned as an unverified candidate
 * (`knownHost: false`) so the caller can discover new alias sites. Links
 * wrapped in `<...>` and links inside code are skipped. Pure: no network.
 */

import { SPOILER_MARKER } from '../../utils/spoilers';

export interface TweetLink {
    /** Canonical URL: https://x.com/<username>/status/<id> (or https://x.com/i/status/<id> when no username). */
    url: string;
    /** Numeric tweet id as a string. */
    id: string;
    /** Username from the path (without @, original case), or null for /i/status/ and /i/web/status/ links. */
    username: string | null;
    /** Lower-cased host the link was posted on, without a leading "www." (e.g. "fixvx.com"). */
    host: string;
    /** True when host is twitter.com/x.com or a known embed-fixer alias (or in extraHosts); false for an unknown host that merely has the tweet path shape and must be verified before use. */
    knownHost: boolean;
    /** True when the link sat inside a ||spoiler||. */
    spoiler: boolean;
}

/** Hosts (lower-case, no www.) treated as Twitter: twitter.com, x.com and embed-fixer/alternative-frontend aliases. */
export const KNOWN_TWITTER_HOSTS: ReadonlySet<string> = new Set([
    'twitter.com',
    'x.com',
    'fxtwitter.com',
    'fixupx.com',
    'vxtwitter.com',
    'fixvx.com',
    'twittpr.com',
    'stupidpenisx.com',
    'girlcockx.com',
    'xcancel.com',
    'nitter.net',
    'nitter.poast.org',
    'nitter.privacydev.net',
]);

/** Embed-fixer domains whose subdomains (d., g., api., ...) are fixer endpoints too. */
const FIXER_DOMAINS = [
    'fxtwitter.com',
    'fixupx.com',
    'vxtwitter.com',
    'fixvx.com',
];

/**
 * A tweet URL up to the end of its token. Group 1 is the host, group 2 the
 * username (or `i`), group 3 the id for the username shape; group 4 is the id
 * of the `/i/(web/)status/` shape. The token stops at whitespace, `<`, `>` and
 * `|`, so `||url||` and `<url>` leave their markup outside the match.
 */
const TWEET_URL_RE =
    /https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?\/(?:([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})|i\/web\/status\/(\d{1,20}))(?![A-Za-z0-9_])(?:[/?#][^\s<>|]*)?/gi;

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

/** `host` lower-cased with a leading `www.`, `mobile.` or `m.` removed. */
function stripPrefix(host: string): string {
    return host.toLowerCase().replace(/^(?:www\.|mobile\.|m\.)/, '');
}

/** True for a dotted-number host (an IPv4 literal) or one without a letter TLD. */
function looksLikeIp(host: string): boolean {
    const tld = host.slice(host.lastIndexOf('.') + 1);
    return !/[a-z]/i.test(tld);
}

/** True when `host` (any case, optional www./mobile./m. prefix) is a known Twitter host or one of `extraHosts`, also matching subdomains of fixer sites such as d.fxtwitter.com, g.fxtwitter.com, d.vxtwitter.com. */
export function isKnownTwitterHost(
    host: string,
    extraHosts?: ReadonlySet<string>
): boolean {
    const bare = stripPrefix(host.trim());
    if (KNOWN_TWITTER_HOSTS.has(bare) || extraHosts?.has(bare)) return true;
    return FIXER_DOMAINS.some((domain) => bare.endsWith(`.${domain}`));
}

/** Tweet links in `content`, deduplicated by tweet id, in order, at most `max`. */
export function findTweetLinks(
    content: string,
    max: number,
    options: {
        extraHosts?: ReadonlySet<string>;
        includeUnknownHosts?: boolean;
    } = {}
): TweetLink[] {
    if (!content || max <= 0) return [];

    const text = blankCode(content);
    const spoilers = spoilerRanges(text);
    const links: TweetLink[] = [];
    const seen = new Set<string>();

    const re = new RegExp(TWEET_URL_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null && links.length < max) {
        const start = match.index;
        const end = start + match[0].length;

        // `<url>` suppresses the embed; the poster asked for no preview.
        if (text[start - 1] === '<' && text[end] === '>') continue;

        // The scheme must start a word, so `xhttps://...` is not a link.
        if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue;

        const host = match[1].toLowerCase().replace(/^www\./, '');
        if (looksLikeIp(host)) continue;

        const id = match[3] ?? match[4];
        // `i` alone is not a username: `/i/status/<id>` has none.
        const username =
            match[2] && match[2].toLowerCase() !== 'i' ? match[2] : null;

        const knownHost = isKnownTwitterHost(host, options.extraHosts);
        if (!knownHost && (!options.includeUnknownHosts || !username)) continue;

        if (seen.has(id)) continue;
        seen.add(id);

        const url = `https://x.com/${username ?? 'i'}/status/${id}`;
        const spoiler = spoilers.some(
            ([from, to]) => start >= from && end <= to
        );
        links.push({ url, id, username, host, knownHost, spoiler });
    }
    return links;
}
