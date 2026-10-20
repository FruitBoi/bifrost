import { Reminder } from '../../db/entities/Reminder';

/**
 * Thrown by a {@link ReminderDeliverer} when a reminder can never be
 * delivered (channel deleted, bot kicked, no permission to post there, ...).
 * The service drops such reminders instead of retrying them.
 */
export class ReminderDeliveryError extends Error {
    /** The underlying error, when there is one (tsconfig targets ES6, so `Error.cause` is declared here). */
    readonly cause?: unknown;

    constructor(
        message: string,
        /** True when retrying later cannot help. */
        public readonly permanent: boolean,
        options?: { cause?: unknown }
    ) {
        super(message);
        this.name = 'ReminderDeliveryError';
        this.cause = options?.cause;
    }
}

/**
 * Posts a due reminder into its channel on one platform. Implemented once per
 * platform (Discord and Fluxer) and registered on the ReminderService.
 *
 * Contract: resolve when the reminder message was posted; throw a
 * {@link ReminderDeliveryError} with `permanent: true` for failures that will
 * not go away (unknown channel, missing access, not a text channel); throw
 * anything else (or a non-permanent ReminderDeliveryError) for transient
 * failures such as network errors, which the service retries on a later tick.
 */
export interface ReminderDeliverer {
    deliver(reminder: Reminder): Promise<void>;
}
