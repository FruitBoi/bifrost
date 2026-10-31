import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../../db/entities/ChannelLink';
import { MessagePlatform } from '../../db/entities/MessageLink';
import { LinkService } from '../LinkService';
import ReplyLinkResolver from '../replyQuote/ReplyLinkResolver';
import logger from '../../utils/logging/logger';

const ID = '\\d{15,25}';

/** `<#id>` channel/thread mentions. */
const CHANNEL_MENTION_RE = new RegExp(`<#(${ID})>`, 'g');

/**
 * Channel, thread and message links per source platform:
 * `https://host/channels/<guild>/<channel>[/<message>]`.
 */
const CHANNEL_URL_RE: Record<MessagePlatform, RegExp> = {
    discord: new RegExp(
        `https?://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/(${ID})/(${ID})(?:/(${ID}))?(?![\\d/])`,
        'g'
    ),
    fluxer: new RegExp(
        `https?://(?:web\\.)?fluxer\\.app/channels/(${ID})/(${ID})(?:/(${ID}))?(?![\\d/])`,
        'g'
    ),
};

function channelUrl(
    platform: MessagePlatform,
    guildId: string,
    channelId: string
): string {
    const host = platform === 'discord' ? 'discord.com' : 'fluxer.app';
    return `https://${host}/channels/${guildId}/${channelId}`;
}

function otherPlatform(platform: MessagePlatform): MessagePlatform {
    return platform === 'discord' ? 'fluxer' : 'discord';
}

/**
 * Points mentions of and links to bridged channels and threads at their
 * counterparts on the other platform (issue #50), so `#general` on Discord
 * becomes a clickable `#general` on Fluxer instead of plain text.
 */
export default class ChannelLinkBridge {
    constructor(
        private readonly linkService: LinkService,
        private readonly replyLinkResolver?: ReplyLinkResolver
    ) {}

    /** The distinct channel IDs of the `<#id>` mentions in `content`. */
    static extractChannelMentionIds(content: string): string[] {
        const ids = new Set<string>();
        for (const match of content.matchAll(CHANNEL_MENTION_RE)) {
            ids.add(match[1]);
        }
        return [...ids];
    }

    /** The link whose `platform` side is exactly `locationId`, or null. */
    private async findLink(
        platform: MessagePlatform,
        locationId: string
    ): Promise<ChannelLink | null> {
        try {
            const link =
                platform === 'discord'
                    ? await this.linkService.getChannelLinkByDiscordLocation(
                          locationId
                      )
                    : await this.linkService.getChannelLinkByFluxerLocation(
                          locationId
                      );
            return link ?? null;
        } catch (error) {
            logger.debug(
                `Could not look up the channel link of ${platform} location ${locationId}: ${error}`
            );
            return null;
        }
    }

    /** The counterpart of `locationId`, a channel or thread on `platform`. */
    private async counterpartLocation(
        platform: MessagePlatform,
        locationId: string
    ): Promise<{ link: ChannelLink; locationId: string } | null> {
        const link = await this.findLink(platform, locationId);
        if (!link) return null;
        return {
            link,
            locationId:
                platform === 'discord'
                    ? fluxerLocationId(link)
                    : discordLocationId(link),
        };
    }

    /**
     * Maps each mentioned channel ID (on `platform`) that is bridged to the
     * ID of its counterpart channel or thread. Unbridged ones are left out.
     */
    async resolveChannelMentions(
        platform: MessagePlatform,
        ids: string[]
    ): Promise<Map<string, string>> {
        const counterparts = new Map<string, string>();
        for (const id of ids) {
            const counterpart = await this.counterpartLocation(platform, id);
            if (counterpart) counterparts.set(id, counterpart.locationId);
        }
        return counterparts;
    }

    /** The counterpart URL of one channel/thread/message link, or null. */
    private async counterpartUrl(
        platform: MessagePlatform,
        channelId: string,
        messageId: string | undefined
    ): Promise<string | null> {
        if (messageId && this.replyLinkResolver) {
            const url = await this.replyLinkResolver.resolveCounterpartUrl(
                platform,
                messageId
            );
            if (url) return url;
        }
        // A message that was never bridged has no copy to point at; keep
        // the original link rather than dropping the message part.
        if (messageId) return null;
        const counterpart = await this.counterpartLocation(platform, channelId);
        if (!counterpart) return null;
        try {
            const guildLink = await this.linkService.getGuildLinkById(
                counterpart.link.guildLinkId
            );
            if (!guildLink) return null;
            const guildId =
                platform === 'discord'
                    ? guildLink.fluxerGuildId
                    : guildLink.discordGuildId;
            return channelUrl(
                otherPlatform(platform),
                guildId,
                counterpart.locationId
            );
        } catch (error) {
            logger.debug(
                `Could not build the counterpart link of ${platform} channel ${channelId}: ${error}`
            );
            return null;
        }
    }

    /**
     * Rewrites links (from `platform`) to bridged channels, threads and
     * bridged messages so they open the counterpart on the other platform.
     * Other links are left as they are.
     */
    async rewriteChannelUrls(
        platform: MessagePlatform,
        content: string
    ): Promise<string> {
        const re = CHANNEL_URL_RE[platform];
        const matches = [...content.matchAll(re)];
        if (matches.length === 0) return content;

        const replacements = new Map<string, string | null>();
        for (const [url, , channelId, messageId] of matches) {
            if (replacements.has(url)) continue;
            replacements.set(
                url,
                await this.counterpartUrl(platform, channelId, messageId)
            );
        }
        return content.replace(re, (url) => replacements.get(url) ?? url);
    }
}
