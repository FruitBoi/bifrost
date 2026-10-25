/**
 * Spoiler markup (`||hidden||`) is the same on Discord and Fluxer. Cutting
 * text inside a spoiler drops its closing `||`, and both clients then render
 * the rest as plain text, revealing it. Every cut of relayed text that may
 * contain spoilers goes through {@link truncateKeepingSpoilers}.
 */

export const SPOILER_MARKER = '||';

const ELLIPSIS = '…';

interface SpoilerScan {
    /** The text ends inside a spoiler (an unmatched `||`). */
    open: boolean;
    /**
     * The text ends in a lone `|` or `\` that would merge with, or escape,
     * an appended closing marker.
     */
    dangling: boolean;
}

/** Walks the `||` markers of `text`; backslash-escaped pipes do not count. */
function scanSpoilers(text: string): SpoilerScan {
    let open = false;
    let dangling = false;
    for (let i = 0; i < text.length; i++) {
        const last = i === text.length - 1;
        dangling = false;
        if (text[i] === '\\') {
            dangling = last;
            i++;
        } else if (text[i] === '|') {
            if (text[i + 1] === '|') {
                open = !open;
                i++;
            } else {
                dangling = last;
            }
        }
    }
    return { open, dangling };
}

/** Whether `text` ends inside an unclosed `||spoiler`. */
export function endsInsideSpoiler(text: string): boolean {
    return scanSpoilers(text).open;
}

/**
 * `text` cut to at most `max` characters, ending with an ellipsis when cut.
 * A spoiler the cut lands in is closed after the ellipsis (`||sec…||`), so
 * the hidden text stays hidden. Never splits a surrogate pair.
 */
export function truncateKeepingSpoilers(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 0) return '';
    for (let room = max - ELLIPSIS.length; room >= 0; room--) {
        let head = text.slice(0, room);
        // Half an emoji would render as a replacement character.
        if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
        head = head.trimEnd();
        let scan = scanSpoilers(head);
        while (scan.dangling) {
            head = head.slice(0, -1).trimEnd();
            scan = scanSpoilers(head);
        }
        if (!scan.open) return head + ELLIPSIS;
        const closed = `${head}${ELLIPSIS}${SPOILER_MARKER}`;
        if (closed.length <= max) return closed;
    }
    return ELLIPSIS.slice(0, max);
}
