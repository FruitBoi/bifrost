/**
 * Time zones for date/time reminders (issue #27): `remindme Oct 26 20:15`,
 * `remindme Monday 7pm` and `remindme tomorrow` need to know which wall
 * clock the user means. The zone is stored per platform and user; the first
 * time a user sets a date/time reminder without one, the reminder is parked
 * here (in memory, one per user, for a few minutes) while the bot asks for
 * the zone, and `timezone <zone>` then creates it. Platform-agnostic: the
 * Discord and Fluxer handlers only do the replies and permission checks.
 */
import { Reminder, ReminderPlatform } from '../../db/entities/Reminder';
import { UserTimezoneRepository } from '../../db/repositories/UserTimezoneRepository';
import ReminderService, { CreateReminderFailure } from './ReminderService';
import { ReminderDateSpec, resolveReminderDate } from './reminderDate';

/** How long a reminder waiting for the user's time zone is kept. */
export const PENDING_REMINDER_TTL_MS = 10 * 60 * 1000;

/** A date/time reminder that is validated and only waits for a zone. */
export interface PendingDateReminderInput {
    guildId: string;
    /** Channel the reminder is posted into (permissions already checked). */
    channelId: string;
    /** Channel the `remindme` was typed in, for the confirmation wording. */
    originChannelId: string;
    spec: ReminderDateSpec;
    message: string;
}

export interface PendingDateReminder extends PendingDateReminderInput {
    /** Epoch ms after which the pending reminder is dropped. */
    expiresAt: number;
}

export interface DateReminderInput {
    guildId: string;
    channelId: string;
    spec: ReminderDateSpec;
    message: string;
}

export type DateReminderFailure =
    | CreateReminderFailure
    | 'invalid_date'
    | 'in_past';

export type DateReminderResult =
    | {
          ok: true;
          reminder: Reminder;
          /** Offset from now the reminder was created with. */
          delayMs: number;
          timeZone: string;
      }
    | {
          ok: false;
          /**
           * `invalid_date`: the date does not exist (e.g. `Feb 29 2027`);
           * `in_past`: it resolved to a time already gone (`Oct 26 2020`,
           * `today 8am` in the afternoon).
           */
          reason: DateReminderFailure;
      };

export interface ReminderTimezoneServiceOptions {
    /** Clock; defaults to `Date.now`. Tests pass a fixed function. */
    now?: () => number;
    /** Lifetime of a pending reminder; default {@link PENDING_REMINDER_TTL_MS}. */
    pendingTtlMs?: number;
}

const OFFSET_ZONE_RE = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i;

/**
 * Epoch ms and zone as a wall-clock string in that zone, e.g.
 * `Mon, Oct 26, 2026, 20:15`. Fixed offsets (`UTC+05:30`) are applied by
 * hand since not every ICU build takes them as a `timeZone`; an unknown zone
 * falls back to UTC.
 */
export function formatLocalDateTime(ms: number, timeZone: string): string {
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    };
    const offset = OFFSET_ZONE_RE.exec(timeZone.trim());
    if (offset) {
        const sign = offset[1] === '-' ? -1 : 1;
        const minutes =
            sign * (Number(offset[2] ?? 0) * 60 + Number(offset[3] ?? 0));
        return new Intl.DateTimeFormat('en-US', {
            ...options,
            timeZone: 'UTC',
        }).format(new Date(ms + minutes * 60 * 1000));
    }
    try {
        return new Intl.DateTimeFormat('en-US', {
            ...options,
            timeZone,
        }).format(new Date(ms));
    } catch {
        return new Intl.DateTimeFormat('en-US', {
            ...options,
            timeZone: 'UTC',
        }).format(new Date(ms));
    }
}

export default class ReminderTimezoneService {
    private readonly now: () => number;
    private readonly pendingTtlMs: number;
    private readonly pending = new Map<string, PendingDateReminder>();

    constructor(
        private readonly repo: UserTimezoneRepository,
        private readonly reminderService: ReminderService,
        options: ReminderTimezoneServiceOptions = {}
    ) {
        this.now = options.now ?? Date.now;
        this.pendingTtlMs = options.pendingTtlMs ?? PENDING_REMINDER_TTL_MS;
    }

    private static key(platform: ReminderPlatform, userId: string): string {
        return `${platform}:${userId}`;
    }

    /** The current time of the service clock (epoch ms). */
    currentTime(): number {
        return this.now();
    }

    getTimeZone(
        platform: ReminderPlatform,
        userId: string
    ): Promise<string | null> {
        return this.repo.get(platform, userId);
    }

    setTimeZone(
        platform: ReminderPlatform,
        userId: string,
        timeZone: string
    ): Promise<void> {
        return this.repo.set(platform, userId, timeZone);
    }

    /** Forgets the user's zone; true when one was stored. */
    clearTimeZone(
        platform: ReminderPlatform,
        userId: string
    ): Promise<boolean> {
        return this.repo.delete(platform, userId);
    }

    /**
     * Parks a date/time reminder until the user sets a zone. One per user:
     * a newer one replaces the older. Expired entries are pruned here so the
     * map cannot grow without bound.
     */
    setPending(
        platform: ReminderPlatform,
        userId: string,
        input: PendingDateReminderInput
    ): PendingDateReminder {
        const now = this.now();
        for (const [key, entry] of this.pending) {
            if (entry.expiresAt <= now) this.pending.delete(key);
        }
        const entry = { ...input, expiresAt: now + this.pendingTtlMs };
        this.pending.set(ReminderTimezoneService.key(platform, userId), entry);
        return entry;
    }

    /** The user's unexpired pending reminder without removing it. */
    peekPending(
        platform: ReminderPlatform,
        userId: string
    ): PendingDateReminder | null {
        const key = ReminderTimezoneService.key(platform, userId);
        const entry = this.pending.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= this.now()) {
            this.pending.delete(key);
            return null;
        }
        return entry;
    }

    /** Removes and returns the user's unexpired pending reminder. */
    takePending(
        platform: ReminderPlatform,
        userId: string
    ): PendingDateReminder | null {
        const entry = this.peekPending(platform, userId);
        this.pending.delete(ReminderTimezoneService.key(platform, userId));
        return entry;
    }

    /**
     * Resolves `spec` in `timeZone` and creates the reminder through the
     * reminder service, whose limits (too soon, more than ten years ahead,
     * too many reminders) still apply.
     */
    async createDateReminder(
        platform: ReminderPlatform,
        userId: string,
        input: DateReminderInput,
        timeZone: string
    ): Promise<DateReminderResult> {
        const now = this.now();
        const dueAt = resolveReminderDate(input.spec, timeZone, now);
        if (dueAt === null) return { ok: false, reason: 'invalid_date' };
        if (dueAt <= now) return { ok: false, reason: 'in_past' };
        const delayMs = dueAt - now;
        const result = await this.reminderService.create({
            platform,
            userId,
            guildId: input.guildId,
            channelId: input.channelId,
            message: input.message,
            delayMs,
        });
        if (!result.ok) return result;
        return { ok: true, reminder: result.reminder, delayMs, timeZone };
    }
}
