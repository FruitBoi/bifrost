import { MessagePlatform } from '../../db/entities/MessageLink';
import { UserLink } from '../../db/entities/UserLink';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';

type MentionLinkLookup = Pick<
    LinkService,
    | 'getMessageLinkByDiscordMessageId'
    | 'getMessageLinkByFluxerMessageId'
    | 'getGuildLinkForDiscordGuild'
    | 'getGuildLinkForFluxerGuild'
    | 'getUserLinkForDiscordUser'
    | 'getUserLinkForFluxerUser'
>;

export type ReplyPingInput = {
    /** Platform the reply was written on. */
    platform: MessagePlatform;
    /** Author of the reply on `platform`. */
    replierId: string;
    /** Id (on `platform`) of the message being replied to. */
    repliedMessageId: string;
    /** Author id (on `platform`) of the message being replied to. */
    repliedAuthorId: string;
    /** Whether the reply pings its target on `platform`. */
    replyPings: boolean;
};

export type UnresolvedUserMention = {
    id: string;
    username: string | null;
};

export type UserMentionsInput = {
    /** Platform the message was written on. */
    platform: MessagePlatform;
    /** Id of the guild (on `platform`) the message was written in. */
    guildId: string | null;
    /** The `<@id>` mentions found in the raw content. */
    mentions: UnresolvedUserMention[];
    /** Edits are re-transformed; skip the per-message logging then. */
    isEdit?: boolean;
};

/**
 * A resolved user mention: `id` on the source platform maps to
 * `counterpartId` on the other one.
 */
export type ResolvedUserMention = {
    id: string;
    counterpartId: string;
};

const USER_MENTION_PATTERN = /<@!?(\d+)>/g;

// Placeholders stand in for `<@id>` while the content is sanitised (which
// flattens every mention to plaintext and, on Fluxer, breaks every `@`), and
// are turned back into real mentions at the very end. The delimiters are
// private-use code points that never occur in chat text.
const PLACEHOLDER_START = '\uE000bfmention:';
const PLACEHOLDER_END = '\uE001';
const PLACEHOLDER_PATTERN = /\uE000bfmention:([^\uE001]+)\uE001/g;

/**
 * Carries user pings across the bridge. Webhooks cannot send true replies on
 * either platform, so the only way to notify someone is to inject a real
 * `<@id>` mention into the relayed copy and whitelist that id in the
 * webhook's allowed mentions.
 *
 * Two sources decide who to ping:
 * - the message link: every relayed message records the platform and author
 *   of its original, so a reply to the copy can ping the original author;
 * - user links: the identity mapping recorded by the Fluxer `role` command,
 *   so a direct `<@id>` mention (or a reply to a message written on the
 *   replier's own platform) reaches the same person on the other side.
 */
export default class MentionBridgeService {
    constructor(private readonly linkService: MentionLinkLookup) {}

    /**
     * Looks up the identity mapping for `userId` on `platform` inside a guild
     * link and returns the id of the same person on the other platform.
     */
    private async counterpartOf(
        guildLinkId: string,
        platform: MessagePlatform,
        userId: string
    ): Promise<string | null> {
        const link: UserLink | null =
            platform === 'discord'
                ? await this.linkService.getUserLinkForDiscordUser(
                      guildLinkId,
                      userId
                  )
                : await this.linkService.getUserLinkForFluxerUser(
                      guildLinkId,
                      userId
                  );
        if (!link) return null;
        return platform === 'discord' ? link.fluxerUserId : link.discordUserId;
    }

    /**
     * Resolves the user id that must be pinged on the OTHER platform when a
     * reply on `platform` pings the author of a bridged message. Returns null
     * (and logs why) whenever there is nobody to ping.
     */
    async resolveReplyPing(input: ReplyPingInput): Promise<string | null> {
        const { platform, replierId, repliedMessageId, replyPings } = input;
        if (!replyPings) return null;

        const other = platform === 'discord' ? 'fluxer' : 'discord';
        const context = `reply by ${platform} user ${replierId} to ${platform} message ${repliedMessageId}`;

        try {
            const link =
                platform === 'discord'
                    ? await this.linkService.getMessageLinkByDiscordMessageId(
                          repliedMessageId
                      )
                    : await this.linkService.getMessageLinkByFluxerMessageId(
                          repliedMessageId
                      );

            if (!link) {
                logger.debug(
                    `🔕 Reply ping not bridged: ${context} targets a message that was never bridged`
                );
                return null;
            }

            if (!link.sourcePlatform) {
                logger.debug(
                    `🔕 Reply ping not bridged: ${context} targets a message link that predates author tracking`
                );
                return null;
            }

            if (!link.sourceAuthorId) {
                logger.debug(
                    `🔕 Reply ping not bridged: ${context} targets a message originally posted by a webhook on ${link.sourcePlatform}; there is no user to ping`
                );
                return null;
            }

            if (link.sourcePlatform === platform) {
                // The copy on the other side is only a webhook echo, so the
                // author can only be reached there through the identity mapping.
                const counterpart = await this.counterpartOf(
                    link.guildLinkId,
                    platform,
                    link.sourceAuthorId
                );
                if (!counterpart) {
                    logger.debug(
                        `🔕 Reply ping not bridged: ${context} targets a message originally written on ${platform} by user ${link.sourceAuthorId}, who has no ${other} account mapped; its ${other} copy is only a webhook echo`
                    );
                    return null;
                }
                logger.info(
                    `🔔 Reply ping bridged via identity mapping: ${context} pings ${other} user ${counterpart} (${platform} user ${link.sourceAuthorId})`
                );
                return counterpart;
            }

            logger.info(
                `🔔 Reply ping bridged: ${context} pings ${other} user ${link.sourceAuthorId}`
            );
            return link.sourceAuthorId;
        } catch (error: unknown) {
            logger.warn(
                `⚠️ Reply ping lookup failed for ${context}; relaying without a ping:`,
                error
            );
            return null;
        }
    }

    /**
     * Resolves the direct `<@id>` mentions of a message to the mapped users
     * on the other platform. Mentions without a mapping are logged and stay
     * plaintext; mapped ones are returned so the relayed copy can ping them.
     */
    async resolveUserMentions(
        input: UserMentionsInput
    ): Promise<ResolvedUserMention[]> {
        const { platform, guildId, isEdit } = input;
        const mentions = dedupeById(input.mentions);
        if (mentions.length === 0) return [];

        const other = platform === 'discord' ? 'fluxer' : 'discord';
        const resolved: ResolvedUserMention[] = [];
        const unresolved: UnresolvedUserMention[] = [];

        try {
            const guildLink = guildId
                ? platform === 'discord'
                    ? await this.linkService.getGuildLinkForDiscordGuild(
                          guildId
                      )
                    : await this.linkService.getGuildLinkForFluxerGuild(guildId)
                : null;

            for (const mention of mentions) {
                const counterpartId = guildLink
                    ? await this.counterpartOf(
                          guildLink.id,
                          platform,
                          mention.id
                      )
                    : null;
                if (!counterpartId) {
                    unresolved.push(mention);
                    continue;
                }
                resolved.push({ id: mention.id, counterpartId });
                if (!isEdit) {
                    logger.info(
                        `🔔 User mention bridged: ${platform} user ${mention.id} (${displayName(mention)}) pings ${other} user ${counterpartId}`
                    );
                }
            }
        } catch (error: unknown) {
            logger.warn(
                `⚠️ User mention lookup failed for ${platform} message; relaying mentions as plaintext:`,
                error
            );
            return resolved;
        }

        if (!isEdit) this.logUnresolvedUserMentions(platform, unresolved);
        return resolved;
    }

    /**
     * Records direct user mentions that were flattened to plaintext because
     * the mentioned user has no account mapped on the other platform.
     */
    logUnresolvedUserMentions(
        platform: MessagePlatform,
        mentions: UnresolvedUserMention[]
    ): void {
        for (const mention of dedupeById(mentions)) {
            logger.info(
                `🔕 User mention relayed as plaintext: ${platform} user ${mention.id} (${displayName(mention)}) has no account mapped on the other platform (map one with the role command)`
            );
        }
    }

    /** Extracts the user ids mentioned as `<@id>` / `<@!id>` in raw content. */
    static extractUserMentionIds(content: string): string[] {
        const ids: string[] = [];
        for (const match of content.matchAll(USER_MENTION_PATTERN)) {
            if (!ids.includes(match[1])) ids.push(match[1]);
        }
        return ids;
    }

    /**
     * A token that survives mention sanitising and `@`-breaking unchanged;
     * {@link restoreMentionPlaceholders} turns it back into `<@id>`.
     */
    static mentionPlaceholder(userId: string): string {
        return `${PLACEHOLDER_START}${userId}${PLACEHOLDER_END}`;
    }

    /** Replaces every placeholder from {@link mentionPlaceholder} with `<@id>`. */
    static restoreMentionPlaceholders(content: string): string {
        return content.replace(PLACEHOLDER_PATTERN, '<@$1>');
    }

    /**
     * Prepends a `<@id> ` mention for every id not already mentioned in
     * `content`. Must run after all sanitising so the mention survives intact.
     */
    static applyMentions(content: string, userIds: string[]): string {
        const toAdd: string[] = [];
        for (const id of userIds) {
            if (toAdd.includes(id)) continue;
            if (content.includes(`<@${id}>`)) continue;
            toAdd.push(id);
        }
        if (toAdd.length === 0) return content;
        return toAdd.map((id) => `<@${id}> `).join('') + content;
    }
}

function dedupeById(
    mentions: UnresolvedUserMention[]
): UnresolvedUserMention[] {
    const seen = new Set<string>();
    const out: UnresolvedUserMention[] = [];
    for (const mention of mentions) {
        if (seen.has(mention.id)) continue;
        seen.add(mention.id);
        out.push(mention);
    }
    return out;
}

function displayName(mention: UnresolvedUserMention): string {
    return mention.username ? `@${mention.username}` : '@unknown-user';
}
