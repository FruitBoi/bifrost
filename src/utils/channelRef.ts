/**
 * Parsers for the ways users point at channels, threads, messages and roles
 * in command arguments: mentions, raw IDs and links (Discord or Fluxer, any
 * host with a `/channels/<guild>/<channel>[/<message>]` path).
 */

const ID = '\\d{15,25}';
const ID_RE = new RegExp(`^${ID}$`);
const CHANNEL_MENTION_RE = new RegExp(`^<#(${ID})>$`);
const ROLE_MENTION_RE = new RegExp(`^<@&(${ID})>$`);
/** `https://host/channels/<guild|@me>[/<channel>[/<message>]]`, optionally in `<...>`. */
const LINK_RE = new RegExp(
    `^<?https?://[^\\s/]+/channels/(${ID}|@me)(?:/(${ID})(?:/(${ID}))?)?/?(?:[?#]\\S*)?>?$`
);

export interface ParsedLink {
    /** Null for DM links (`@me`). */
    guildId: string | null;
    channelId: string | null;
    messageId: string | null;
}

/** The parts of a `/channels/...` link, or null when `arg` is not one. */
export function parseLink(arg: string | undefined | null): ParsedLink | null {
    if (!arg) return null;
    const match = LINK_RE.exec(arg.trim());
    if (!match) return null;
    return {
        guildId: match[1] === '@me' ? null : match[1],
        channelId: match[2] ?? null,
        messageId: match[3] ?? null,
    };
}

/**
 * The channel or thread ID in `arg`: a mention (`<#id>`), a raw ID, or a
 * channel/thread link (a message link yields its channel). Else null.
 */
export function parseChannelRef(arg: string | undefined | null): string | null {
    if (!arg) return null;
    const text = arg.trim();
    const mention = CHANNEL_MENTION_RE.exec(text);
    if (mention) return mention[1];
    if (ID_RE.test(text)) return text;
    return parseLink(text)?.channelId ?? null;
}

/**
 * Like `parseChannelRef`, but a guild link without a channel
 * (`/channels/<guild>`) yields the guild ID, for commands that accept a
 * guild or a channel.
 */
export function parseGuildOrChannelRef(
    arg: string | undefined | null
): string | null {
    const channelId = parseChannelRef(arg);
    if (channelId) return channelId;
    const link = parseLink(arg);
    return link && !link.channelId ? link.guildId : null;
}

/**
 * A message reference: a message link (with its channel), or a raw ID
 * (channel unknown, so null). Else null.
 */
export function parseMessageRef(
    arg: string | undefined | null
): { channelId: string | null; messageId: string } | null {
    if (!arg) return null;
    const text = arg.trim();
    if (ID_RE.test(text)) return { channelId: null, messageId: text };
    const link = parseLink(text);
    return link?.channelId && link.messageId
        ? { channelId: link.channelId, messageId: link.messageId }
        : null;
}

/** The role ID of a role mention (`<@&id>`) or a raw ID, else null. */
export function parseRoleRef(arg: string | undefined | null): string | null {
    if (!arg) return null;
    const text = arg.trim();
    const mention = ROLE_MENTION_RE.exec(text);
    if (mention) return mention[1];
    return ID_RE.test(text) ? text : null;
}
