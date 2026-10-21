import type { ExpressionOutcome } from './ExpressionTransferService';

/**
 * Pure helpers for the expression transfer: Fluxer's validation rules for
 * names, descriptions and tags, the dedup/skip planning, data-URL building
 * and chunking. Kept free of I/O so they can be unit-tested directly.
 */

/** Items per bulk request: keeps bodies at ~10 × 500 KB of base64 at most. */
export const BULK_CHUNK_SIZE = 10;

const EMOJI_NAME_MIN = 2;
const EMOJI_NAME_MAX = 32;
const STICKER_NAME_MIN = 2;
const STICKER_NAME_MAX = 30;
const STICKER_DESCRIPTION_MAX = 500;
const STICKER_TAG_MAX_LENGTH = 30;
const STICKER_TAGS_MAX = 10;

const EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Why a name cannot be used for a Fluxer emoji, or null when it can.
 * Fluxer accepts 2–32 ASCII letters, digits and underscores (after trimming).
 */
export function emojiNameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed.length < EMOJI_NAME_MIN || trimmed.length > EMOJI_NAME_MAX) {
        return `must be ${EMOJI_NAME_MIN}–${EMOJI_NAME_MAX} characters`;
    }
    if (!EMOJI_NAME_PATTERN.test(trimmed)) {
        return 'may only contain ASCII letters, digits and underscores';
    }
    return null;
}

export function isValidFluxerEmojiName(name: string): boolean {
    return emojiNameProblem(name) === null;
}

/**
 * Why a name cannot be used for a Fluxer sticker, or null when it can.
 * Fluxer accepts 2–30 characters after trimming.
 */
export function stickerNameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (
        trimmed.length < STICKER_NAME_MIN ||
        trimmed.length > STICKER_NAME_MAX
    ) {
        return `must be ${STICKER_NAME_MIN}–${STICKER_NAME_MAX} characters`;
    }
    return null;
}

export function isValidFluxerStickerName(name: string): boolean {
    return stickerNameProblem(name) === null;
}

/**
 * Fluxer wants a sticker description of 1–500 trimmed characters or null;
 * Discord's can be null or empty, so empty ones become null.
 */
export function normalizeStickerDescription(
    description: string | null | undefined
): string | null {
    const trimmed = (description ?? '').trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, STICKER_DESCRIPTION_MAX);
}

/**
 * Discord stores sticker tags as one string (usually a single emoji name,
 * occasionally comma-separated); Fluxer wants up to 10 strings of 1–30
 * characters.
 */
export function normalizeStickerTags(
    tags: string | null | undefined
): string[] {
    if (!tags) return [];
    return tags
        .split(',')
        .map((tag) => tag.trim().slice(0, STICKER_TAG_MAX_LENGTH))
        .filter((tag) => tag.length > 0)
        .slice(0, STICKER_TAGS_MAX);
}

/** The minimum a source expression must carry to be planned. */
export interface PlannableExpression {
    id: string;
    name: string;
}

export interface TransferPlan<T extends PlannableExpression> {
    /** Items to upload, in a stable order (by name, then id). */
    upload: T[];
    /** Items not uploaded, with the reason, in the same stable order. */
    skipped: ExpressionOutcome[];
}

export interface PlanTransferOptions<T extends PlannableExpression> {
    /** Why the item cannot be transferred at all (unavailable, Lottie…). */
    untransferableReason?: (item: T) => string | null;
    /** Why the (trimmed) name is invalid on Fluxer, or null when valid. */
    nameProblem: (name: string) => string | null;
}

/**
 * Decides which source expressions to upload. Items are visited by name then
 * id so re-runs and reports are deterministic. An item is skipped when it
 * cannot be transferred, when its name is invalid for Fluxer, when the
 * Fluxer guild already has that exact (case-sensitive) name, or when an
 * earlier item of this run already claimed the name. Exact comparison is
 * the rule message and reaction bridging use to match custom emojis.
 */
export function planTransfer<T extends PlannableExpression>(
    sources: readonly T[],
    existingNames: Iterable<string>,
    { untransferableReason, nameProblem }: PlanTransferOptions<T>
): TransferPlan<T> {
    const existing = new Set(existingNames);
    const claimed = new Set<string>();
    const upload: T[] = [];
    const skipped: ExpressionOutcome[] = [];

    const ordered = [...sources].sort(
        (a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id)
    );

    for (const item of ordered) {
        const name = item.name.trim();
        const untransferable = untransferableReason?.(item) ?? null;
        if (untransferable) {
            skipped.push({ name: item.name, reason: untransferable });
            continue;
        }
        const problem = nameProblem(name);
        if (problem) {
            skipped.push({
                name: item.name,
                reason: `invalid name for Fluxer: ${problem}`,
            });
            continue;
        }
        if (existing.has(name)) {
            skipped.push({ name, reason: 'already exists on Fluxer' });
            continue;
        }
        if (claimed.has(name)) {
            skipped.push({ name, reason: 'duplicate name on Discord' });
            continue;
        }
        claimed.add(name);
        upload.push(item);
    }

    return { upload, skipped };
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    png: 'image/png',
    apng: 'image/apng',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    jxl: 'image/jxl',
    svg: 'image/svg+xml',
    json: 'application/json',
};

const FALLBACK_MIME = 'application/octet-stream';

/**
 * Picks the media type for a downloaded image: the response's `Content-Type`
 * when it is an image type (parameters stripped), else a guess from the
 * URL's extension, else `application/octet-stream`. Fluxer sniffs the real
 * format from the bytes anyway, so the prefix only has to be plausible.
 */
export function pickImageMime(
    contentType: string | null | undefined,
    url: string
): string {
    const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (declared.startsWith('image/')) return declared;

    const extension = extensionOf(url);
    if (extension && MIME_BY_EXTENSION[extension]) {
        return MIME_BY_EXTENSION[extension];
    }
    return FALLBACK_MIME;
}

function extensionOf(url: string): string | null {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url.split(/[?#]/)[0];
    }
    const lastSegment = pathname.split('/').pop() ?? '';
    const dot = lastSegment.lastIndexOf('.');
    if (dot <= 0 || dot === lastSegment.length - 1) return null;
    return lastSegment.slice(dot + 1).toLowerCase();
}

/**
 * Builds the `data:<mime>;base64,<...>` string Fluxer's create endpoints
 * take as `image` (the server strips everything up to the first comma).
 */
export function toDataUrl(
    bytes: Buffer,
    contentType: string | null | undefined,
    url: string
): string {
    return `data:${pickImageMime(contentType, url)};base64,${bytes.toString('base64')}`;
}

/** Splits `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    if (!Number.isInteger(size) || size <= 0) {
        throw new RangeError(`chunk size must be a positive integer: ${size}`);
    }
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}
