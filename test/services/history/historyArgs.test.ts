import { describe, expect, it } from 'vitest';
import {
    HISTORY_COMMAND_NAMES,
    HistoryArgsFailure,
    HistoryArgsLimits,
    historyFailureMessage,
    parseHistoryArgs,
    parseMessageRef,
} from '../../../src/services/history/historyArgs';
import { HistoryOptions } from '../../../src/services/history/HistorySource';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIMITS: HistoryArgsLimits = { defaultCount: 100, maxCount: 1000 };
const OLDER_ID = '1561105750388908000';
const NEWER_ID = '1561105750388908999';

/** The options for `history <count>` without any switch. */
function bare(count: number | null): HistoryOptions {
    return {
        count,
        maxAgeMs: null,
        afterId: null,
        beforeId: null,
        mode: 'messages',
        timestamps: true,
    };
}

function parseStart(raw: string) {
    const result = parseHistoryArgs(raw, LIMITS);
    if (!result.ok || result.action !== 'start') {
        throw new Error(
            `expected ${JSON.stringify(raw)} to start a transfer, got ${JSON.stringify(result)}`
        );
    }
    return result;
}

function parseFail(raw: string): HistoryArgsFailure {
    const result = parseHistoryArgs(raw, LIMITS);
    if (result.ok) {
        throw new Error(
            `expected ${JSON.stringify(raw)} to fail, got ${JSON.stringify(result)}`
        );
    }
    return result;
}

describe('constants', () => {
    it('names history first and backfill as its alias', () => {
        expect(HISTORY_COMMAND_NAMES).toEqual(['history', 'backfill']);
    });
});

describe('parseHistoryArgs count', () => {
    it('uses the default count without arguments', () => {
        const result = parseStart('');
        expect(result.options).toEqual(bare(100));
        expect(result.needsConfirm).toBe(false);
    });

    it('accepts a count from 1 to the configured maximum', () => {
        expect(parseStart('1').options).toEqual(bare(1));
        expect(parseStart('500').options).toEqual(bare(500));
        expect(parseStart('1000').options).toEqual(bare(1000));
        expect(parseStart('  250  ').options).toEqual(bare(250));
    });

    it('rejects counts outside the range or that are not whole numbers', () => {
        for (const value of ['0', '1001', 'abc', '1e3', '2.5', '-5']) {
            expect(parseFail(value)).toEqual({
                ok: false,
                reason: 'invalid_count',
                value,
                maxCount: 1000,
            });
        }
    });

    it('honours a different maximum', () => {
        const result = parseHistoryArgs('150', {
            defaultCount: 50,
            maxCount: 100,
        });
        expect(result).toMatchObject({
            ok: false,
            reason: 'invalid_count',
            maxCount: 100,
        });
        const ok = parseHistoryArgs('', { defaultCount: 50, maxCount: 100 });
        expect(ok).toMatchObject({ ok: true, options: { count: 50 } });
    });

    it('treats all as the whole history and asks for a confirmation', () => {
        for (const raw of ['all', 'ALL', 'All']) {
            const result = parseStart(raw);
            expect(result.options).toEqual(bare(null));
            expect(result.needsConfirm).toBe(true);
        }
    });

    it('rejects a second positional argument', () => {
        expect(parseFail('5 10')).toEqual({
            ok: false,
            reason: 'too_many_args',
            value: '10',
        });
        expect(parseFail('all 5')).toEqual({
            ok: false,
            reason: 'too_many_args',
            value: '5',
        });
    });
});

describe('parseHistoryArgs actions', () => {
    it('recognises confirm, status and stop case-insensitively', () => {
        expect(parseHistoryArgs('confirm', LIMITS)).toEqual({
            ok: true,
            action: 'confirm',
        });
        expect(parseHistoryArgs('status', LIMITS)).toEqual({
            ok: true,
            action: 'status',
        });
        expect(parseHistoryArgs('stop', LIMITS)).toEqual({
            ok: true,
            action: 'stop',
        });
        expect(parseHistoryArgs('STOP', LIMITS)).toEqual({
            ok: true,
            action: 'stop',
        });
        expect(parseHistoryArgs(' Status ', LIMITS)).toEqual({
            ok: true,
            action: 'status',
        });
    });

    it('treats cancel as stop', () => {
        expect(parseHistoryArgs('cancel', LIMITS)).toEqual({
            ok: true,
            action: 'stop',
        });
        expect(parseHistoryArgs('Cancel', LIMITS)).toEqual({
            ok: true,
            action: 'stop',
        });
    });

    it('allows no other tokens with an action word', () => {
        expect(parseFail('status 5')).toEqual({
            ok: false,
            reason: 'action_with_args',
            action: 'status',
            value: '5',
        });
        expect(parseFail('stop -digest')).toEqual({
            ok: false,
            reason: 'action_with_args',
            action: 'stop',
            value: '-digest',
        });
        expect(parseFail('-ma 1h confirm')).toEqual({
            ok: false,
            reason: 'action_with_args',
            action: 'confirm',
            value: '-ma',
        });
        expect(parseFail('cancel all')).toEqual({
            ok: false,
            reason: 'action_with_args',
            action: 'cancel',
            value: 'all',
        });
    });
});

describe('parseHistoryArgs switches', () => {
    it('parses -ma with the reminder duration syntax', () => {
        expect(parseStart('-ma 2d').options.maxAgeMs).toBe(2 * DAY_MS);
        expect(parseStart('50 -ma 1h30m').options).toEqual({
            ...bare(50),
            maxAgeMs: HOUR_MS + 30 * MINUTE_MS,
        });
        expect(parseStart('-ma 90').options.maxAgeMs).toBe(90 * MINUTE_MS);
        expect(parseStart('-MA 1h').options.maxAgeMs).toBe(HOUR_MS);
    });

    it('treats a zero max age as no limit', () => {
        expect(parseStart('-ma 0').options.maxAgeMs).toBeNull();
    });

    it('keeps a quoted duration together', () => {
        expect(parseStart('-ma "1h 30m"').options.maxAgeMs).toBe(
            HOUR_MS + 30 * MINUTE_MS
        );
    });

    it('rejects an invalid duration', () => {
        expect(parseFail('-ma xyz')).toEqual({
            ok: false,
            reason: 'invalid_duration',
            switch: '-ma',
            value: 'xyz',
        });
        expect(parseFail('-ma 1x')).toMatchObject({
            reason: 'invalid_duration',
        });
    });

    it('rejects a value switch without a value', () => {
        expect(parseFail('-ma')).toEqual({
            ok: false,
            reason: 'missing_switch_value',
            switch: '-ma',
        });
        expect(parseFail('50 -after')).toEqual({
            ok: false,
            reason: 'missing_switch_value',
            switch: '-after',
        });
        expect(parseFail('-before')).toEqual({
            ok: false,
            reason: 'missing_switch_value',
            switch: '-before',
        });
    });

    it('parses -after and -before as message ids', () => {
        expect(parseStart(`-after ${OLDER_ID}`).options).toEqual({
            ...bare(100),
            afterId: OLDER_ID,
        });
        expect(parseStart(`-before ${NEWER_ID}`).options).toEqual({
            ...bare(100),
            beforeId: NEWER_ID,
        });
        expect(
            parseStart(`all -after ${OLDER_ID} -before ${NEWER_ID}`).options
        ).toEqual({ ...bare(null), afterId: OLDER_ID, beforeId: NEWER_ID });
    });

    it('accepts message links for -after and -before', () => {
        expect(
            parseStart(
                `-after https://discord.com/channels/111/222/${OLDER_ID}`
            ).options.afterId
        ).toBe(OLDER_ID);
        expect(
            parseStart(
                `-before <https://fluxer.app/channels/111/222/${NEWER_ID}>`
            ).options.beforeId
        ).toBe(NEWER_ID);
    });

    it('rejects invalid message references', () => {
        expect(parseFail('-after abc')).toEqual({
            ok: false,
            reason: 'invalid_message_id',
            switch: '-after',
            value: 'abc',
        });
        expect(parseFail('-before <@123>')).toEqual({
            ok: false,
            reason: 'invalid_message_id',
            switch: '-before',
            value: '<@123>',
        });
        expect(parseFail(`-after ${'9'.repeat(26)}`)).toMatchObject({
            reason: 'invalid_message_id',
        });
    });

    it('requires -after to be older than -before', () => {
        expect(parseFail(`-after ${NEWER_ID} -before ${OLDER_ID}`)).toEqual({
            ok: false,
            reason: 'invalid_range',
            afterId: NEWER_ID,
            beforeId: OLDER_ID,
        });
        expect(parseFail(`-after ${OLDER_ID} -before ${OLDER_ID}`)).toEqual({
            ok: false,
            reason: 'invalid_range',
            afterId: OLDER_ID,
            beforeId: OLDER_ID,
        });
    });

    it('parses -digest and -notime anywhere', () => {
        expect(parseStart('-digest').options).toEqual({
            ...bare(100),
            mode: 'digest',
        });
        expect(parseStart('-notime 20').options).toEqual({
            ...bare(20),
            timestamps: false,
        });
        expect(parseStart('-digest 50 -notime -ma 1d').options).toEqual({
            ...bare(50),
            mode: 'digest',
            timestamps: false,
            maxAgeMs: DAY_MS,
        });
        expect(parseStart('-DIGEST').options.mode).toBe('digest');
    });

    it('rejects unknown switches', () => {
        expect(parseFail('-x')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-x',
        });
        expect(parseFail('50 -r foo')).toEqual({
            ok: false,
            reason: 'unknown_switch',
            value: '-r',
        });
    });

    it('treats a lone dash as a positional', () => {
        expect(parseFail('-')).toMatchObject({
            reason: 'invalid_count',
            value: '-',
        });
    });
});

describe('parseMessageRef', () => {
    it('accepts snowflakes and message links', () => {
        expect(parseMessageRef(OLDER_ID)).toBe(OLDER_ID);
        expect(parseMessageRef('1')).toBe('1');
        expect(
            parseMessageRef(`https://discord.com/channels/1/2/${OLDER_ID}`)
        ).toBe(OLDER_ID);
        expect(
            parseMessageRef(`https://discord.com/channels/1/2/${OLDER_ID}/`)
        ).toBe(OLDER_ID);
        expect(
            parseMessageRef(
                `http://fluxer.example/channels/1/2/${OLDER_ID}?x=1`
            )
        ).toBe(OLDER_ID);
    });

    it('rejects anything else', () => {
        expect(parseMessageRef('')).toBeNull();
        expect(parseMessageRef('abc')).toBeNull();
        expect(
            parseMessageRef('https://discord.com/channels/1/2/abc')
        ).toBeNull();
        expect(parseMessageRef('<@123>')).toBeNull();
    });
});

describe('historyFailureMessage', () => {
    it('describes every failure, quoting the offending value', () => {
        const failures: HistoryArgsFailure[] = [
            { reason: 'invalid_count', value: '5000', maxCount: 1000 },
            { reason: 'too_many_args', value: 'extra' },
            { reason: 'action_with_args', action: 'status', value: '5' },
            { reason: 'unknown_switch', value: '-x' },
            { reason: 'missing_switch_value', switch: '-ma' },
            { reason: 'invalid_duration', switch: '-ma', value: 'xyz' },
            { reason: 'invalid_message_id', switch: '-after', value: 'abc' },
            { reason: 'invalid_range', afterId: '20', beforeId: '10' },
        ];
        for (const failure of failures) {
            const message = historyFailureMessage(failure);
            expect(message.length).toBeGreaterThan(0);
            if ('value' in failure) expect(message).toContain(failure.value);
            if ('switch' in failure) expect(message).toContain(failure.switch);
        }
        expect(
            historyFailureMessage({
                reason: 'invalid_count',
                value: '5000',
                maxCount: 1000,
            })
        ).toContain('1000');
        expect(
            historyFailureMessage({
                reason: 'invalid_range',
                afterId: '20',
                beforeId: '10',
            })
        ).toContain('`20`');
    });

    it('strips backticks from quoted values', () => {
        expect(
            historyFailureMessage({ reason: 'unknown_switch', value: '-`x`' })
        ).toContain('`-x`');
    });
});
