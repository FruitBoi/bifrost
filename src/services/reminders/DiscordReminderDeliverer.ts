import { Client, DiscordAPIError, EmbedBuilder } from 'discord.js';
import { Reminder } from '../../db/entities/Reminder';
import { EmbedColors } from '../../utils/embeds';
import { ReminderDeliverer, ReminderDeliveryError } from './ReminderDeliverer';

/**
 * Discord API error codes after which retrying cannot help when fetching the
 * reminder's channel: Unknown Channel, Unknown Guild, Missing Access and
 * Missing Permissions.
 */
const PERMANENT_FETCH_CODES: ReadonlySet<number> = new Set([
    10003, 10004, 50001, 50013,
]);

/**
 * The fetch codes plus Cannot Send Messages To This User (50007) and Invalid
 * Form Body (50035): the payload itself is rejected, so a retry would fail
 * the same way.
 */
const PERMANENT_SEND_CODES: ReadonlySet<number> = new Set([
    ...PERMANENT_FETCH_CODES,
    50007,
    50035,
]);

/**
 * Numeric Discord API error code of `err`, or null for anything else (network
 * errors carry string codes such as `ECONNRESET`, so they stay transient).
 * Detection is duck-typed on top of `instanceof` so plain objects work too.
 */
function discordErrorCode(err: unknown): number | null {
    if (err instanceof DiscordAPIError) {
        return typeof err.code === 'number' ? err.code : null;
    }
    if (
        typeof err === 'object' &&
        err !== null &&
        typeof (err as { code?: unknown }).code === 'number'
    ) {
        return (err as { code: number }).code;
    }
    return null;
}

/**
 * Wraps `err` in a permanent {@link ReminderDeliveryError} when its Discord
 * error code is in `permanentCodes`; otherwise returns `err` unchanged so the
 * service retries the reminder on a later tick.
 */
function classifyError(
    err: unknown,
    permanentCodes: ReadonlySet<number>,
    what: string
): unknown {
    const code = discordErrorCode(err);
    if (code !== null && permanentCodes.has(code)) {
        return new ReminderDeliveryError(
            `${what} (Discord error ${code}: ${(err as Error).message ?? err})`,
            true,
            { cause: err }
        );
    }
    return err;
}

/**
 * Posts due reminders into their Discord channel: a ping of the reminded user
 * (the only mention allowed to resolve) plus an embed with the message.
 */
export default class DiscordReminderDeliverer implements ReminderDeliverer {
    constructor(private readonly client: Client) {}

    public async deliver(reminder: Reminder): Promise<void> {
        let channel;
        try {
            channel = await this.client.channels.fetch(reminder.channelId);
        } catch (err) {
            throw classifyError(
                err,
                PERMANENT_FETCH_CODES,
                `Cannot fetch channel ${reminder.channelId} for reminder #${reminder.id}`
            );
        }

        if (
            !channel ||
            !channel.isTextBased() ||
            channel.isDMBased() ||
            !channel.isSendable()
        ) {
            throw new ReminderDeliveryError(
                `Channel ${reminder.channelId} for reminder #${reminder.id} is missing or not a text channel of a server`,
                true
            );
        }

        try {
            await channel.send({
                content: `**Reminder** for <@${reminder.userId}>`,
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Reminder from Bifröst')
                        .setDescription(reminder.message)
                        .setColor(EmbedColors.Info)
                        .setTimestamp(reminder.dueAt),
                ],
                allowedMentions: { parse: [], users: [reminder.userId] },
            });
        } catch (err) {
            throw classifyError(
                err,
                PERMANENT_SEND_CODES,
                `Cannot post reminder #${reminder.id} in channel ${reminder.channelId}`
            );
        }
    }
}
