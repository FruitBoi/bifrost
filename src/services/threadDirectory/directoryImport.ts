import { parseChannelRef } from '../../utils/channelRef';

/** One thread line read from a pasted or linked directory message. */
export interface DirectoryImportItem {
    /** Channel or thread ID from a mention or link on the line; null when none. */
    channelId: string | null;
    /** Visible name of the thread on the line (link text or plain name); null when unknown. */
    name: string | null;
    /** Description found on the line; null when none. */
    description: string | null;
    /** Role ID of a role mention on the line; null when none. */
    roleId: string | null;
}

const ID = '\\d{15,25}';
const ROLE_MENTION_RE = new RegExp(`<@&(${ID})>`, 'g');
/**
 * A channel reference, tried at each position in this order: markdown link
 * (text in group 1, target in group 2), channel mention, bare or `<...>`
 * wrapped URL, raw ID.
 */
const REFERENCE_RE = new RegExp(
    `\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]+)>?\\s*\\)|<#${ID}>|<?https?://[^\\s<>)*~]+>?|(?<!\\d)${ID}(?!\\d)`,
    'g'
);
/** Block prefixes: quotes, headings, list bullets and numbering. */
const PREFIX_RE = /^\s*(?:>\s?|#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/;
/** Markdown emphasis markers; underscores only at word edges so `snake_case` survives. */
const EMPHASIS_RE = /\*+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
/** Separator between a name and a description on plain lines. */
const PLAIN_SEPARATOR_RE = /\s+[-–—|]\s+|:\s+/;
const TRAILING_SEPARATOR_RE = /\s*[-–—|:]\s*$/;
const LEADING_SEPARATOR_RE = /^\s*[-–—|:]\s*/;

/** Removes quote, heading and bullet prefixes (repeatedly) from a line. */
function stripPrefixes(line: string): string {
    let text = line.trim();
    for (let prev = ''; prev !== text; ) {
        prev = text;
        text = text.replace(PREFIX_RE, '').trim();
    }
    return text;
}

/** Removes markdown emphasis markers and trims. */
function stripEmphasis(text: string): string {
    return text.replace(EMPHASIS_RE, '').trim();
}

/** Trimmed text, or null when empty. */
function orNull(text: string): string | null {
    const trimmed = text.trim();
    return trimmed === '' ? null : trimmed;
}

/** Cleans the text before a reference: emphasis and the separator that trails it. */
function cleanBefore(text: string): string | null {
    return orNull(stripEmphasis(text).replace(TRAILING_SEPARATOR_RE, ''));
}

/** Cleans the text after a reference: emphasis and the separator that leads it. */
function cleanAfter(text: string): string | null {
    return orNull(stripEmphasis(text).replace(LEADING_SEPARATOR_RE, ''));
}

/** The first match of REFERENCE_RE that points at a channel, with its ID. */
function findReference(
    text: string
): { match: RegExpMatchArray; channelId: string } | null {
    for (const match of text.matchAll(REFERENCE_RE)) {
        const channelId = parseChannelRef(match[2] ?? match[0]);
        if (channelId) return { match, channelId };
    }
    return null;
}

/** Link text as a name, unless it is empty or itself just a reference. */
function linkName(text: string | undefined): string | null {
    if (text === undefined) return null;
    const name = stripEmphasis(text).replace(/^#/, '').trim();
    if (name === '' || parseChannelRef(name)) return null;
    return name;
}

/** Parses one line; null when it does not name a thread. */
function parseLine(rawLine: string): DirectoryImportItem | null {
    const line = stripPrefixes(rawLine);
    const roleId = [...line.matchAll(ROLE_MENTION_RE)][0]?.[1] ?? null;
    const text = line.replace(ROLE_MENTION_RE, '');

    const ref = findReference(text);
    if (ref) {
        const start = ref.match.index ?? 0;
        const before = cleanBefore(text.slice(0, start));
        const after = cleanAfter(text.slice(start + ref.match[0].length));
        return {
            channelId: ref.channelId,
            name: linkName(ref.match[1]),
            description: before ?? after,
            roleId,
        };
    }

    // No reference: only a `name - description` line counts, else it is a heading.
    const plain = stripEmphasis(text);
    const sep = PLAIN_SEPARATOR_RE.exec(plain);
    if (!sep) return null;
    const name = orNull(plain.slice(0, sep.index));
    const description = orNull(plain.slice(sep.index + sep[0].length));
    if (!name || !description) return null;
    return { channelId: null, name, description, roleId };
}

/**
 * Parses a directory message (hand-made, bot-made or pasted) into one item
 * per thread line. Blank lines, headings and unrecognisable lines are skipped.
 */
export function parseDirectoryImport(text: string): DirectoryImportItem[] {
    const items: DirectoryImportItem[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
        const item = parseLine(line);
        if (item) items.push(item);
    }
    return items;
}
