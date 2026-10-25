/**
 * Digest mode of the `history` command (issue #16): instead of one copy per
 * source message, many messages are packed into transcript posts, each line
 * headed by the author and the original time. Pure functions over the
 * payloads the live relay would have posted; sanitising already happened in
 * the transformer, so nothing is escaped here.
 */

import {
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
    embedCharCount,
} from '../../utils/embeds';
import { truncateKeepingSpoilers } from '../../utils/spoilers';
import WebhookEmbed from '../WebhookEmbed';
import { WebhookAttachment, WebhookMessageData } from '../WebhookService';

/** Longest message content on both platforms. */
export const DIGEST_MAX_CHARS = 2000;
/** Most attachments one webhook message carries on both platforms. */
export const DIGEST_MAX_FILES = 10;
/** Entries in a post are separated by a blank line. */
export const DIGEST_ENTRY_SEPARATOR = '\n\n';

/** One source message to pack: its bridged payload plus header data. */
export interface DigestEntry {
    sourceId: string;
    authorName: string;
    createdAt: Date;
    payload: WebhookMessageData;
}

export interface DigestLimits {
    /** Most characters of content per post (default {@link DIGEST_MAX_CHARS}). */
    maxChars?: number;
    /** Most attachments per post (default {@link DIGEST_MAX_FILES}). */
    maxFiles?: number;
    /** Most embeds per post (default {@link EMBEDS_PER_MESSAGE_MAX}). */
    maxEmbeds?: number;
    /** Most summed embed characters per post (default {@link EMBED_TOTAL_CHARS_MAX}). */
    maxEmbedChars?: number;
}

/** One destination message and the source messages it contains. */
export interface DigestPost {
    payload: WebhookMessageData;
    sourceIds: string[];
}

/** `<t:unix:f>` for the date, rendered as a localised timestamp by both platforms. */
export function timestampTag(date: Date): string {
    return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}

/** The subtext header line of an entry: author and, with `timestamps`, the original time. */
export function digestHeader(entry: DigestEntry, timestamps: boolean): string {
    const author = `-# **${entry.authorName}**`;
    return timestamps ? `${author} · ${timestampTag(entry.createdAt)}` : author;
}

function attachmentNote(attachment: WebhookAttachment): string {
    return `📎 ${attachment.name}`;
}

function digestText(
    entry: DigestEntry,
    timestamps: boolean,
    content: string,
    attachments: WebhookAttachment[]
): string {
    const lines = [digestHeader(entry, timestamps)];
    if (content !== '') lines.push(content);
    for (const attachment of attachments)
        lines.push(attachmentNote(attachment));
    return lines.join('\n');
}

/**
 * The untruncated transcript text of one entry: the header, the content on
 * the following line(s) and a `📎 name` note per attachment.
 */
export function formatDigestLine(
    entry: DigestEntry,
    timestamps: boolean
): string {
    return digestText(
        entry,
        timestamps,
        entry.payload.content,
        entry.payload.attachments ?? []
    );
}

/**
 * `text` cut to at most `max` characters, ending with an ellipsis when cut.
 * A spoiler cut in half is closed again so its text stays hidden.
 */
export function truncateText(text: string, max: number): string {
    return truncateKeepingSpoilers(text, max);
}

/** Characters the embed counts towards the per-message total. */
function webhookEmbedChars(embed: WebhookEmbed): number {
    return embedCharCount({ data: embed.toPlainObject() });
}

interface ResolvedLimits {
    maxChars: number;
    maxFiles: number;
    maxEmbeds: number;
    maxEmbedChars: number;
}

/** An entry cut down so that it always fits in a post of its own. */
interface Piece {
    sourceId: string;
    text: string;
    files: WebhookAttachment[];
    embeds: WebhookEmbed[];
    embedChars: number;
}

function fitEntry(
    entry: DigestEntry,
    timestamps: boolean,
    limits: ResolvedLimits
): Piece {
    const files = (entry.payload.attachments ?? []).slice(0, limits.maxFiles);

    const embeds: WebhookEmbed[] = [];
    let embedChars = 0;
    for (const embed of entry.payload.embeds ?? []) {
        const chars = webhookEmbedChars(embed);
        if (
            embeds.length >= limits.maxEmbeds ||
            embedChars + chars > limits.maxEmbedChars
        ) {
            break;
        }
        embeds.push(embed);
        embedChars += chars;
    }

    let text = digestText(entry, timestamps, entry.payload.content, files);
    if (text.length > limits.maxChars) {
        // Cut the content first, keeping the header and attachment notes.
        const skeleton = digestText(entry, timestamps, '', files);
        const available = limits.maxChars - skeleton.length - '\n'.length;
        const content =
            available >= 2
                ? truncateText(entry.payload.content, available)
                : '';
        text = digestText(entry, timestamps, content, files);
        if (text.length > limits.maxChars) {
            // Header and notes alone are too long: cut the whole text.
            text = truncateText(text, limits.maxChars);
        }
    }

    return { sourceId: entry.sourceId, text, files, embeds, embedChars };
}

/**
 * Packs `entries` (in order) into as few posts as the limits allow: a post
 * is flushed when adding the next entry would exceed `maxChars` of content,
 * `maxFiles` attachments, `maxEmbeds` embeds or `maxEmbedChars`. An entry
 * that alone exceeds a limit is truncated (content cut with `…`, extra
 * attachments and embeds dropped) so it fits in a post of its own.
 * Attachments ride along as files so they are re-uploaded rather than
 * linked. Every post is sent as `identity` and never pings anyone.
 */
export function packDigest(
    entries: DigestEntry[],
    identity: { username: string; avatarURL: string },
    timestamps: boolean,
    limits: DigestLimits = {}
): DigestPost[] {
    const resolved: ResolvedLimits = {
        maxChars: limits.maxChars ?? DIGEST_MAX_CHARS,
        maxFiles: limits.maxFiles ?? DIGEST_MAX_FILES,
        maxEmbeds: limits.maxEmbeds ?? EMBEDS_PER_MESSAGE_MAX,
        maxEmbedChars: limits.maxEmbedChars ?? EMBED_TOTAL_CHARS_MAX,
    };

    const posts: DigestPost[] = [];
    let texts: string[] = [];
    let chars = 0;
    let files: WebhookAttachment[] = [];
    let embeds: WebhookEmbed[] = [];
    let embedChars = 0;
    let sourceIds: string[] = [];

    const flush = () => {
        if (texts.length === 0) return;
        posts.push({
            payload: {
                content: texts.join(DIGEST_ENTRY_SEPARATOR),
                username: identity.username,
                avatarURL: identity.avatarURL,
                ...(files.length > 0 ? { attachments: files } : {}),
                ...(embeds.length > 0 ? { embeds } : {}),
                suppressMentions: true,
            },
            sourceIds,
        });
        texts = [];
        chars = 0;
        files = [];
        embeds = [];
        embedChars = 0;
        sourceIds = [];
    };

    for (const entry of entries) {
        const piece = fitEntry(entry, timestamps, resolved);
        if (texts.length > 0) {
            const addition = DIGEST_ENTRY_SEPARATOR.length + piece.text.length;
            const fits =
                chars + addition <= resolved.maxChars &&
                files.length + piece.files.length <= resolved.maxFiles &&
                embeds.length + piece.embeds.length <= resolved.maxEmbeds &&
                embedChars + piece.embedChars <= resolved.maxEmbedChars;
            if (!fits) flush();
        }
        chars +=
            texts.length === 0
                ? piece.text.length
                : DIGEST_ENTRY_SEPARATOR.length + piece.text.length;
        texts.push(piece.text);
        files.push(...piece.files);
        embeds.push(...piece.embeds);
        embedChars += piece.embedChars;
        sourceIds.push(piece.sourceId);
    }
    flush();

    return posts;
}
