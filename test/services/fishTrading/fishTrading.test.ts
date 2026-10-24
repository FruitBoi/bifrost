import { describe, expect, it } from 'vitest';
import {
    BARS_PER_DAY,
    FISH_FI_NUMBER,
    FISH_TICKERS,
    buildFishTradeSummary,
    formatTradingDays,
    generateFishMarket,
    mulberry32,
    parseFishTradeArgs,
    runFishStrategy,
    runPoorDecisionsBaseline,
    sanitizeFishName,
    simulateFishTradingDay,
    sparkline,
    tradingDaysToFi,
    type FishTradingDay,
} from '../../../src/services/fishTrading/fishTrading';

describe('mulberry32', () => {
    it('is deterministic per seed and stays in [0, 1)', () => {
        const a = mulberry32(7);
        const b = mulberry32(7);
        const c = mulberry32(8);
        const seqA = Array.from({ length: 50 }, a);
        expect(Array.from({ length: 50 }, b)).toEqual(seqA);
        expect(Array.from({ length: 50 }, c)).not.toEqual(seqA);
        for (const v of seqA) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe('simulateFishTradingDay', () => {
    it('is deterministic for a seed', () => {
        const a = simulateFishTradingDay({ seed: 1234, fishName: 'Bubbles' });
        const b = simulateFishTradingDay({ seed: 1234, fishName: 'Bubbles' });
        expect(b).toEqual(a);
        const c = simulateFishTradingDay({ seed: 1235, fishName: 'Bubbles' });
        expect(c.prices).not.toEqual(a.prices);
    });

    it('uses defaults and picks a fish ticker', () => {
        const day = simulateFishTradingDay({ seed: 5 });
        expect(day.fishName).toBe('your fish');
        expect(day.startingCash).toBe(100);
        expect(FISH_TICKERS).toContain(day.ticker);
        expect(day.strategy).toMatch(/EMA/);
        expect(day.fiNumber).toBe(FISH_FI_NUMBER);
        expect(FISH_FI_NUMBER).toBe(4500);
    });

    it('draws a random seed when none is given', () => {
        const day = simulateFishTradingDay();
        expect(Number.isInteger(day.seed)).toBe(true);
        expect(day.seed).toBeGreaterThanOrEqual(0);
        expect(day.seed).toBeLessThanOrEqual(0xffffffff);
    });

    it('produces 390 positive prices and is flat by the close', () => {
        for (let seed = 0; seed < 100; seed++) {
            const day = simulateFishTradingDay({ seed });
            expect(day.prices).toHaveLength(BARS_PER_DAY);
            expect(day.prices.every((p) => p > 0 && Number.isFinite(p))).toBe(
                true
            );
            let lastExit = -1;
            for (const t of day.trades) {
                expect(t.entryBar).toBeGreaterThan(lastExit);
                expect(t.exitBar).toBeGreaterThanOrEqual(t.entryBar);
                expect(t.exitBar).toBeLessThanOrEqual(BARS_PER_DAY - 1);
                expect(t.shares).toBeGreaterThan(0);
                lastExit = t.exitBar;
            }
            // Ending cash is exactly starting cash plus all round trips.
            const pnl = day.trades.reduce((s, t) => s + t.pnl, 0);
            expect(day.endingCash).toBeCloseTo(day.startingCash + pnl, 6);
            expect(day.maxDrawdownPct).toBeGreaterThanOrEqual(0);
            if (day.winRate !== null) {
                expect(day.winRate).toBeGreaterThanOrEqual(0);
                expect(day.winRate).toBeLessThanOrEqual(1);
            } else {
                expect(day.trades).toHaveLength(0);
            }
        }
    });

    it('closes any open position on the last bar', () => {
        let sawCloseExit = false;
        for (let seed = 0; seed < 200; seed++) {
            const day = simulateFishTradingDay({ seed });
            const run = runFishStrategy(day.prices, day.startingCash);
            expect(run.openPosition).toBe(false);
            if (day.trades.some((t) => t.reason === 'close')) {
                sawCloseExit = true;
                const last = day.trades[day.trades.length - 1];
                expect(last.reason).toBe('close');
                expect(last.exitBar).toBe(BARS_PER_DAY - 1);
            }
        }
        expect(sawCloseExit).toBe(true);
    });

    it('scales with starting cash', () => {
        const small = simulateFishTradingDay({ seed: 9, startingCash: 100 });
        const big = simulateFishTradingDay({ seed: 9, startingCash: 10_000 });
        expect(big.returnPct).toBeCloseTo(small.returnPct, 6);
        expect(big.endingCash).toBeCloseTo(small.endingCash * 100, 4);
    });
});

describe('runFishStrategy', () => {
    it('never looks ahead: future prices do not change earlier trades', () => {
        for (let seed = 0; seed < 40; seed++) {
            const random = mulberry32(seed);
            const prices = generateFishMarket(random);
            const full = runFishStrategy(prices, 100);
            for (const cut of [60, 150, 250, 350]) {
                // Truncate, and also replace the future with something wild.
                const truncated = runFishStrategy(prices.slice(0, cut), 100);
                const altered = prices
                    .slice(0, cut)
                    .concat(prices.slice(cut).map((p, i) => p * (1 + i / 50)));
                const alteredRun = runFishStrategy(altered, 100);
                const before = full.trades.filter((t) => t.exitBar < cut);
                expect(truncated.trades).toEqual(before);
                expect(
                    alteredRun.trades.filter((t) => t.exitBar < cut)
                ).toEqual(before);
                expect(truncated.equity).toEqual(full.equity.slice(0, cut));
            }
        }
    });

    it('makes money on average and beats the fish’s old coin flips', () => {
        const seeds = 400;
        let total = 0;
        let baseline = 0;
        let green = 0;
        const returns: number[] = [];
        for (let seed = 0; seed < seeds; seed++) {
            const day = simulateFishTradingDay({ seed });
            total += day.returnPct;
            baseline += day.baselineReturnPct;
            if (day.returnPct > 0) green++;
            returns.push(day.returnPct);
        }
        const mean = total / seeds;
        const sd = Math.sqrt(
            returns.reduce((s, r) => s + (r - mean) ** 2, 0) / seeds
        );
        const tStat = (mean / sd) * Math.sqrt(seeds);
        expect(mean).toBeGreaterThan(1);
        expect(tStat).toBeGreaterThan(5);
        expect(mean).toBeGreaterThan(baseline / seeds + 3);
        // Some days lose; that is fine (and funny).
        expect(green / seeds).toBeGreaterThan(0.5);
        expect(green).toBeLessThan(seeds);
    });
});

describe('runPoorDecisionsBaseline', () => {
    it('is flat by the close and loses to fees on a flat market', () => {
        const flat = Array.from({ length: BARS_PER_DAY }, () => 10);
        const r = runPoorDecisionsBaseline(flat, mulberry32(1));
        expect(r).toBeLessThan(0);
    });

    it('returns 0 for an empty series', () => {
        expect(runPoorDecisionsBaseline([], mulberry32(1))).toBe(0);
    });
});

describe('parseFishTradeArgs', () => {
    it('parses no arguments', () => {
        expect(parseFishTradeArgs([])).toEqual({ ok: true, options: {} });
    });

    it('joins remaining words into the fish name', () => {
        expect(parseFishTradeArgs(['Sir', 'Bubbles', 'III'])).toEqual({
            ok: true,
            options: { fishName: 'Sir Bubbles III' },
        });
    });

    it('accepts -seed and -cash anywhere', () => {
        expect(
            parseFishTradeArgs(['Gill', '-seed', '42', 'Bates', '-cash', '250'])
        ).toEqual({
            ok: true,
            options: { fishName: 'Gill Bates', seed: 42, startingCash: 250 },
        });
        expect(
            parseFishTradeArgs(['-CASH', '$1,000.50', '--seed', '4294967295'])
        ).toEqual({
            ok: true,
            options: { startingCash: 1000.5, seed: 4294967295 },
        });
    });

    it.each([
        [['-seed']],
        [['-seed', '-1']],
        [['-seed', '1.5']],
        [['-seed', 'abc']],
        [['-seed', '4294967296']],
        [['-cash']],
        [['-cash', '0']],
        [['-cash', '0.5']],
        [['-cash', '1000001']],
        [['-cash', 'lots']],
        [['-cash', '-5']],
    ])('rejects %j', (args) => {
        const result = parseFishTradeArgs(args);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.length).toBeGreaterThan(0);
            expect(result.error.length).toBeLessThan(100);
        }
    });
});

describe('sanitizeFishName', () => {
    it.each([
        [undefined, 'your fish'],
        ['', 'your fish'],
        ['   ', 'your fish'],
        ['**@everyone**', 'everyone'],
        ['<@123>', '123'],
        ['  Captain   `Fin`  ~~Mc~~ |Fish| #1 _x_ ', 'Captain Fin Mc Fish 1 x'],
        ['a'.repeat(50), 'a'.repeat(32)],
        ['Nemo', 'Nemo'],
    ])('%j -> %j', (input, expected) => {
        expect(sanitizeFishName(input)).toBe(expected);
    });

    it('is applied by the simulation', () => {
        const day = simulateFishTradingDay({ seed: 1, fishName: '@here' });
        expect(day.fishName).toBe('here');
    });
});

describe('financial independence math', () => {
    it('is already there at or above the FI number', () => {
        expect(tradingDaysToFi(4500, -3)).toBe(0);
        expect(tradingDaysToFi(5000, 1)).toBe(0);
    });

    it('is unreachable without a positive return', () => {
        expect(tradingDaysToFi(100, 0)).toBeNull();
        expect(tradingDaysToFi(100, -1)).toBeNull();
    });

    it('compounds the day return', () => {
        // 100 * 1.01^n >= 4500 -> n = ceil(ln 45 / ln 1.01) = 383
        expect(tradingDaysToFi(100, 1)).toBe(383);
        expect(tradingDaysToFi(2250, 100)).toBe(1);
        const days = tradingDaysToFi(100, 1)!;
        expect(100 * 1.01 ** days).toBeGreaterThanOrEqual(4500);
        expect(100 * 1.01 ** (days - 1)).toBeLessThan(4500);
    });

    it('reports progress in the simulated day', () => {
        const day = simulateFishTradingDay({ seed: 3 });
        expect(day.fiProgressPct).toBeCloseTo((day.endingCash / 4500) * 100);
    });

    it('formats trading days sanely', () => {
        expect(formatTradingDays(0)).toBe('already there');
        expect(formatTradingDays(1)).toBe('1 trading day');
        expect(formatTradingDays(100)).toBe('100 trading days');
        expect(formatTradingDays(383)).toBe('383 trading days (~1.5 years)');
        expect(formatTradingDays(252 * 1001)).toBe('> 1,000 years');
        expect(formatTradingDays(1e15)).toBe('> 1,000 years');
    });
});

describe('sparkline', () => {
    it('uses block characters and a fixed width', () => {
        const line = sparkline(Array.from({ length: 390 }, (_, i) => i));
        expect(line).toHaveLength(24);
        expect(line[0]).toBe('▁');
        expect(line[23]).toBe('█');
        expect(sparkline([5, 5, 5])).toBe('▄▄▄');
        expect(sparkline([])).toBe('');
    });
});

describe('buildFishTradeSummary', () => {
    function withReturn(returnPct: number): FishTradingDay {
        const day = simulateFishTradingDay({ seed: 11, fishName: 'Bubbles' });
        return { ...day, returnPct };
    }

    it('picks the colour from the return', () => {
        expect(buildFishTradeSummary(withReturn(1)).color).toBe('success');
        expect(buildFishTradeSummary(withReturn(-1)).color).toBe('error');
        expect(buildFishTradeSummary(withReturn(0)).color).toBe('info');
    });

    it('stays within embed limits and includes the essentials', () => {
        for (let seed = 0; seed < 100; seed++) {
            const day = simulateFishTradingDay({
                seed,
                fishName: 'W'.repeat(40),
                startingCash: 1_000_000,
            });
            const summary = buildFishTradeSummary(day);
            expect(summary.title.length).toBeLessThanOrEqual(256);
            expect(summary.description.length).toBeLessThanOrEqual(4096);
            expect(summary.fields.length).toBeLessThanOrEqual(25);
            for (const field of summary.fields) {
                expect(field.name.length).toBeGreaterThan(0);
                expect(field.name.length).toBeLessThanOrEqual(256);
                expect(field.value.length).toBeGreaterThan(0);
                expect(field.value.length).toBeLessThanOrEqual(1024);
            }
            expect(summary.title).toContain(day.ticker);
            expect(summary.description).toMatch(/`[▁▂▃▄▅▆▇█]{24}`/);
            expect(summary.description).toContain(day.strategy);
            expect(summary.description).toMatch(/Not financial advice/);
            const all = summary.fields.map((f) => f.value).join('\n');
            expect(all).toContain(`-seed ${seed}`);
        }
    });

    it('formats a known day', () => {
        const day = simulateFishTradingDay({ seed: 11, fishName: 'Bubbles' });
        const summary = buildFishTradeSummary(day);
        expect(summary.title).toMatch(/^🐟📈|^🐟📉/);
        expect(summary.title).toContain('Bubbles day-traded');
        const pnl = summary.fields.find((f) => f.name === 'P&L')!;
        expect(pnl.value).toMatch(/\$100\.00 → \$[\d,]+\.\d{2}/);
        expect(summary.fields.map((f) => f.name)).toEqual(
            expect.arrayContaining([
                'P&L',
                'vs. old strategy',
                'Trades',
                'Max drawdown',
                'Best / worst trade',
                'Seed',
            ])
        );
    });

    it('capitalizes the default fish name and handles a day with no trades', () => {
        const day: FishTradingDay = {
            ...simulateFishTradingDay({ seed: 2 }),
            trades: [],
            winRate: null,
            endingCash: 100,
            returnPct: 0,
            tradingDaysToFi: null,
        };
        const summary = buildFishTradeSummary(day);
        expect(summary.title).toContain('Your fish day-traded');
        expect(summary.color).toBe('info');
        expect(summary.description).toMatch(/stayed in cash/);
        const fi = summary.fields.find((f) =>
            f.name.startsWith('Financial independence')
        )!;
        expect(fi.value).toMatch(/Not at this rate/);
    });
});
