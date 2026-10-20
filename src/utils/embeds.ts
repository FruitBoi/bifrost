export const EmbedColors = {
    Success: 0x57f287,
    Error: 0xed4245,
    Warning: 0xfee75c,
    Info: 0x9b59b6,
} as const;

const EMBED_DESCRIPTION_MAX = 4092;

export function chunkDescriptionLines(
    lines: string[],
    separator = '\n\n',
    maxLength = EMBED_DESCRIPTION_MAX
): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLength = 0;

    for (const line of lines) {
        const addition =
            current.length === 0 ? line.length : separator.length + line.length;
        if (current.length > 0 && currentLength + addition > maxLength) {
            chunks.push(current);
            current = [line];
            currentLength = line.length;
        } else {
            current.push(line);
            currentLength += addition;
        }
    }

    if (current.length > 0) chunks.push(current);

    return chunks;
}

/** Discord and Fluxer both allow at most this many embeds in one message. */
export const EMBEDS_PER_MESSAGE_MAX = 10;
/**
 * Discord and Fluxer both cap the characters of one message's embeds, summed over every
 * embed's title, description, footer text, author name and field names/values, at 6000.
 */
export const EMBED_TOTAL_CHARS_MAX = 6000;

interface EmbedCharData {
    title?: string | null;
    description?: string | null;
    footer?: { text?: string | null } | null;
    author?: { name?: string | null } | null;
    fields?: ReadonlyArray<{ name: string; value: string }> | null;
}

/** Any embed builder exposing its partial payload as `data` (discord.js and fluxerjs both do). */
export interface EmbedLike {
    readonly data: EmbedCharData;
}

/** Characters this embed counts towards the per-message total. */
export function embedCharCount(embed: EmbedLike): number {
    const d = embed.data;
    return (
        (d.title?.length ?? 0) +
        (d.description?.length ?? 0) +
        (d.footer?.text?.length ?? 0) +
        (d.author?.name?.length ?? 0) +
        (d.fields ?? []).reduce(
            (sum, field) => sum + field.name.length + field.value.length,
            0
        )
    );
}

/**
 * Split embeds into batches that each fit in one message: at most `maxEmbeds` embeds and at
 * most `maxTotalChars` characters (see {@link embedCharCount}). Order is preserved, so a title
 * on the first embed stays in the first batch and a footer on the last stays in the last.
 * Send the first batch as the reply and the rest as follow-up messages.
 */
export function batchEmbeds<E extends EmbedLike>(
    embeds: E[],
    maxTotalChars = EMBED_TOTAL_CHARS_MAX,
    maxEmbeds = EMBEDS_PER_MESSAGE_MAX
): E[][] {
    const batches: E[][] = [];
    let current: E[] = [];
    let currentChars = 0;

    for (const embed of embeds) {
        const chars = embedCharCount(embed);
        if (
            current.length > 0 &&
            (current.length >= maxEmbeds ||
                currentChars + chars > maxTotalChars)
        ) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(embed);
        currentChars += chars;
    }

    if (current.length > 0) batches.push(current);

    return batches;
}
