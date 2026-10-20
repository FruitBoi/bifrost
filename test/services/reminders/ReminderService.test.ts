import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reminder, ReminderPlatform } from '../../../src/db/entities/Reminder';
import {
    CreateReminderData,
    ReminderRepository,
} from '../../../src/db/repositories/ReminderRepository';
import {
    ReminderDeliverer,
    ReminderDeliveryError,
} from '../../../src/services/reminders/ReminderDeliverer';
import ReminderService, {
    MAX_REMINDER_MESSAGE_LENGTH,
    MAX_REMINDER_OFFSET_MS,
    MAX_REMINDERS_PER_USER,
    MIN_REMINDER_OFFSET_MS,
} from '../../../src/services/reminders/ReminderService';

/** In-memory ReminderRepository with the same ordering as the table. */
class MemoryReminderRepository implements ReminderRepository {
    rows: Reminder[] = [];
    private seq = 0;
    findDueCalls = 0;

    async create(data: CreateReminderData): Promise<Reminder> {
        const row: Reminder = {
            id: ++this.seq,
            ...data,
            attempts: 0,
            createdAt: new Date(),
        };
        this.rows.push(row);
        return { ...row };
    }
    async findById(id: number) {
        const row = this.rows.find((r) => r.id === id);
        return row ? { ...row } : null;
    }
    async findByUser(
        platform: ReminderPlatform,
        userId: string,
        guildId?: string
    ) {
        return this.sorted(
            this.rows.filter(
                (r) =>
                    r.platform === platform &&
                    r.userId === userId &&
                    (guildId === undefined || r.guildId === guildId)
            )
        );
    }
    async findByChannel(platform: ReminderPlatform, channelId: string) {
        return this.sorted(
            this.rows.filter(
                (r) => r.platform === platform && r.channelId === channelId
            )
        );
    }
    async countByUser(platform: ReminderPlatform, userId: string) {
        return this.rows.filter(
            (r) => r.platform === platform && r.userId === userId
        ).length;
    }
    async findDue(before: Date, limit = 100) {
        this.findDueCalls++;
        return this.sorted(
            this.rows.filter((r) => r.dueAt.getTime() <= before.getTime())
        ).slice(0, limit);
    }
    async incrementAttempts(id: number) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.attempts++;
    }
    async deleteById(id: number) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.id !== id);
        return this.rows.length < before;
    }
    async deleteByUser(platform: ReminderPlatform, userId: string) {
        const before = this.rows.length;
        this.rows = this.rows.filter(
            (r) => !(r.platform === platform && r.userId === userId)
        );
        return before - this.rows.length;
    }
    async count() {
        return this.rows.length;
    }
    private sorted(rows: Reminder[]): Reminder[] {
        return [...rows]
            .sort(
                (a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id - b.id
            )
            .map((r) => ({ ...r }));
    }
}

/** A deliverer that records calls and fails the way it is told to. */
class FakeDeliverer implements ReminderDeliverer {
    delivered: Reminder[] = [];
    failWith: unknown = null;
    /** When set, deliver() awaits this before finishing. */
    gate: Promise<void> | null = null;

    async deliver(reminder: Reminder): Promise<void> {
        if (this.gate) await this.gate;
        if (this.failWith) throw this.failWith;
        this.delivered.push(reminder);
    }
}

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const input = (
    overrides: Partial<Parameters<ReminderService['create']>[0]> = {}
) => ({
    platform: 'discord' as ReminderPlatform,
    userId: 'u1',
    guildId: 'g1',
    channelId: 'c1',
    message: 'buy milk',
    delayMs: HOUR,
    ...overrides,
});

describe('ReminderService', () => {
    let repo: MemoryReminderRepository;
    let service: ReminderService;

    beforeEach(() => {
        repo = new MemoryReminderRepository();
        service = new ReminderService(repo, { now: () => NOW });
    });

    describe('create', () => {
        it('stores a trimmed message due now + delay', async () => {
            const result = await service.create(
                input({ message: '  buy milk \n', delayMs: HOUR })
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.reminder).toMatchObject({
                id: 1,
                platform: 'discord',
                userId: 'u1',
                guildId: 'g1',
                channelId: 'c1',
                message: 'buy milk',
                attempts: 0,
            });
            expect(result.reminder.dueAt.getTime()).toBe(NOW + HOUR);
            expect(await repo.count()).toBe(1);
        });

        it('keeps inner whitespace and newlines of the message', async () => {
            const result = await service.create(
                input({ message: 'line one\n\n  line two' })
            );
            expect(result).toMatchObject({
                ok: true,
                reminder: { message: 'line one\n\n  line two' },
            });
        });

        it('rejects an empty message', async () => {
            expect(await service.create(input({ message: '' }))).toEqual({
                ok: false,
                reason: 'empty_message',
            });
            expect(await service.create(input({ message: ' \n\t ' }))).toEqual({
                ok: false,
                reason: 'empty_message',
            });
            expect(await repo.count()).toBe(0);
        });

        it('rejects a message over the limit but allows one exactly at it', async () => {
            expect(
                await service.create(
                    input({ message: 'a'.repeat(MAX_REMINDER_MESSAGE_LENGTH) })
                )
            ).toMatchObject({ ok: true });
            expect(
                await service.create(
                    input({
                        message: 'a'.repeat(MAX_REMINDER_MESSAGE_LENGTH + 1),
                    })
                )
            ).toEqual({ ok: false, reason: 'message_too_long' });
            // Trimming happens before the length check.
            expect(
                await service.create(
                    input({
                        message: ` ${'a'.repeat(MAX_REMINDER_MESSAGE_LENGTH)} `,
                    })
                )
            ).toMatchObject({ ok: true });
            expect(MAX_REMINDER_MESSAGE_LENGTH).toBe(2000);
        });

        it('rejects delays below the minimum but allows the minimum', async () => {
            expect(MIN_REMINDER_OFFSET_MS).toBe(1000);
            expect(
                await service.create(input({ delayMs: 1000 }))
            ).toMatchObject({ ok: true });
            expect(await service.create(input({ delayMs: 999 }))).toEqual({
                ok: false,
                reason: 'too_short',
            });
            expect(await service.create(input({ delayMs: 0 }))).toEqual({
                ok: false,
                reason: 'too_short',
            });
            expect(await service.create(input({ delayMs: -HOUR }))).toEqual({
                ok: false,
                reason: 'too_short',
            });
            expect(await service.create(input({ delayMs: NaN }))).toEqual({
                ok: false,
                reason: 'too_short',
            });
        });

        it('rejects delays above ten years but allows exactly ten years', async () => {
            expect(MAX_REMINDER_OFFSET_MS).toBe(10 * 365 * 24 * 60 * 60 * 1000);
            const tenYears = await service.create(
                input({ delayMs: MAX_REMINDER_OFFSET_MS })
            );
            expect(tenYears).toMatchObject({ ok: true });
            if (tenYears.ok) {
                expect(tenYears.reminder.dueAt.getTime()).toBe(
                    NOW + MAX_REMINDER_OFFSET_MS
                );
            }
            expect(
                await service.create(
                    input({ delayMs: MAX_REMINDER_OFFSET_MS + 1 })
                )
            ).toEqual({ ok: false, reason: 'too_long' });
            expect(await service.create(input({ delayMs: Infinity }))).toEqual({
                ok: false,
                reason: 'too_long',
            });
        });

        it('checks the message before the delay', async () => {
            expect(
                await service.create(input({ message: '', delayMs: 0 }))
            ).toEqual({ ok: false, reason: 'empty_message' });
            expect(
                await service.create(
                    input({
                        message: 'a'.repeat(MAX_REMINDER_MESSAGE_LENGTH + 1),
                        delayMs: 0,
                    })
                )
            ).toEqual({ ok: false, reason: 'message_too_long' });
        });

        it('caps reminders per user across guilds of the platform', async () => {
            expect(MAX_REMINDERS_PER_USER).toBe(25);
            for (let i = 0; i < MAX_REMINDERS_PER_USER; i++) {
                expect(
                    await service.create(
                        input({ guildId: i % 2 === 0 ? 'g1' : 'g2' })
                    )
                ).toMatchObject({ ok: true });
            }
            expect(await service.create(input({ guildId: 'g3' }))).toEqual({
                ok: false,
                reason: 'too_many',
            });
            // Other users and the same user on the other platform are not affected.
            expect(await service.create(input({ userId: 'u2' }))).toMatchObject(
                { ok: true }
            );
            expect(
                await service.create(input({ platform: 'fluxer' }))
            ).toMatchObject({ ok: true });
            expect(await service.countForUser('discord', 'u1')).toBe(25);
            // Deleting one frees a slot.
            expect(await service.delete(1)).toBe(true);
            expect(await service.create(input())).toMatchObject({ ok: true });
        });

        it('reports too_many only after the other checks pass', async () => {
            for (let i = 0; i < MAX_REMINDERS_PER_USER; i++) {
                await service.create(input());
            }
            expect(await service.create(input({ delayMs: 1 }))).toEqual({
                ok: false,
                reason: 'too_short',
            });
        });
    });

    describe('listing and deleting', () => {
        it("lists a user's reminders in one guild, soonest first", async () => {
            await service.create(input({ delayMs: 3 * HOUR }));
            await service.create(input({ delayMs: HOUR }));
            await service.create(input({ delayMs: 2 * HOUR, guildId: 'g2' }));
            await service.create(input({ delayMs: HOUR, userId: 'u2' }));
            await service.create(input({ delayMs: HOUR, platform: 'fluxer' }));

            expect(
                (await service.listForUser('discord', 'u1', 'g1')).map(
                    (r) => r.id
                )
            ).toEqual([2, 1]);
            expect(
                (await service.listForUser('discord', 'u1', 'g2')).map(
                    (r) => r.id
                )
            ).toEqual([3]);
            expect(await service.listForUser('discord', 'u1', 'g9')).toEqual(
                []
            );
            expect(
                (await service.listForUser('fluxer', 'u1', 'g1')).map(
                    (r) => r.id
                )
            ).toEqual([5]);
            expect(await service.countForUser('discord', 'u1')).toBe(3);
        });

        it('lists every reminder in a channel', async () => {
            await service.create(input({ delayMs: 2 * HOUR }));
            await service.create(input({ delayMs: HOUR, userId: 'u2' }));
            await service.create(input({ channelId: 'c2' }));
            await service.create(input({ platform: 'fluxer' }));
            expect(
                (await service.listForChannel('discord', 'c1')).map((r) => r.id)
            ).toEqual([2, 1]);
        });

        it('gets and deletes by id', async () => {
            await service.create(input());
            expect(await service.getById(1)).toMatchObject({
                id: 1,
                message: 'buy milk',
            });
            expect(await service.getById(2)).toBeNull();
            expect(await service.delete(1)).toBe(true);
            expect(await service.delete(1)).toBe(false);
            expect(await service.getById(1)).toBeNull();
        });

        it('deletes all reminders of one user on one platform only', async () => {
            await service.create(input({ guildId: 'g1' }));
            await service.create(input({ guildId: 'g2' }));
            await service.create(input({ userId: 'u2' }));
            await service.create(input({ platform: 'fluxer' }));
            expect(await service.deleteAllForUser('discord', 'u1')).toBe(2);
            expect(await service.deleteAllForUser('discord', 'u1')).toBe(0);
            expect(repo.rows.map((r) => r.id)).toEqual([3, 4]);
        });
    });

    describe('deliverDue', () => {
        let discord: FakeDeliverer;
        let fluxer: FakeDeliverer;

        beforeEach(() => {
            discord = new FakeDeliverer();
            fluxer = new FakeDeliverer();
            service.setDeliverer('discord', discord);
            service.setDeliverer('fluxer', fluxer);
        });

        /** Creates a reminder (via the repo, so it may already be due). */
        const seed = (
            dueAt: number,
            overrides: Partial<CreateReminderData> = {}
        ) =>
            repo.create({
                platform: 'discord',
                userId: 'u1',
                guildId: 'g1',
                channelId: 'c1',
                message: 'm',
                dueAt: new Date(dueAt),
                ...overrides,
            });

        it('delivers due reminders on their platform and deletes them', async () => {
            await seed(NOW - 1000);
            await seed(NOW);
            await seed(NOW - 5000, { platform: 'fluxer' });
            await seed(NOW + 1);

            await service.deliverDue();

            expect(discord.delivered.map((r) => r.id)).toEqual([1, 2]);
            expect(fluxer.delivered.map((r) => r.id)).toEqual([3]);
            expect(repo.rows.map((r) => r.id)).toEqual([4]);
        });

        it('delivers overdue reminders soonest first', async () => {
            await seed(NOW - 1000);
            await seed(NOW - 3000);
            await seed(NOW - 2000);
            await service.deliverDue();
            expect(discord.delivered.map((r) => r.id)).toEqual([2, 3, 1]);
        });

        it('does nothing when nothing is due', async () => {
            await seed(NOW + HOUR);
            await service.deliverDue();
            expect(discord.delivered).toEqual([]);
            expect(repo.rows).toHaveLength(1);
        });

        it('drops a reminder on a permanent delivery error', async () => {
            await seed(NOW - 1000);
            discord.failWith = new ReminderDeliveryError('channel gone', true);
            await service.deliverDue();
            expect(repo.rows).toEqual([]);
        });

        it('increments attempts and keeps the row on a transient error', async () => {
            await seed(NOW - 1000);
            discord.failWith = new Error('network');
            await service.deliverDue();
            expect(repo.rows).toHaveLength(1);
            expect(repo.rows[0].attempts).toBe(1);

            discord.failWith = new ReminderDeliveryError('rate limited', false);
            await service.deliverDue();
            expect(repo.rows[0].attempts).toBe(2);

            // Once the platform recovers the reminder goes out.
            discord.failWith = null;
            await service.deliverDue();
            expect(discord.delivered.map((r) => r.id)).toEqual([1]);
            expect(repo.rows).toEqual([]);
        });

        it('drops a reminder after maxAttempts failed deliveries', async () => {
            service = new ReminderService(repo, {
                now: () => NOW,
                maxAttempts: 3,
            });
            service.setDeliverer('discord', discord);
            await seed(NOW - 1000);
            discord.failWith = new Error('network');

            await service.deliverDue();
            expect(repo.rows[0].attempts).toBe(1);
            await service.deliverDue();
            expect(repo.rows[0].attempts).toBe(2);
            await service.deliverDue();
            expect(repo.rows).toEqual([]);
            expect(discord.delivered).toEqual([]);
        });

        it('uses the default of five attempts', async () => {
            await seed(NOW - 1000);
            discord.failWith = new Error('network');
            for (let i = 1; i <= 4; i++) {
                await service.deliverDue();
                expect(repo.rows[0].attempts).toBe(i);
            }
            await service.deliverDue();
            expect(repo.rows).toEqual([]);
        });

        it('skips reminders whose platform has no deliverer', async () => {
            service.setDeliverer('fluxer', null);
            await seed(NOW - 1000, { platform: 'fluxer' });
            await seed(NOW - 1000);
            await service.deliverDue();
            expect(fluxer.delivered).toEqual([]);
            expect(discord.delivered.map((r) => r.id)).toEqual([2]);
            expect(repo.rows.map((r) => r.id)).toEqual([1]);
            expect(repo.rows[0].attempts).toBe(0);

            // Registering the deliverer later delivers it on the next tick.
            service.setDeliverer('fluxer', fluxer);
            await service.deliverDue();
            expect(fluxer.delivered.map((r) => r.id)).toEqual([1]);
            expect(repo.rows).toEqual([]);
        });

        it('never rejects, even when the repository fails', async () => {
            repo.findDue = async () => {
                throw new Error('db down');
            };
            await expect(service.deliverDue()).resolves.toBeUndefined();

            repo = new MemoryReminderRepository();
            service = new ReminderService(repo, { now: () => NOW });
            service.setDeliverer('discord', discord);
            await seed(NOW - 1000);
            repo.deleteById = async () => {
                throw new Error('db down');
            };
            await expect(service.deliverDue()).resolves.toBeUndefined();
            expect(discord.delivered).toHaveLength(1);

            // A later tick still works.
            repo.deleteById = async () => {
                throw new Error('db down');
            };
            discord.failWith = new Error('boom');
            await expect(service.deliverDue()).resolves.toBeUndefined();
        });

        it('does not run two ticks at once', async () => {
            await seed(NOW - 1000);
            let release!: () => void;
            discord.gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            const first = service.deliverDue();
            const second = service.deliverDue();
            await second;
            expect(discord.delivered).toEqual([]);
            expect(repo.findDueCalls).toBe(1);

            release();
            await first;
            expect(discord.delivered.map((r) => r.id)).toEqual([1]);
            expect(repo.rows).toEqual([]);

            // After the tick finished, a new one runs again.
            discord.gate = null;
            await seed(NOW - 1000);
            await service.deliverDue();
            expect(repo.findDueCalls).toBe(2);
            expect(discord.delivered.map((r) => r.id)).toEqual([1, 2]);
        });
    });

    describe('start / stop', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            service.stop();
            vi.useRealTimers();
        });

        it('ticks immediately, then every interval, until stopped', async () => {
            service = new ReminderService(repo, {
                now: () => NOW,
                tickIntervalMs: 1000,
            });
            const discord = new FakeDeliverer();
            service.setDeliverer('discord', discord);
            await repo.create({
                platform: 'discord',
                userId: 'u1',
                guildId: 'g1',
                channelId: 'c1',
                message: 'm',
                dueAt: new Date(NOW - 1),
            });

            service.start();
            expect(repo.findDueCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(0);
            expect(discord.delivered.map((r) => r.id)).toEqual([1]);

            await vi.advanceTimersByTimeAsync(999);
            expect(repo.findDueCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(repo.findDueCalls).toBe(2);
            await vi.advanceTimersByTimeAsync(2000);
            expect(repo.findDueCalls).toBe(4);

            service.stop();
            await vi.advanceTimersByTimeAsync(5000);
            expect(repo.findDueCalls).toBe(4);
        });

        it('is idempotent', async () => {
            service = new ReminderService(repo, {
                now: () => NOW,
                tickIntervalMs: 1000,
            });
            service.start();
            service.start();
            expect(repo.findDueCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(1000);
            expect(repo.findDueCalls).toBe(2);
            service.stop();
            service.stop();
            await vi.advanceTimersByTimeAsync(3000);
            expect(repo.findDueCalls).toBe(2);
        });

        it('defaults to a ten second interval', async () => {
            service = new ReminderService(repo, { now: () => NOW });
            service.start();
            expect(repo.findDueCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(9_999);
            expect(repo.findDueCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(repo.findDueCalls).toBe(2);
        });
    });
});
