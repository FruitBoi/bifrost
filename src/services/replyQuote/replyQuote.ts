import { MessagePlatform } from '../../db/entities/MessageLink';
import WebhookEmbed from '../WebhookEmbed';

/** Discord and Fluxer both cap message content at 2000 characters. */
export const MAX_CONTENT_LENGTH = 2000;

/** Visible characters of the replied-to text kept in the quote line. */
export const QUOTE_SNIPPET_LENGTH = 100;

/** Stands in for spoilered text so a truncated quote cannot reveal it. */
const SPOILER_PLACEHOLDER = '▒▒▒▒▒';

/**
 * Tokens that must reach the client verbatim: escaping them would break
 * custom emoji (`<:a_b:1>`), timestamps and URLs, and cutting them in half
 * would leave raw markup.
 */
const VERBATIM_TOKEN =
    /<a?:\w+:\d+>|<t:-?\d+(?::[tTdDfFR])?>|<https?:\/\/[^\s>]+>|https?:\/\/\S+/;

/** Markdown that could leak out of the quote line (code spans, spoilers…). */
const MARKDOWN_CHARS = /[\\`*_~|[\]]/g;

/** The reply quote of a relayed message, in both of its possible forms. */
export interface ReplyQuote {
    /** Subtext line prepended to the content (the preferred form). */
    line: string;
    /** Used instead when content plus line would exceed the length limit. */
    embed: WebhookEmbed;
}

export function messageUrl(
    platform: MessagePlatform,
    guildId: string,
    channelId: string,
    messageId: string
): string {
    const host = platform === 'discord' ? 'discord.com' : 'fluxer.app';
    return `https://${host}/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * Backslash-escapes markdown so text renders literally. Both clients hide
 * the backslashes, so names and quotes read naturally.
 */
export function escapeMarkdown(text: string): string {
    return text.replace(MARKDOWN_CHARS, '\\$&');
}

/**
 * Turns replied-to text into a short single-line snippet: spoilers are
 * hidden, whitespace (including newlines, which would end the subtext line)
 * is collapsed, it is cut to {@link QUOTE_SNIPPET_LENGTH} characters with an
 * ellipsis, and markdown is escaped so an unbalanced code span or spoiler
 * cannot swallow the message below it.
 */
export function formatQuoteSnippet(text: string): string {
    const collapsed = text
        .replace(/\|\|[\s\S]+?\|\|/g, SPOILER_PLACEHOLDER)
        .replace(/\s+/g, ' ')
        .trim();

    const parts: string[] = [];
    let remaining = QUOTE_SNIPPET_LENGTH;
    let truncated = false;
    const appendText = (segment: string) => {
        const chars = Array.from(segment);
        if (chars.length > remaining) {
            chars.length = remaining;
            truncated = true;
        }
        remaining -= chars.length;
        parts.push(escapeMarkdown(chars.join('')));
    };

    const tokens = new RegExp(VERBATIM_TOKEN.source, 'g');
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(collapsed)) !== null) {
        appendText(collapsed.slice(last, match.index));
        if (truncated) break;
        const token = match[0];
        if (token.length > remaining) {
            truncated = true;
            break;
        }
        remaining -= token.length;
        // `<url>` keeps the quoted link from unfurling a second preview.
        parts.push(token.startsWith('http') ? `<${token}>` : token);
        last = match.index + token.length;
    }
    if (!truncated) appendText(collapsed.slice(last));

    const snippet = parts.join('');
    return truncated ? `${snippet.trimEnd()}…` : snippet;
}

/**
 * `-# ↩️ [**name**](<url>) snippet`: a subtext line that mimics the native
 * reply header. `<url>` keeps Discord from unfurling the link; Fluxer's
 * parser accepts the same form. Without a URL the name is plain bold.
 */
export function buildReplyQuoteLine(
    authorName: string,
    url: string | null,
    snippet: string
): string {
    const name = `**${escapeMarkdown(authorName)}**`;
    const author = url ? `[${name}](<${url}>)` : name;
    return `-# ↩️ ${author} ${snippet}`;
}

export function createReplyQuote(options: {
    authorName: string;
    authorIconURL?: string;
    url: string | null;
    /** Sanitized replied-to text; null when the message has no text. */
    text: string | null;
    /** Shown instead of text for a replied-to message without text. */
    textlessDescription: string;
    color: number;
}): ReplyQuote {
    const snippet =
        options.text !== null
            ? formatQuoteSnippet(options.text)
            : options.textlessDescription;
    return {
        line: buildReplyQuoteLine(options.authorName, options.url, snippet),
        embed: new WebhookEmbed({
            description: options.text ?? options.textlessDescription,
            color: options.color,
            author: {
                name: `${options.authorName} ↩️`,
                url: options.url ?? undefined,
                iconURL: options.authorIconURL,
            },
            timestamp: null,
        }),
    };
}

/**
 * Puts the quote line above the content. Returns null when the result would
 * not fit in a message; the caller then falls back to the quote embed.
 */
export function prependReplyQuote(
    content: string,
    quoteLine: string
): string | null {
    const combined = content ? `${quoteLine}\n${content}` : quoteLine;
    return combined.length <= MAX_CONTENT_LENGTH ? combined : null;
}

/**
 * Places the reply quote like a native reply header: as a line above the
 * content. When that would exceed the length limit the content is left
 * alone and the (linked) quote embed is put first among `embeds` instead.
 */
export function applyReplyQuote(
    content: string,
    quote: ReplyQuote,
    embeds: WebhookEmbed[]
): string {
    const quoted = prependReplyQuote(content, quote.line);
    if (quoted !== null) return quoted;
    embeds.unshift(quote.embed);
    return content;
}
