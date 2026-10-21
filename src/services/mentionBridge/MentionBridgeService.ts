import { GuildLink } from '../../db/entities/GuildLink';
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

/** A role on either platform, reduced to what name matching needs. */
export type GeneralRole = { id: string; name: string };

/**
 * Lists the roles of the OTHER platform's guild so a mentioned role can be
 * matched by name across the bridge.
 */
export type CounterpartRoleLookup = {
    fetchDiscordRoles(guildId: string): Promise<GeneralRole[]>;
    fetchFluxerRoles(guildId: string): Promise<GeneralRole[]>;
};

export type MentionBridgeOptions = {
    /** Lists the roles of the OTHER platform's guild; absent = role mentions stay plaintext. */
    roleLookup?: CounterpartRoleLookup;
    /** The `roles.bridgeMentions` config toggle. Default true. */
    bridgeRoleMentions?: boolean;
};

export type UnresolvedRoleMention = {
    id: string;
    name: string | null;
    /** Whether anyone may ping the role on the source platform. */
    mentionable: boolean;
};

export type RoleMentionsInput = {
    /** Platform the message was written on. */
    platform: MessagePlatform;
    /** Id of the guild (on `platform`) the message was written in. */
    guildId: string | null;
    /** The `<@&id>` mentions found in the raw content. */
    mentions: UnresolvedRoleMention[];
    /** Author holds Mention Everyone (or equivalent) on the source platform, so may ping non-mentionable roles. */
    authorCanMentionAnyRole: boolean;
    /** Edits are re-transformed; skip the per-message logging then. */
    isEdit?: boolean;
};

/**
 * A resolved role mention: `id` on the source platform maps to the role
 * `counterpartId` of the same `name` on the other one.
 */
export type ResolvedRoleMention = {
    id: string;
    counterpartId: string;
    name: string;
};

const USER_MENTION_PATTERN = /<@!?(\d+)>/g;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/g;

// Placeholders stand in for `<@id>` while the content is sanitised (which
// flattens every mention to plaintext and, on Fluxer, breaks every `@`), and
// are turned back into real mentions at the very end. The delimiters are
// private-use code points that never occur in chat text.
const PLACEHOLDER_START = '\uE000bfmention:';
const ROLE_PLACEHOLDER_START = '\uE000bfrole:';
const PLACEHOLDER_END = '\uE001';
const PLACEHOLDER_PATTERN = /\uE000bfmention:([^\uE001]+)\uE001/g;
const ROLE_PLACEHOLDER_PATTERN = /\uE000bfrole:([^\uE001]+)\uE001/g;

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
 *
 * Role mentions (`<@&id>`) are matched by name against the roles of the
 * linked guild on the other platform (the same rule as custom emojis and the
 * `role` command) and relayed as a real role ping of that namesake, provided
 * the author was allowed to ping the role where they wrote it.
 */
export default class MentionBridgeService {
    private readonly roleLookup: CounterpartRoleLookup | null;
    private readonly bridgeRoleMentions: boolean;

    constructor(
        private readonly linkService: MentionLinkLookup,
        options: MentionBridgeOptions = {}
    ) {
        this.roleLookup = options.roleLookup ?? null;
        this.bridgeRoleMentions = options.bridgeRoleMentions ?? true;
    }

    /** The guild link the message's guild belongs to, or null when it is not bridged. */
    private async guildLinkOf(
        platform: MessagePlatform,
        guildId: string | null
    ): Promise<GuildLink | null> {
        if (!guildId) return null;
        return platform === 'discord'
            ? await this.linkService.getGuildLinkForDiscordGuild(guildId)
            : await this.linkService.getGuildLinkForFluxerGuild(guildId);
    }

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
            const guildLink = await this.guildLinkOf(platform, guildId);

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

    /**
     * Resolves the `<@&id>` role mentions of a message to the roles of the
     * same name in the linked guild on the other platform. Roles without a
     * namesake, and roles the author could not ping where they wrote the
     * message, are logged and stay plaintext; matched ones are returned so
     * the relayed copy can ping them.
     */
    async resolveRoleMentions(
        input: RoleMentionsInput
    ): Promise<ResolvedRoleMention[]> {
        const { platform, guildId, authorCanMentionAnyRole, isEdit } = input;
        const mentions = dedupeById(input.mentions).filter(
            // @everyone is a role too (its id is the guild id) and never bridged.
            (mention) => mention.id !== guildId
        );
        if (mentions.length === 0) return [];

        const other = platform === 'discord' ? 'fluxer' : 'discord';
        if (!this.bridgeRoleMentions || !this.roleLookup) {
            logger.debug(
                `🔕 Role mentions relayed as plaintext: role mention bridging is ${this.bridgeRoleMentions ? 'not wired up' : 'disabled (roles.bridgeMentions)'}`
            );
            return [];
        }

        const resolved: ResolvedRoleMention[] = [];
        const log = (line: string): void => {
            if (!isEdit) logger.info(line);
        };

        try {
            const guildLink = await this.guildLinkOf(platform, guildId);
            if (!guildLink) {
                for (const mention of mentions) {
                    log(
                        `🔕 Role mention relayed as plaintext: ${platform} role ${mention.id} (${roleDisplayName(mention)}) was mentioned outside a linked guild`
                    );
                }
                return resolved;
            }

            const counterpartGuildId =
                platform === 'discord'
                    ? guildLink.fluxerGuildId
                    : guildLink.discordGuildId;
            let counterpartRoles: GeneralRole[] | null = null;
            const counterpartRoleNamed = async (
                name: string
            ): Promise<GeneralRole | undefined> => {
                counterpartRoles ??= (
                    platform === 'discord'
                        ? await this.roleLookup!.fetchFluxerRoles(
                              counterpartGuildId
                          )
                        : await this.roleLookup!.fetchDiscordRoles(
                              counterpartGuildId
                          )
                ).filter(
                    (role) =>
                        role.id !== counterpartGuildId &&
                        role.name !== '@everyone'
                );
                return counterpartRoles.find((role) => role.name === name);
            };

            for (const mention of mentions) {
                const name = roleDisplayName(mention);
                if (!mention.mentionable && !authorCanMentionAnyRole) {
                    log(
                        `🔕 Role mention not bridged: ${platform} role ${mention.id} (${name}) is not mentionable and the author may not ping it`
                    );
                    continue;
                }
                if (mention.name === null) {
                    log(
                        `🔕 Role mention relayed as plaintext: ${platform} role ${mention.id} is unknown, so it cannot be matched by name`
                    );
                    continue;
                }
                const counterpart = await counterpartRoleNamed(mention.name);
                if (!counterpart) {
                    log(
                        `🔕 Role mention relayed as plaintext: no ${other} role named ${name}`
                    );
                    continue;
                }
                resolved.push({
                    id: mention.id,
                    counterpartId: counterpart.id,
                    name: mention.name,
                });
                log(
                    `🔔 Role mention bridged: ${platform} role ${mention.id} (${name}) pings ${other} role ${counterpart.id}`
                );
            }
        } catch (error: unknown) {
            logger.warn(
                `⚠️ Role mention lookup failed for ${platform} message; relaying mentions as plaintext:`,
                error
            );
        }

        return resolved;
    }

    /** Extracts the user ids mentioned as `<@id>` / `<@!id>` in raw content. */
    static extractUserMentionIds(content: string): string[] {
        return extractIds(content, USER_MENTION_PATTERN);
    }

    /** Extracts the role ids mentioned as `<@&id>` in raw content. */
    static extractRoleMentionIds(content: string): string[] {
        return extractIds(content, ROLE_MENTION_PATTERN);
    }

    /**
     * A token that survives mention sanitising and `@`-breaking unchanged;
     * {@link restoreMentionPlaceholders} turns it back into `<@id>`.
     */
    static mentionPlaceholder(userId: string): string {
        return `${PLACEHOLDER_START}${userId}${PLACEHOLDER_END}`;
    }

    /**
     * Like {@link mentionPlaceholder} for a role: survives sanitising and is
     * turned back into `<@&id>` by {@link restoreMentionPlaceholders}.
     */
    static roleMentionPlaceholder(roleId: string): string {
        return `${ROLE_PLACEHOLDER_START}${roleId}${PLACEHOLDER_END}`;
    }

    /**
     * Replaces every placeholder from {@link mentionPlaceholder} with `<@id>`
     * and every one from {@link roleMentionPlaceholder} with `<@&id>`.
     */
    static restoreMentionPlaceholders(content: string): string {
        return content
            .replace(PLACEHOLDER_PATTERN, '<@$1>')
            .replace(ROLE_PLACEHOLDER_PATTERN, '<@&$1>');
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

function extractIds(content: string, pattern: RegExp): string[] {
    const ids: string[] = [];
    for (const match of content.matchAll(pattern)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
}

function dedupeById<T extends { id: string }>(mentions: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
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

function roleDisplayName(mention: UnresolvedRoleMention): string {
    return mention.name ? `@${mention.name}` : '@unknown-role';
}
