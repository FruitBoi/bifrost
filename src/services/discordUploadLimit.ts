import type { WebhookAttachment } from './WebhookService';

/** Upload limit for a whole webhook request in a guild without boosts (bytes). */
export const DISCORD_DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Discord's cap on message content length. */
const DISCORD_MAX_CONTENT_LENGTH = 2000;

/**
 * Upload limit in bytes for a guild with the given boost (premium) tier:
 * tier 2 raises it to 50 MiB, tier 3 to 100 MiB, everything else keeps the
 * 10 MiB default.
 */
export function discordUploadLimitForTier(
    premiumTier: number | null | undefined
): number {
    switch (premiumTier) {
        case 2:
            return 50 * 1024 * 1024;
        case 3:
            return 100 * 1024 * 1024;
        default:
            return DISCORD_DEFAULT_UPLOAD_LIMIT;
    }
}

/**
 * Splits attachments into those that fit in one Discord upload and those that
 * must be linked instead. Discord limits the whole request, so attachments are
 * taken in order while the running total stays within `limitBytes`; unknown
 * sizes (stickers, ...) count as 0. Relative order is kept in both lists.
 */
export function splitOversizedAttachments(
    attachments: WebhookAttachment[],
    limitBytes: number
): { upload: WebhookAttachment[]; linked: WebhookAttachment[] } {
    const upload: WebhookAttachment[] = [];
    const linked: WebhookAttachment[] = [];
    let total = 0;
    for (const attachment of attachments) {
        const size = attachment.size ?? 0;
        if (total + size <= limitBytes) {
            upload.push(attachment);
            total += size;
        } else {
            linked.push(attachment);
        }
    }
    return { upload, linked };
}

/**
 * Appends the URL of each linked attachment on its own line so Discord unfurls
 * it (bare, never `<...>`, which would suppress the embed; spoilers become
 * `||url||`). When the result would exceed `maxLength`, the original content
 * is trimmed and ends with `…` so every link fits; if the links alone are too
 * long, as many whole links as fit are kept.
 */
export function appendAttachmentLinks(
    content: string,
    linked: WebhookAttachment[],
    maxLength = DISCORD_MAX_CONTENT_LENGTH
): string {
    if (linked.length === 0) return content;

    const links = linked.map((attachment) =>
        attachment.spoiler ? `||${attachment.url}||` : attachment.url
    );
    const linksText = links.join('\n');
    const hasContent = content.trim() !== '';

    if (hasContent) {
        const combined = `${content}\n${linksText}`;
        if (combined.length <= maxLength) return combined;

        // Room left for the content once the links, the separating newline
        // and the ellipsis are in.
        const budget = maxLength - linksText.length - 2;
        if (budget > 0) {
            return `${content.slice(0, budget).trimEnd()}…\n${linksText}`;
        }
    }

    if (linksText.length <= maxLength) return linksText;

    const kept: string[] = [];
    let length = 0;
    for (const link of links) {
        const added = kept.length === 0 ? link.length : link.length + 1;
        if (length + added > maxLength) break;
        kept.push(link);
        length += added;
    }
    return kept.join('\n');
}
