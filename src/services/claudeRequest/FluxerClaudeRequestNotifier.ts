import { Client, EmbedBuilder } from '@fluxerjs/core';
import { ClaudeRequest } from '../../db/entities/ClaudeRequest';
import { isPermanentFluxerDeliveryError } from '../reminders/FluxerReminderDeliverer';
import {
    buildClaudeRequestNotice,
    ClaudeRequestNotifier,
    ClaudeRequestNotifyError,
    ClaudeRequestOutcome,
} from './ClaudeRequestNotifier';

/** HTTP status of a Fluxer error (duck-typed like the reminder deliverer). */
function httpStatus(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const { statusCode, status } = err as {
        statusCode?: unknown;
        status?: unknown;
    };
    if (typeof statusCode === 'number') return statusCode;
    if (typeof status === 'number') return status;
    return null;
}

/**
 * True when a failed reply may succeed as a plain message: the API rejected
 * the request itself (4xx other than 429, e.g. the referenced message was
 * deleted) rather than failing on the way there.
 */
function mayRetryWithoutReply(err: unknown): boolean {
    const status = httpStatus(err);
    return status !== null && status >= 400 && status < 500 && status !== 429;
}

/**
 * Tells the requester in their Fluxer channel that their Claude request was
 * closed: a line pinging the requester (only that user may be mentioned),
 * replying to the invoking message when there is one, plus an embed linking
 * the issue. Fluxer has no `failIfNotExists`, so a reply that is rejected is
 * retried once as a plain message.
 */
export default class FluxerClaudeRequestNotifier implements ClaudeRequestNotifier {
    constructor(private readonly client: Client) {}

    async notify(
        request: ClaudeRequest,
        outcome: ClaudeRequestOutcome
    ): Promise<void> {
        const notice = buildClaudeRequestNotice(request, outcome);
        const payload = {
            content: notice.content,
            embeds: [
                new EmbedBuilder()
                    .setTitle(notice.title)
                    .setDescription(notice.description)
                    .setColor(notice.color)
                    .setTimestamp(),
            ],
            allowedMentions: { parse: [], users: [request.userId] },
        };

        try {
            if (request.messageId) {
                try {
                    await this.client.channels.send(request.channelId, {
                        ...payload,
                        replyTo: {
                            channelId: request.channelId,
                            messageId: request.messageId,
                            guildId: request.guildId,
                        },
                    });
                    return;
                } catch (err) {
                    if (!mayRetryWithoutReply(err)) throw err;
                }
            }
            await this.client.channels.send(request.channelId, payload);
        } catch (err) {
            if (isPermanentFluxerDeliveryError(err)) {
                throw new ClaudeRequestNotifyError(
                    `Cannot notify Claude request #${request.issueNumber} in Fluxer channel ${request.channelId}: ${(err as Error).message ?? String(err)}`,
                    true,
                    { cause: err }
                );
            }
            throw err;
        }
    }
}
