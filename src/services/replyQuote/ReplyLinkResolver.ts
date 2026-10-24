import {
    discordLocationId,
    fluxerLocationId,
} from '../../db/entities/ChannelLink';
import { MessagePlatform } from '../../db/entities/MessageLink';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';
import { messageUrl } from './replyQuote';

/**
 * Finds where a replied-to message lives on the other platform, so the
 * relayed reply's quote can link to it like a native reply does.
 */
export default class ReplyLinkResolver {
    constructor(private readonly linkService: LinkService) {}

    /**
     * The URL of the counterpart of `messageId` (a message on `platform`):
     * its bridged copy, or the original when `messageId` is itself a webhook
     * copy; the message link stores both directions. Null when the message
     * was never bridged or the lookup fails.
     */
    async resolveCounterpartUrl(
        platform: MessagePlatform,
        messageId: string
    ): Promise<string | null> {
        try {
            const messageLink =
                platform === 'discord'
                    ? await this.linkService.getMessageLinkByDiscordMessageId(
                          messageId
                      )
                    : await this.linkService.getMessageLinkByFluxerMessageId(
                          messageId
                      );
            if (!messageLink) return null;
            const channelLink = await this.linkService.getChannelLinkById(
                messageLink.channelLinkId
            );
            if (!channelLink) return null;
            const guildLink = await this.linkService.getGuildLinkById(
                messageLink.guildLinkId ?? channelLink.guildLinkId
            );
            if (!guildLink) return null;
            return platform === 'discord'
                ? messageUrl(
                      'fluxer',
                      guildLink.fluxerGuildId,
                      fluxerLocationId(channelLink),
                      messageLink.fluxerMessageId
                  )
                : messageUrl(
                      'discord',
                      guildLink.discordGuildId,
                      discordLocationId(channelLink),
                      messageLink.discordMessageId
                  );
        } catch (error) {
            logger.debug(
                `Could not resolve the counterpart of replied-to ${platform} message ${messageId}: ${error}`
            );
            return null;
        }
    }
}
