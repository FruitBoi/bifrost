import { Client, EmbedBuilder, Message } from 'discord.js';
import { ClaudeRequest } from '../../db/entities/ClaudeRequest';
import logger from '../../utils/logging/logger';
import {
    discordErrorCode,
    PERMANENT_FETCH_CODES,
    PERMANENT_SEND_CODES,
} from '../reminders/DiscordReminderDeliverer';
import {
    buildClaudeRequestNotice,
    ClaudeRequestNotifier,
    ClaudeRequestNotifyError,
    ClaudeRequestOutcome,
} from './ClaudeRequestNotifier';

/**
 * Wraps `err` in a permanent {@link ClaudeRequestNotifyError} when its
 * Discord error code is in `permanentCodes`; otherwise returns `err`
 * unchanged so the service retries on a later tick.
 */
function classifyError(
    err: unknown,
    permanentCodes: ReadonlySet<number>,
    what: string
): unknown {
    const code = discordErrorCode(err);
    if (code !== null && permanentCodes.has(code)) {
        return new ClaudeRequestNotifyError(
            `${what} (Discord error ${code}: ${(err as Error).message ?? err})`,
            true,
            { cause: err }
        );
    }
    return err;
}

/**
 * Tells the requester in their Discord channel that their Claude request was
 * closed: a ping of the requester (the only mention allowed to resolve),
 * replying to the invoking message when it still exists, plus an embed
 * linking the issue. Resolves with the notice's message ID. When a relay hook
 * is given the notice is bridged to the linked channel through it (issue #40).
 */
export default class DiscordClaudeRequestNotifier implements ClaudeRequestNotifier {
    constructor(
        private readonly client: Client,
        private readonly relayNotice:
            | ((notice: Message) => Promise<void>)
            | null = null
    ) {}

    public async notify(
        request: ClaudeRequest,
        outcome: ClaudeRequestOutcome
    ): Promise<string | null> {
        let channel;
        try {
            channel = await this.client.channels.fetch(request.channelId);
        } catch (err) {
            throw classifyError(
                err,
                PERMANENT_FETCH_CODES,
                `Cannot fetch channel ${request.channelId} for Claude request #${request.issueNumber}`
            );
        }

        if (
            !channel ||
            !channel.isTextBased() ||
            channel.isDMBased() ||
            !channel.isSendable()
        ) {
            throw new ClaudeRequestNotifyError(
                `Channel ${request.channelId} for Claude request #${request.issueNumber} is missing or not a text channel of a server`,
                true
            );
        }

        const notice = buildClaudeRequestNotice(request, outcome);
        let sent;
        try {
            sent = await channel.send({
                content: notice.content,
                embeds: [
                    new EmbedBuilder()
                        .setTitle(notice.title)
                        .setDescription(notice.description)
                        .setColor(notice.color)
                        .setTimestamp(),
                ],
                allowedMentions: { parse: [], users: [request.userId] },
                // A deleted invoking message turns this into a plain send.
                ...(request.messageId
                    ? {
                          reply: {
                              messageReference: request.messageId,
                              failIfNotExists: false,
                          },
                      }
                    : {}),
            });
        } catch (err) {
            throw classifyError(
                err,
                PERMANENT_SEND_CODES,
                `Cannot post Claude request #${request.issueNumber} notice in channel ${request.channelId}`
            );
        }

        if (sent && this.relayNotice) {
            try {
                await this.relayNotice(sent);
            } catch (err) {
                logger.error(
                    '❌ Failed to bridge a Claude request notice:',
                    err
                );
            }
        }
        return sent?.id ?? null;
    }
}
