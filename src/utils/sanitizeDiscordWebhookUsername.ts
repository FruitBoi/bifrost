/**
 * Discord rejects webhook usernames that contain certain substrings
 * (`USERNAME_INVALID_CONTAINS`, case-insensitive) or that are empty or
 * longer than 80 characters. Relayed Fluxer display names can contain any of
 * these, so the name is rewritten rather than letting the whole message fail.
 */

const FORBIDDEN_SUBSTRINGS = ['discord', 'clyde'];
const MAX_LENGTH = 80;
const FALLBACK = 'Bifröst user';

/** Replace a forbidden substring with a look-alike that Discord accepts. */
function obscure(match: string): string {
    // Swap the second character for its Unicode look-alike so the name still
    // reads naturally (e.g. "discord" -> "dіscord").
    const lookalikes: Record<string, string> = {
        i: 'і', // Cyrillic small i
        l: 'ӏ', // Cyrillic palochka
    };
    const second = match[1];
    const replacement = lookalikes[second.toLowerCase()];
    if (!replacement) return match;
    return (
        match[0] +
        (second === second.toUpperCase()
            ? replacement.toUpperCase()
            : replacement) +
        match.slice(2)
    );
}

export function sanitizeDiscordWebhookUsername(username: string): string {
    let name = username;
    for (const word of FORBIDDEN_SUBSTRINGS) {
        name = name.replace(new RegExp(word, 'gi'), obscure);
    }
    name = name.trim().slice(0, MAX_LENGTH).trim();
    return name.length > 0 ? name : FALLBACK;
}
