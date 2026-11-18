import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpsecService, {
    OPSEC_ACTIVITY_DELAY_MS,
    OPSEC_DEFAULT_DURATION_MS,
    opsecEndMessage,
    opsecStartMessage,
    parseOpsecArgs,
} from '../../../src/services/opsec/OpsecService';

describe('parseOpsecArgs', () => {
    it('defaults to 30 minutes', () => {
        expect(parseOpsecArgs(['on'])).toEqual({
            action: 'on',
            durationMs: OPSEC_DEFAULT_DURATION_MS,
        });
        expect(OPSEC_DEFAULT_DURATION_MS).toBe(30 * 60_000);
    });
    it('parses durations', () => {
        expect(parseOpsecArgs(['ON', '10'])).toEqual({
            action: 'on',
            durationMs: 10 * 60_000,
        });
        expect(parseOpsecArgs(['on', '1h30m'])).toEqual({
            action: 'on',
            durationMs: 90 * 60_000,
        });
        expect(parseOpsecArgs(['1h'])).toEqual({
            action: 'on',
            durationMs: 60 * 60_000,
        });
    });
    it('parses off and status', () => {
        expect(parseOpsecArgs(['off', 'x'])).toEqual({ action: 'off' });
        expect(parseOpsecArgs([])).toEqual({ action: 'status' });
        expect(parseOpsecArgs(['status'])).toEqual({ action: 'status' });
    });
    it('rejects bad input', () => {
        expect(parseOpsecArgs(['on', 'soon']).action).toBe('invalid');
        expect(parseOpsecArgs(['on', '0']).action).toBe('invalid');
        expect(parseOpsecArgs(['banana']).action).toBe('invalid');
        const long = parseOpsecArgs(['on', '25h']);
        expect(long).toMatchObject({ action: 'invalid' });
        expect((long as { reason: string }).reason).toContain('24 hours');
    });
});

describe('messages', () => {
    it('contain the required sentences and stay short', () => {
        const start = opsecStartMessage(1_700_000_000_000);
        expect(start).toContain(
            'A fluxer sex session is currently occurring that you are not privy to. Have a nice day Mr. Thiel.'
        );
        expect(start).toContain('<t:1700000000:R>');
        expect(start.length).toBeLessThan(2000);
        expect(opsecEndMessage()).toContain('The sex session has ended.');
        expect(opsecEndMessage().length).toBeLessThan(2000);
    });
});

describe('OpsecService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('tracks an active pause and expires it, removing before onEnd', () => {
        const svc = new OpsecService();
        let activeInEnd: boolean | null = null;
        const onEnd = vi.fn(() => {
            activeInEnd = svc.isActive('c');
        });
        const { endsAt, extended } = svc.start('c', 1000, onEnd);
        expect(extended).toBe(false);
        expect(endsAt).toBe(Date.now() + 1000);
        expect(svc.isActive('c')).toBe(true);
        expect(svc.endsAt('c')).toBe(endsAt);
        vi.advanceTimersByTime(999);
        expect(onEnd).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(activeInEnd).toBe(false);
        expect(svc.endsAt('c')).toBeNull();
    });

    it('stop ends now and only once', () => {
        const svc = new OpsecService();
        const onEnd = vi.fn();
        svc.start('c', 1000, onEnd);
        expect(svc.stop('c')).toBe(true);
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(svc.stop('c')).toBe(false);
        vi.advanceTimersByTime(5000);
        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('extending replaces the timer and onEnd', () => {
        const svc = new OpsecService();
        const first = vi.fn();
        const second = vi.fn();
        svc.start('c', 1000, first);
        vi.advanceTimersByTime(500);
        expect(svc.start('c', 1000, second).extended).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('swallows errors from onEnd', async () => {
        const svc = new OpsecService();
        svc.start('a', 10, () => {
            throw new Error('sync');
        });
        svc.start('b', 10, () => Promise.reject(new Error('async')));
        expect(() => vi.advanceTimersByTime(10)).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(svc.isActive('a')).toBe(false);
        expect(svc.isActive('b')).toBe(false);
    });

    it('delays the end by 3 minutes while people are talking', () => {
        const svc = new OpsecService();
        const onEnd = vi.fn();
        expect(OPSEC_ACTIVITY_DELAY_MS).toBe(3 * 60_000);
        svc.start('c', 10 * 60_000, onEnd);
        vi.advanceTimersByTime(9 * 60_000);
        svc.noteActivity('c');
        vi.advanceTimersByTime(60_000);
        expect(onEnd).not.toHaveBeenCalled();
        expect(svc.isActive('c')).toBe(true);
        expect(svc.endsAt('c')).toBe(Date.now() + OPSEC_ACTIVITY_DELAY_MS);

        // Still talking near the new end: delayed again.
        vi.advanceTimersByTime(2 * 60_000);
        svc.noteActivity('c');
        vi.advanceTimersByTime(60_000);
        expect(onEnd).not.toHaveBeenCalled();

        // Quiet for 3 minutes: it ends.
        vi.advanceTimersByTime(OPSEC_ACTIVITY_DELAY_MS);
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(svc.isActive('c')).toBe(false);
    });

    it('ends on time when the last message is older than 3 minutes', () => {
        const svc = new OpsecService();
        const onEnd = vi.fn();
        svc.start('c', 10 * 60_000, onEnd);
        vi.advanceTimersByTime(60_000);
        svc.noteActivity('c');
        vi.advanceTimersByTime(9 * 60_000);
        expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('ignores activity in channels without a session, and stop still ends now', () => {
        const svc = new OpsecService();
        const onEnd = vi.fn();
        svc.noteActivity('c');
        svc.start('c', 1000, onEnd);
        vi.advanceTimersByTime(1000);
        expect(onEnd).toHaveBeenCalledTimes(1);

        const onEnd2 = vi.fn();
        svc.start('d', 1000, onEnd2);
        svc.noteActivity('d');
        expect(svc.stop('d')).toBe(true);
        expect(onEnd2).toHaveBeenCalledTimes(1);
    });
});
