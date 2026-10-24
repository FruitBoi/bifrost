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
    runFishTradingDay,
    runPoorDecisionsBaseline,
    sanitizeFishName,
    simulateFishTradingDay,
    sparkline,
    tradingDaysToFi,
    type FishTradingDay,
    type FishTradingDeps,
} from '../../../src/services/fishTrading/fishTrading';
import {
    MarketDataError,
    REAL_TICKERS,
    type MarketSession,
} from '../../../src/services/fishTrading/marketData';

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

    it('accepts -ticker, a bare $TICKER word and -sim', () => {
        expect(parseFishTradeArgs(['Bubbles', '$tsla'])).toEqual({
            ok: true,
            options: { fishName: 'Bubbles', ticker: 'TSLA' },
        });
        expect(
            parseFishTradeArgs(['--TICKER', 'aapl', 'Gill', '-cash', '50'])
        ).toEqual({
            ok: true,
            options: { fishName: 'Gill', ticker: 'AAPL', startingCash: 50 },
        });
        // The same ticker twice is fine.
        expect(parseFishTradeArgs(['-ticker', 'AAPL', '$aapl'])).toEqual({
            ok: true,
            options: { ticker: 'AAPL' },
        });
        expect(parseFishTradeArgs(['-sim', 'Nemo'])).toEqual({
            ok: true,
            options: { fishName: 'Nemo', simulated: true },
        });
        // Plain words stay the fish name, even when they look like tickers.
        expect(parseFishTradeArgs(['AAPL'])).toEqual({
            ok: true,
            options: { fishName: 'AAPL' },
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
        [['-ticker']],
        [['-ticker', 'not a ticker!']],
        [['$ap!pl']],
        [['-ticker', 'AAPL', '-sim']],
        [['$TSLA', '-seed', '5']],
        [['-ticker', 'AAPL', '$TSLA']],
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

/** A session of `prices` one-minute closes starting at 09:30 New York time. */
function fakeSession(
    prices: number[],
    overrides: Partial<MarketSession> = {}
): MarketSession {
    const open = Date.UTC(2026, 9, 22, 13, 30) / 1000;
    return {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        currency: 'USD',
        exchange: 'NasdaqGS',
        sessionDate: '2026-10-22',
        timestamps: prices.map((_, i) => open + i * 60),
        prices,
        sessionOpen: open,
        sessionClose: open + 390 * 60,
        inProgress: false,
        ...overrides,
    };
}

/** A strong uptrend with a bit of zig-zag, so the fish trades it. */
function trendingPrices(bars: number, start = 200): number[] {
    return Array.from(
        { length: bars },
        (_, i) => start * Math.exp(0.0006 * i + 0.0015 * Math.sin(i * 1.7))
    );
}

function fakeDeps(
    fetchSession: FishTradingDeps['fetchSession'],
    random = mulberry32(99)
): FishTradingDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        random,
        fetchSession: async (symbol) => {
            calls.push(symbol);
            return fetchSession(symbol);
        },
    };
}

describe('runFishTradingDay on the real market', () => {
    it('paper-trades a full real session and is flat at the close', async () => {
        const prices = trendingPrices(BARS_PER_DAY);
        const deps = fakeDeps(async (symbol) =>
            fakeSession(prices, { symbol })
        );
        const day = await runFishTradingDay(
            { ticker: 'AAPL', fishName: 'Bubbles', startingCash: 1000 },
            deps
        );
        expect(deps.calls).toEqual(['AAPL']);
        expect(day.market).toBe('real');
        expect(day.ticker).toBe('AAPL');
        expect(day.fishName).toBe('Bubbles');
        expect(day.notice).toBeNull();
        expect(day.session).toEqual({
            sessionDate: '2026-10-22',
            exchange: 'NasdaqGS',
            companyName: 'Apple Inc.',
            currency: 'USD',
            inProgress: false,
        });
        expect(day.prices).toEqual(prices);
        expect(day.trades.length).toBeGreaterThan(0);
        expect(day.returnPct).toBeGreaterThan(0);
        expect(day.marketReturnPct).toBeGreaterThan(0);
        const pnl = day.trades.reduce((s, t) => s + t.pnl, 0);
        expect(day.endingCash).toBeCloseTo(1000 + pnl, 6);
        for (const t of day.trades)
            expect(t.exitBar).toBeLessThanOrEqual(BARS_PER_DAY - 1);
        expect(
            runFishStrategy(prices, 1000, undefined, prices.length - 1)
                .openPosition
        ).toBe(false);
    });

    it('closes out at the latest price of a session still in progress', async () => {
        const prices = trendingPrices(120);
        const deps = fakeDeps(async () =>
            fakeSession(prices, { inProgress: true })
        );
        const day = await runFishTradingDay({ ticker: 'AAPL' }, deps);
        expect(day.market).toBe('real');
        expect(day.session?.inProgress).toBe(true);
        expect(day.prices).toHaveLength(120);
        expect(day.trades.length).toBeGreaterThan(0);
        const last = day.trades[day.trades.length - 1];
        // The uptrend is still running, so the fish is closed out at the last bar.
        expect(last.reason).toBe('close');
        expect(last.exitBar).toBe(119);
        expect(last.exitPrice).toBe(prices[119]);
        const pnl = day.trades.reduce((s, t) => s + t.pnl, 0);
        expect(day.endingCash).toBeCloseTo(100 + pnl, 6);
    });

    it('handles very short sessions without trading', async () => {
        for (const bars of [2, 10, 31, 46]) {
            const deps = fakeDeps(async () =>
                fakeSession(trendingPrices(bars), { inProgress: true })
            );
            const day = await runFishTradingDay({}, deps);
            expect(day.market).toBe('real');
            expect(day.trades).toEqual([]);
            expect(day.endingCash).toBe(100);
            expect(buildFishTradeSummary(day).description).toMatch(
                /stayed in cash/
            );
        }
    });

    it('picks a random well-known ticker when none is given', async () => {
        const deps = fakeDeps(async (symbol) =>
            fakeSession(trendingPrices(BARS_PER_DAY), { symbol })
        );
        const day = await runFishTradingDay({}, deps);
        expect(deps.calls).toHaveLength(1);
        expect(REAL_TICKERS).toContain(deps.calls[0]);
        expect(day.ticker).toBe(deps.calls[0]);
    });

    it('falls back to the fish exchange when the market is unreachable', async () => {
        const deps = fakeDeps(async () => {
            throw new MarketDataError('Yahoo is asleep.');
        });
        const day = await runFishTradingDay({ fishName: 'Bubbles' }, deps);
        expect(day.market).toBe('simulated');
        expect(day.session).toBeNull();
        expect(FISH_TICKERS).toContain(day.ticker);
        expect(day.notice).toMatch(/Bubbles practised on the fish exchange/);
        // The fallback day is replayable with its seed.
        const replay = simulateFishTradingDay({
            fishName: 'Bubbles',
            seed: day.seed,
        });
        expect(replay.prices).toEqual(day.prices);
        const summary = buildFishTradeSummary(day);
        expect(summary.description).toContain(`-# ${day.notice}`);
        expect(summary.fields.map((f) => f.name)).toContain('Seed');
    });

    it('falls back when a session has no usable prices', async () => {
        const deps = fakeDeps(async () => fakeSession([123]));
        const day = await runFishTradingDay({}, deps);
        expect(day.market).toBe('simulated');
        expect(day.notice).not.toBeNull();
    });

    it('reports market errors for an explicit ticker', async () => {
        const deps = fakeDeps(async () => {
            throw new MarketDataError('Unknown ticker ZZZZ.');
        });
        await expect(
            runFishTradingDay({ ticker: 'ZZZZ' }, deps)
        ).rejects.toThrow('Unknown ticker ZZZZ.');
        await expect(
            runFishTradingDay({ ticker: 'ZZZZ' }, deps)
        ).rejects.toBeInstanceOf(MarketDataError);
    });

    it('lets other errors propagate', async () => {
        const deps = fakeDeps(async () => {
            throw new TypeError('boom');
        });
        await expect(runFishTradingDay({}, deps)).rejects.toThrow('boom');
    });

    it('uses the simulated market for -sim and -seed without fetching', async () => {
        const deps = fakeDeps(async () => {
            throw new Error('should not fetch');
        });
        const seeded = await runFishTradingDay({ seed: 1234 }, deps);
        expect(seeded).toEqual(simulateFishTradingDay({ seed: 1234 }));
        expect(seeded.market).toBe('simulated');
        expect(seeded.notice).toBeNull();
        const sim = await runFishTradingDay({ simulated: true }, deps);
        expect(sim.market).toBe('simulated');
        expect(deps.calls).toEqual([]);
    });
});

describe('buildFishTradeSummary for real days', () => {
    async function realDay(
        overrides: Partial<MarketSession> = {},
        fishName = 'Bubbles',
        prices = trendingPrices(BARS_PER_DAY)
    ): Promise<FishTradingDay> {
        return runFishTradingDay(
            { ticker: 'AAPL', fishName },
            fakeDeps(async () => fakeSession(prices, overrides))
        );
    }

    it('shows the real session and the disclaimer, without a seed', async () => {
        const day = await realDay();
        const summary = buildFishTradeSummary(day);
        expect(summary.title).toMatch(
            /^🐟📈 Bubbles day-traded AAPL on 2026-10-22$/
        );
        expect(summary.description).toContain('AAPL (Apple Inc.) $200.00 → $');
        expect(summary.description).toMatch(/`[▁▂▃▄▅▆▇█]{24}`/);
        expect(summary.description).toContain(
            '-# Paper trades on real NasdaqGS prices from 2026-10-22 (1-minute bars, Yahoo Finance). Not financial advice, especially for humans.'
        );
        expect(summary.description).not.toMatch(/Simulated fish market/);
        expect(summary.description).not.toMatch(/still open/);
        const names = summary.fields.map((f) => f.name);
        expect(names).not.toContain('Seed');
        expect(summary.fields.map((f) => f.value).join('\n')).not.toMatch(
            /-seed/
        );
        expect(names).toEqual(
            expect.arrayContaining(['P&L', 'vs. old strategy', 'Trades'])
        );
    });

    it('says when the market is still open', async () => {
        const day = await realDay(
            { inProgress: true, name: null, currency: 'EUR' },
            'Nemo',
            trendingPrices(100)
        );
        const summary = buildFishTradeSummary(day);
        expect(summary.title).toContain('Nemo is day-trading AAPL');
        expect(summary.title).toContain('live');
        expect(summary.description).toMatch(/still open.*live so far/);
        expect(summary.description).toMatch(
            /AAPL 200\.00 EUR → [\d,.]+ EUR so far/
        );
    });

    it('cleans source text and stays within embed limits', async () => {
        const day = await realDay(
            {
                symbol: 'A'.repeat(40),
                name: '**@everyone** `' + 'x'.repeat(300),
                exchange: '<@123> ' + 'y'.repeat(300),
                sessionDate: '2026-10-22',
            },
            'W'.repeat(40)
        );
        const summary = buildFishTradeSummary({
            ...day,
            startingCash: 1_000_000,
            endingCash: 1_234_567.89,
        });
        expect(summary.description).not.toMatch(/@everyone|<@|\*\*@/);
        expect(summary.title.length).toBeLessThanOrEqual(256);
        expect(summary.description.length).toBeLessThanOrEqual(4096);
        let total = summary.title.length + summary.description.length;
        for (const field of summary.fields) {
            expect(field.name.length).toBeLessThanOrEqual(256);
            expect(field.value.length).toBeGreaterThan(0);
            expect(field.value.length).toBeLessThanOrEqual(1024);
            total += field.name.length + field.value.length;
        }
        // Leaves plenty of room for the footer under the 6000 total.
        expect(total).toBeLessThan(2500);
    });
});
