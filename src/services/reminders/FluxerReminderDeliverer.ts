import { Client, EmbedBuilder } from '@fluxerjs/core';
import { Reminder } from '../../db/entities/Reminder';
import { EmbedColors } from '../../utils/embeds';
import { ReminderDeliverer, ReminderDeliveryError } from './ReminderDeliverer';

/**
 * HTTP statuses after which retrying cannot help: the channel is gone or the
 * bot may not post there.
 */
const PERMANENT_STATUSES = new Set([403, 404]);

/**
 * Error codes after which retrying cannot help. The first group are Fluxer
 * API error codes (`FluxerAPIError.code` from @fluxerjs/rest); the last two
 * are @fluxerjs/core `ErrorCodes` raised client-side (`FluxerError.code`).
 */
const PERMANENT_CODES = new Set([
    'UNKNOWN_CHANNEL',
    'MISSING_ACCESS',
    'MISSING_PERMISSIONS',
    'FORBIDDEN',
    'ACCESS_DENIED',
    'CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL',
    'CHANNEL_NOT_FOUND',
    'INVALID_CHANNEL_TYPE',
]);

/**
 * Error shapes seen from `client.channels.send` (duck-typed so tests can use
 * plain objects):
 *
 * - `FluxerAPIError` / `HTTPError` / `RateLimitError` (@fluxerjs/rest):
 *   `statusCode: number` (HTTP status) and, for API errors, `code: string`
 *   (e.g. `UNKNOWN_CHANNEL`, `MISSING_ACCESS`, `RATE_LIMITED`).
 * - `FluxerError` (@fluxerjs/core, via @fluxerjs/util): `code: string`
 *   (e.g. `CHANNEL_NOT_FOUND` from `client.channels.fetch`,
 *   `INVALID_CHANNEL_TYPE` from `channel.send` on a non-text channel).
 * - Plain `status: number` is accepted as an alias of `statusCode`.
 *
 * Anything else (network errors, 5xx, 429, API blocks) is transient.
 */
export function isPermanentFluxerDeliveryError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { statusCode, status, code } = err as {
        statusCode?: unknown;
        status?: unknown;
        code?: unknown;
    };
    const httpStatus =
        typeof statusCode === 'number'
            ? statusCode
            : typeof status === 'number'
              ? status
              : null;
    if (httpStatus !== null && PERMANENT_STATUSES.has(httpStatus)) return true;
    return typeof code === 'string' && PERMANENT_CODES.has(code);
}

/**
 * Posts due reminders into their Fluxer channel: a line pinging the user
 * (only that user may be mentioned) and an embed carrying the message.
 */
export default class FluxerReminderDeliverer implements ReminderDeliverer {
    constructor(private readonly client: Client) {}

    async deliver(reminder: Reminder): Promise<void> {
        try {
            await this.client.channels.send(reminder.channelId, {
                content: `**Reminder** for <@${reminder.userId}>`,
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Reminder from Bifröst')
                        .setDescription(reminder.message)
                        .setColor(EmbedColors.Info)
                        .setTimestamp(),
                ],
                allowedMentions: { parse: [], users: [reminder.userId] },
            });
        } catch (err) {
            if (isPermanentFluxerDeliveryError(err)) {
                throw new ReminderDeliveryError(
                    `Cannot deliver reminder #${reminder.id} to Fluxer channel ${reminder.channelId}: ${(err as Error).message ?? String(err)}`,
                    true,
                    { cause: err }
                );
            }
            throw err;
        }
    }
}
