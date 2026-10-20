/**
 * LiveKit participant identities on Fluxer are *believed* to be bare Fluxer
 * user IDs, but that has never been confirmed live. These helpers map an
 * identity onto a known user ID best-effort so mute/leave bookkeeping (which
 * is keyed by Fluxer user ID) keeps working even if the identity carries a
 * prefix or suffix such as `userId:connectionId`.
 */

/** Separators an identity might use between its parts. */
const IDENTITY_DELIMITERS = /[:\-_./]+/;

/**
 * Returns the Fluxer user ID that `identity` refers to, or null when it
 * cannot be tied to any of `knownUserIds`.
 *
 * - An exact match wins.
 * - Otherwise the identity is split on `:`, `-`, `_`, `.` and `/` and the
 *   first token that is a known user ID is returned.
 */
export function mapIdentityToUserId(
    identity: string,
    knownUserIds: ReadonlySet<string>
): string | null {
    if (knownUserIds.size === 0) return null;
    if (knownUserIds.has(identity)) return identity;
    const tokens = identity.split(IDENTITY_DELIMITERS);
    if (tokens.length < 2) return null;
    for (const token of tokens) {
        if (token && knownUserIds.has(token)) return token;
    }
    return null;
}

/** True when `identity` is, or embeds, `userId` (see {@link mapIdentityToUserId}). */
export function identityRefersTo(
    identity: string,
    userId: string | null
): boolean {
    if (!userId) return false;
    return mapIdentityToUserId(identity, new Set([userId])) === userId;
}
