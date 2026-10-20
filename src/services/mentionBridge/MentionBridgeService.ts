import { MessagePlatform } from '../../db/entities/MessageLink';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';

type MentionLinkLookup = Pick<
    LinkService,
    'getMessageLinkByDiscordMessageId' | 'getMessageLinkByFluxerMessageId'
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

const USER_MENTION_PATTERN = /<@!?(\d+)>/g;

/**
 * Carries reply pings across the bridge. Webhooks cannot send true replies on
 * either platform, so the only way to notify the original author is to inject
 * a real `<@id>` mention into the relayed copy and whitelist that id in the
 * webhook's allowed mentions. Which user to ping comes from the message link:
 * every relayed message records the platform and author of its original.
 */
export default class MentionBridgeService {
    constructor(private readonly linkService: MentionLinkLookup) {}

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

            if (link.sourcePlatform === platform) {
                logger.debug(
                    `🔕 Reply ping not bridged: ${context} targets a message originally written on ${platform}; its ${other} copy is only a webhook echo`
                );
                return null;
            }

            if (!link.sourceAuthorId) {
                logger.debug(
                    `🔕 Reply ping not bridged: ${context} targets a message originally posted by a webhook on ${other}; there is no user to ping`
                );
                return null;
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
     * Records direct user mentions that were flattened to plaintext. No
     * cross-platform identity mapping exists, so a direct mention can never be
     * upgraded to a ping; only reply pings are bridged.
     */
    logUnresolvedUserMentions(
        platform: MessagePlatform,
        mentions: UnresolvedUserMention[]
    ): void {
        const seen = new Set<string>();
        for (const mention of mentions) {
            if (seen.has(mention.id)) continue;
            seen.add(mention.id);
            const name = mention.username
                ? `@${mention.username}`
                : '@unknown-user';
            logger.info(
                `🔕 User mention relayed as plaintext: ${platform} user ${mention.id} (${name}); no cross-platform identity mapping exists (only reply pings are bridged)`
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
