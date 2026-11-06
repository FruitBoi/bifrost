/**
 * Reminders (issue #9), modelled on YAGPDB's `remindme` / `reminder`
 * commands (https://help.yagpdb.xyz/docs/core/all-commands/#remindme).
 *
 * The service owns the reminder rows and the delivery loop: it polls the
 * table every `tickIntervalMs` for reminders whose `dueAt` has passed and
 * hands each one to the {@link ReminderDeliverer} registered for its platform.
 * A delivered reminder is deleted; a permanently undeliverable one (channel
 * gone, no access) is dropped too; a transient failure bumps `attempts` and
 * the reminder is retried on a later tick until `maxAttempts` is reached.
 * Ticks never overlap, and a platform whose deliverer is not registered
 * (client not connected) is simply skipped until it is.
 *
 * For snoozing (issue #58) the service also remembers the bot's messages that
 * belong to a reminder (the "Reminder set" reply and the delivered ping), so
 * a reminder can be set again after its row has been deleted.
 */
import { Reminder, ReminderPlatform } from '../../db/entities/Reminder';
import {
    RecordReminderMessageData,
    ReminderMessage,
} from '../../db/entities/ReminderMessage';
import { ReminderRepository } from '../../db/repositories/ReminderRepository';
import { ReminderMessageRepository } from '../../db/repositories/ReminderMessageRepository';
import logger from '../../utils/logging/logger';
import { ReminderDeliverer, ReminderDeliveryError } from './ReminderDeliverer';

/** YAGPDB's cap: reminders a user may have at once, across all servers. */
export const MAX_REMINDERS_PER_USER = 25;
/** The issue asks for ten years (YAGPDB allows one). Years are 365 days. */
export const MAX_REMINDER_OFFSET_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** A reminder must be at least this far away (so `0m` is rejected). */
export const MIN_REMINDER_OFFSET_MS = 1000;
/** Longest reminder message accepted. */
export const MAX_REMINDER_MESSAGE_LENGTH = 2000;
/** How long the bot's reminder messages are remembered for snoozing (issue #58). */
export const REMINDER_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateReminderInput {
    platform: ReminderPlatform;
    userId: string;
    guildId: string;
    channelId: string;
    message: string;
    delayMs: number;
}

export type CreateReminderFailure =
    | 'too_many'
    | 'too_long'
    | 'too_short'
    | 'empty_message'
    | 'message_too_long';

export type CreateReminderResult =
    | { ok: true; reminder: Reminder }
    | { ok: false; reason: CreateReminderFailure };

export interface ReminderServiceOptions {
    /** Clock; defaults to `Date.now`. Tests pass a fixed function. */
    now?: () => number;
    /** How often due reminders are looked for. Default 10 s. */
    tickIntervalMs?: number;
    /** Failed deliveries after which a reminder is dropped. Default 5. */
    maxAttempts?: number;
    /**
     * Where the bot's reminder messages are remembered (issue #58). Without
     * it, recordMessage does nothing and findMessage / lastDelivered return
     * null.
     */
    messageRepo?: ReminderMessageRepository;
}

export default class ReminderService {
    private readonly now: () => number;
    private readonly tickIntervalMs: number;
    private readonly maxAttempts: number;
    private readonly messageRepo: ReminderMessageRepository | null;
    private readonly deliverers = new Map<
        ReminderPlatform,
        ReminderDeliverer
    >();
    private interval: ReturnType<typeof setInterval> | null = null;
    private ticking = false;

    constructor(
        private readonly repo: ReminderRepository,
        options: ReminderServiceOptions = {}
    ) {
        this.now = options.now ?? Date.now;
        this.tickIntervalMs = options.tickIntervalMs ?? 10_000;
        this.maxAttempts = options.maxAttempts ?? 5;
        this.messageRepo = options.messageRepo ?? null;
    }

    /** Registers (or, with null, removes) the deliverer for a platform. */
    setDeliverer(
        platform: ReminderPlatform,
        deliverer: ReminderDeliverer | null
    ): void {
        if (deliverer) this.deliverers.set(platform, deliverer);
        else this.deliverers.delete(platform);
    }

    /**
     * Validates and stores a reminder. The message is trimmed first; checks
     * run in the order empty_message, message_too_long, too_short, too_long,
     * too_many so the caller can report the first problem.
     */
    async create(input: CreateReminderInput): Promise<CreateReminderResult> {
        const message = input.message.trim();
        if (message.length === 0) return { ok: false, reason: 'empty_message' };
        if (message.length > MAX_REMINDER_MESSAGE_LENGTH) {
            return { ok: false, reason: 'message_too_long' };
        }
        const { delayMs } = input;
        if (!(delayMs >= MIN_REMINDER_OFFSET_MS)) {
            return { ok: false, reason: 'too_short' };
        }
        if (delayMs > MAX_REMINDER_OFFSET_MS) {
            return { ok: false, reason: 'too_long' };
        }
        const existing = await this.repo.countByUser(
            input.platform,
            input.userId
        );
        if (existing >= MAX_REMINDERS_PER_USER) {
            return { ok: false, reason: 'too_many' };
        }

        const reminder = await this.repo.create({
            platform: input.platform,
            userId: input.userId,
            guildId: input.guildId,
            channelId: input.channelId,
            message,
            dueAt: new Date(this.now() + delayMs),
        });
        logger.info(
            `⏰ Reminder #${reminder.id} set on ${reminder.platform} for user ${reminder.userId} in channel ${reminder.channelId}, due ${reminder.dueAt.toISOString()}`
        );
        return { ok: true, reminder };
    }

    getById(id: number): Promise<Reminder | null> {
        return this.repo.findById(id);
    }

    /** The user's reminders in one guild, soonest first. */
    listForUser(
        platform: ReminderPlatform,
        userId: string,
        guildId: string
    ): Promise<Reminder[]> {
        return this.repo.findByUser(platform, userId, guildId);
    }

    /** Every reminder (any user) in a channel, soonest first. */
    listForChannel(
        platform: ReminderPlatform,
        channelId: string
    ): Promise<Reminder[]> {
        return this.repo.findByChannel(platform, channelId);
    }

    /** The user's reminders across all guilds of the platform. */
    countForUser(platform: ReminderPlatform, userId: string): Promise<number> {
        return this.repo.countByUser(platform, userId);
    }

    /** True when the reminder existed and was removed. */
    delete(id: number): Promise<boolean> {
        return this.repo.deleteById(id);
    }

    /** Removes all of the user's reminders on the platform; returns how many. */
    deleteAllForUser(
        platform: ReminderPlatform,
        userId: string
    ): Promise<number> {
        return this.repo.deleteByUser(platform, userId);
    }

    /**
     * Remembers one of the bot's messages that belongs to a reminder (the
     * "Reminder set" reply or the delivered ping), stamped with the service's
     * clock, and prunes rows older than {@link REMINDER_MESSAGE_RETENTION_MS}.
     * Never rejects; problems are logged.
     */
    async recordMessage(data: RecordReminderMessageData): Promise<void> {
        if (!this.messageRepo) return;
        const now = this.now();
        try {
            await this.messageRepo.save({ ...data, createdAt: new Date(now) });
        } catch (err) {
            logger.warn(
                `⚠️ Could not remember ${data.kind} reminder message ${data.messageId} on ${data.platform}:`,
                err
            );
        }
        try {
            await this.messageRepo.deleteOlderThan(
                new Date(now - REMINDER_MESSAGE_RETENTION_MS)
            );
        } catch (err) {
            logger.warn('⚠️ Could not prune old reminder messages:', err);
        }
    }

    /** The reminder behind one of the bot's messages, within retention. */
    async findMessage(
        platform: ReminderPlatform,
        messageId: string
    ): Promise<ReminderMessage | null> {
        if (!this.messageRepo) return null;
        const row = await this.messageRepo.findByMessage(platform, messageId);
        if (!row || row.createdAt.getTime() < this.retentionCutoff()) {
            return null;
        }
        return row;
    }

    /**
     * The user's most recently delivered reminder in the guild (the last one
     * that pinged them), within retention.
     */
    async lastDelivered(
        platform: ReminderPlatform,
        userId: string,
        guildId: string
    ): Promise<ReminderMessage | null> {
        if (!this.messageRepo) return null;
        return this.messageRepo.findLatest(
            platform,
            userId,
            guildId,
            'delivered',
            new Date(this.retentionCutoff())
        );
    }

    private retentionCutoff(): number {
        return this.now() - REMINDER_MESSAGE_RETENTION_MS;
    }

    /**
     * One delivery tick: delivers every reminder that is due. Never rejects;
     * problems are logged. A tick that starts while another one is still
     * running returns immediately so a slow platform cannot cause double
     * deliveries.
     */
    async deliverDue(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const due = await this.repo.findDue(new Date(this.now()));
            for (const reminder of due) {
                const deliverer = this.deliverers.get(reminder.platform);
                if (!deliverer) continue;
                await this.deliverOne(reminder, deliverer);
            }
        } catch (err) {
            logger.error('❌ Reminder delivery tick failed:', err);
        } finally {
            this.ticking = false;
        }
    }

    private async deliverOne(
        reminder: Reminder,
        deliverer: ReminderDeliverer
    ): Promise<void> {
        let messageId: string | void;
        try {
            messageId = await deliverer.deliver(reminder);
        } catch (err) {
            await this.handleFailure(reminder, err);
            return;
        }
        if (messageId) {
            // Never rejects, so the row below is deleted either way.
            await this.recordMessage({
                platform: reminder.platform,
                messageId,
                kind: 'delivered',
                userId: reminder.userId,
                guildId: reminder.guildId,
                channelId: reminder.channelId,
                message: reminder.message,
            });
        }
        try {
            await this.repo.deleteById(reminder.id);
            logger.info(
                `⏰ Delivered reminder #${reminder.id} on ${reminder.platform} to user ${reminder.userId} in channel ${reminder.channelId}`
            );
        } catch (err) {
            logger.error(
                `❌ Reminder #${reminder.id} was delivered but could not be deleted:`,
                err
            );
        }
    }

    private async handleFailure(
        reminder: Reminder,
        err: unknown
    ): Promise<void> {
        const label = `#${reminder.id} on ${reminder.platform} (channel ${reminder.channelId})`;
        try {
            if (err instanceof ReminderDeliveryError && err.permanent) {
                await this.repo.deleteById(reminder.id);
                logger.warn(
                    `⚠️ Dropped reminder ${label}: ${err.message}`,
                    err.cause ?? ''
                );
                return;
            }
            const attempts = reminder.attempts + 1;
            if (attempts >= this.maxAttempts) {
                await this.repo.deleteById(reminder.id);
                logger.error(
                    `❌ Giving up on reminder ${label} after ${attempts} failed deliveries:`,
                    err
                );
                return;
            }
            await this.repo.incrementAttempts(reminder.id);
            logger.warn(
                `⚠️ Reminder ${label} could not be delivered (attempt ${attempts} of ${this.maxAttempts}), will retry:`,
                err
            );
        } catch (repoErr) {
            logger.error(
                `❌ Failed to record the delivery failure of reminder ${label}:`,
                repoErr
            );
        }
    }

    /**
     * Starts the delivery loop: one tick right away (so reminders that came
     * due while the bot was offline go out immediately) and then one every
     * `tickIntervalMs`. Calling it again while running does nothing.
     */
    start(): void {
        if (this.interval) return;
        this.interval = setInterval(() => {
            void this.deliverDue();
        }, this.tickIntervalMs);
        void this.deliverDue();
        logger.info(
            `⏰ Reminder delivery started (every ${this.tickIntervalMs / 1000} s)`
        );
    }

    stop(): void {
        if (!this.interval) return;
        clearInterval(this.interval);
        this.interval = null;
    }
}
