/**
 * Fish day trading (issue #34).
 *
 * A just-for-fun chat command in the spirit of the meow replies: someone's
 * pet fish has been making extremely poor trading decisions, so it gets a
 * real algorithm. One trading day ("while you're at work", 09:30-16:00, 390
 * one-minute bars) of a made-up fish ticker is simulated and the fish trades
 * it with a trend-following strategy, then reports how far it got towards
 * financial independence.
 *
 * Everything is simulated: there is no network access, no real market data
 * and nothing is persisted. A run is fully determined by its seed, so a user
 * can replay a day with `-seed <n>`.
 *
 * The simulated market is a regime-switching random walk on log prices: the
 * price trends up, trends down or chops sideways, and each regime persists
 * for a while before switching. That persistence is the edge a trend
 * follower can exploit, so the strategy genuinely makes money on average
 * (a test checks this over hundreds of seeds) while individual days can and
 * do lose.
 */

/** Chat command names (without prefix) that run the fish's trading day. */
export const FISH_TRADE_COMMAND_NAMES = [
    'fishtrade',
    'fishtrading',
    'stonks',
] as const;

/** Options for one simulated trading day. */
export interface FishTradeOptions {
    /** Name of the fish; defaults to `your fish`. Sanitized before use. */
    fishName?: string;
    /** Seed for the market and the fish's old strategy; random by default. */
    seed?: number;
    /** Starting bankroll in dollars; defaults to 100 (the fish's allowance). */
    startingCash?: number;
}

/** One round trip made by the fish. */
export interface FishTrade {
    side: 'long' | 'short';
    entryBar: number;
    exitBar: number;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    /** Profit or loss of the round trip, after fees. */
    pnl: number;
    reason: 'stop' | 'trail' | 'target' | 'signal' | 'close';
}

/** Result of one simulated trading day. */
export interface FishTradingDay {
    fishName: string;
    ticker: string;
    seed: number;
    /** One-line description of the fish's algorithm. */
    strategy: string;
    /** One close per minute bar, 390 in total. */
    prices: number[];
    trades: FishTrade[];
    startingCash: number;
    endingCash: number;
    /** Day return in percent. */
    returnPct: number;
    /** What the fish's old random strategy would have made on the same prices, in percent. */
    baselineReturnPct: number;
    /** Buy-and-hold return from the first to the last bar, in percent. */
    marketReturnPct: number;
    /** Share of winning trades in `0..1`, or null when the fish did not trade. */
    winRate: number | null;
    /** Largest peak-to-trough drop of the marked-to-market equity, in percent. */
    maxDrawdownPct: number;
    /** Bankroll at which the fish is financially independent (4% rule). */
    fiNumber: number;
    /** Ending equity as a percentage of the FI number. */
    fiProgressPct: number;
    /** Trading days to FI at today's rate, or null when not reachable at that rate. */
    tradingDaysToFi: number | null;
}

/** Number of one-minute bars between 09:30 and 16:00. */
export const BARS_PER_DAY = 390;
/** Trading days per year, used to turn days to FI into years. */
export const TRADING_DAYS_PER_YEAR = 252;
/** Fish food, tank filter cartridges and the occasional castle decoration. */
export const FISH_ANNUAL_EXPENSES = 180;
/** FI number = 25x annual expenses (the 4% rule). */
export const FISH_FI_NUMBER = FISH_ANNUAL_EXPENSES * 25;
/** The fish's allowance. */
export const DEFAULT_STARTING_CASH = 100;
export const MIN_STARTING_CASH = 1;
export const MAX_STARTING_CASH = 1_000_000;
export const MAX_SEED = 0xffffffff;
export const MAX_FISH_NAME_LENGTH = 32;
export const DEFAULT_FISH_NAME = 'your fish';

/** Made-up tickers listed on the fish exchange. */
export const FISH_TICKERS = [
    '$KELP',
    '$BRNE',
    '$GLUB',
    '$SHRMP',
    '$PLNK',
    '$CORL',
    '$REEF',
    '$FLKE',
    '$BUBL',
    '$CLAM',
    '$GUPY',
    '$TANK',
] as const;

/** Tunable parameters of the fish's strategy. */
export interface FishStrategyParams {
    /** Fast EMA period (bars). */
    fastPeriod: number;
    /** Slow EMA period (bars). */
    slowPeriod: number;
    /** Bars over which the slow EMA's slope must agree with the trade. */
    slopeLookback: number;
    /** RSI period (bars). */
    rsiPeriod: number;
    /** No longs above this RSI, no shorts below 100 minus it. */
    rsiLimit: number;
    /** ATR period (bars); ATR here is the average absolute close-to-close move. */
    atrPeriod: number;
    /** Initial stop distance in ATRs. */
    stopAtr: number;
    /** Trailing stop distance in ATRs from the best close since entry. */
    trailAtr: number;
    /** Take-profit distance in ATRs. */
    targetAtr: number;
    /** Fraction of equity risked per trade against the initial stop. */
    riskFraction: number;
    /** Maximum position notional as a multiple of equity. */
    maxLeverage: number;
    /** Fee per fill as a fraction of notional. */
    feeRate: number;
    /** Bars to wait after an exit before entering again. */
    cooldownBars: number;
    /** Maximum entries per day. */
    maxTrades: number;
    /** No new entries in the last this-many bars of the day. */
    noEntryLastBars: number;
}

/** The fish's tuned strategy parameters. */
export const FISH_STRATEGY_PARAMS: Readonly<FishStrategyParams> = {
    fastPeriod: 8,
    slowPeriod: 30,
    slopeLookback: 5,
    rsiPeriod: 14,
    rsiLimit: 75,
    atrPeriod: 20,
    stopAtr: 4,
    trailAtr: 6,
    targetAtr: 25,
    riskFraction: 0.01,
    maxLeverage: 4,
    feeRate: 0.0002,
    cooldownBars: 15,
    maxTrades: 10,
    noEntryLastBars: 15,
};

/** Human-readable summary of the strategy shown in the command output. */
export function describeStrategy(
    p: Readonly<FishStrategyParams> = FISH_STRATEGY_PARAMS
): string {
    return (
        `EMA ${p.fastPeriod}/${p.slowPeriod} crossover trend following, long and short, ` +
        `RSI(${p.rsiPeriod}) and slow-EMA slope filters, ${p.riskFraction * 100}% risk per trade ` +
        `vs a ${p.stopAtr}×ATR stop, ${p.trailAtr}×ATR trailing stop, ${p.targetAtr}×ATR target, ` +
        `max ${p.maxTrades} trades, flat by the close`
    );
}

/**
 * Small seeded PRNG (mulberry32). Returns a function producing numbers in
 * `[0, 1)`; the same seed always produces the same sequence.
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal sample via Box-Muller. */
function gaussian(random: () => number): number {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Market regimes and their per-bar log drift. */
const REGIME_DRIFT = [0.00016, -0.00016, 0] as const;
/** Per-bar log volatility (trending regimes / choppy regime). */
const TREND_VOL = 0.0012;
const CHOP_VOL = 0.0016;
/** Chance per bar that the regime changes. */
const REGIME_SWITCH_CHANCE = 0.012;

/**
 * Generates `bars` closes of a regime-switching random walk on log prices.
 * Prices are always positive.
 */
export function generateFishMarket(
    random: () => number,
    bars = BARS_PER_DAY
): number[] {
    let price = 5 + random() * 145;
    let regime = Math.floor(random() * 3);
    const prices: number[] = [];
    for (let i = 0; i < bars; i++) {
        if (i > 0) {
            if (random() < REGIME_SWITCH_CHANCE) {
                // Move to one of the two other regimes.
                regime = (regime + 1 + Math.floor(random() * 2)) % 3;
            }
            const vol = regime === 2 ? CHOP_VOL : TREND_VOL;
            price *= Math.exp(REGIME_DRIFT[regime] + vol * gaussian(random));
        }
        prices.push(price);
    }
    return prices;
}

/** Result of running the strategy over a price series. */
export interface FishStrategyRun {
    /** Closed round trips. */
    trades: FishTrade[];
    /** Marked-to-market equity after each bar. */
    equity: number[];
    /** Cash plus value of any position still open after the last bar. */
    endingEquity: number;
    /** True when a position is still open (only when the series is cut short). */
    openPosition: boolean;
}

interface Position {
    side: 'long' | 'short';
    dir: 1 | -1;
    entryBar: number;
    entryPrice: number;
    shares: number;
    entryFee: number;
    stop: number;
    target: number;
    best: number;
}

/**
 * Runs the fish's strategy over `prices`. Decisions at bar `i` use only
 * closes up to and including bar `i` and fill at bar `i`'s close. Any
 * position still open on bar `closeBar` (the last bar of the session) is
 * closed there, so the fish never holds overnight. When `prices` is shorter
 * than the session, the run simply stops after the last bar given, which
 * makes it easy to check that future prices never influence earlier trades.
 */
export function runFishStrategy(
    prices: readonly number[],
    startingCash: number,
    params: Readonly<FishStrategyParams> = FISH_STRATEGY_PARAMS,
    closeBar = BARS_PER_DAY - 1
): FishStrategyRun {
    const p = params;
    const kFast = 2 / (p.fastPeriod + 1);
    const kSlow = 2 / (p.slowPeriod + 1);
    const kAtr = 1 / p.atrPeriod;
    const kRsi = 1 / p.rsiPeriod;

    const trades: FishTrade[] = [];
    const equity: number[] = [];
    const slowHistory: number[] = [];
    let cash = startingCash;
    let pos: Position | null = null;
    let fast = prices[0] ?? 0;
    let slow = fast;
    let atr = 0;
    let avgGain = 0;
    let avgLoss = 0;
    let entries = 0;
    let lastExitBar = -Infinity;

    const close = (bar: number, price: number, reason: FishTrade['reason']) => {
        if (!pos) return;
        const fee = pos.shares * price * p.feeRate;
        cash += pos.dir * pos.shares * price - fee;
        trades.push({
            side: pos.side,
            entryBar: pos.entryBar,
            exitBar: bar,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            shares: pos.shares,
            pnl:
                pos.dir * (price - pos.entryPrice) * pos.shares -
                pos.entryFee -
                fee,
            reason,
        });
        pos = null;
        lastExitBar = bar;
    };

    for (let i = 0; i < prices.length && i <= closeBar; i++) {
        const price = prices[i];
        if (i > 0) {
            const change = price - prices[i - 1];
            fast += kFast * (price - fast);
            slow += kSlow * (price - slow);
            atr += kAtr * (Math.abs(change) - atr);
            avgGain += kRsi * (Math.max(change, 0) - avgGain);
            avgLoss += kRsi * (Math.max(-change, 0) - avgLoss);
        }
        slowHistory.push(slow);
        const rsi =
            avgGain + avgLoss === 0
                ? 50
                : (100 * avgGain) / (avgGain + avgLoss);

        // Manage an open position.
        if (pos) {
            const d = pos.dir;
            if (d * (price - pos.best) > 0) pos.best = price;
            const trail = pos.best - d * p.trailAtr * atr;
            if (i === closeBar) close(i, price, 'close');
            else if (d * (price - pos.target) >= 0) close(i, price, 'target');
            else if (d * (price - pos.stop) <= 0) close(i, price, 'stop');
            else if (d * (price - trail) <= 0) close(i, price, 'trail');
            else if (d * (fast - slow) < 0) close(i, price, 'signal');
        }

        // Look for a new entry.
        const warmedUp = i >= p.slowPeriod && i >= p.slopeLookback;
        if (
            !pos &&
            warmedUp &&
            atr > 0 &&
            i < closeBar - p.noEntryLastBars &&
            entries < p.maxTrades &&
            i - lastExitBar > p.cooldownBars
        ) {
            const slope = slow - slowHistory[i - p.slopeLookback];
            let dir: 1 | -1 | 0 = 0;
            if (fast > slow && slope > 0 && price > fast && rsi < p.rsiLimit)
                dir = 1;
            else if (
                fast < slow &&
                slope < 0 &&
                price < fast &&
                rsi > 100 - p.rsiLimit
            )
                dir = -1;
            if (dir !== 0) {
                const eq = cash; // flat, so equity is cash
                const stopDist = p.stopAtr * atr;
                const shares = Math.min(
                    (eq * p.riskFraction) / stopDist,
                    (eq * p.maxLeverage) / price
                );
                if (shares > 0 && shares * price >= 0.01) {
                    const fee = shares * price * p.feeRate;
                    cash -= dir * shares * price + fee;
                    pos = {
                        side: dir === 1 ? 'long' : 'short',
                        dir,
                        entryBar: i,
                        entryPrice: price,
                        shares,
                        entryFee: fee,
                        stop: price - dir * stopDist,
                        target: price + dir * p.targetAtr * atr,
                        best: price,
                    };
                    entries++;
                }
            }
        }

        const held: Position | null = pos;
        equity.push(cash + (held ? held.dir * held.shares * price : 0));
    }

    const endingEquity = equity.length
        ? equity[equity.length - 1]
        : startingCash;
    return { trades, equity, endingEquity, openPosition: pos !== null };
}

/**
 * The fish's old strategy: every bar it flips a coin and, on heads, switches
 * between all-in long and flat. Pays the same fees and is flat by the close.
 * Returns the day return in percent.
 */
export function runPoorDecisionsBaseline(
    prices: readonly number[],
    random: () => number,
    feeRate = FISH_STRATEGY_PARAMS.feeRate
): number {
    if (prices.length === 0) return 0;
    let cash = 1;
    let shares = 0;
    const last = prices.length - 1;
    for (let i = 0; i < prices.length; i++) {
        const price = prices[i];
        const flip = i === last ? shares > 0 : random() < 0.5;
        if (!flip) continue;
        if (shares > 0) {
            cash += shares * price * (1 - feeRate);
            shares = 0;
        } else if (i < last) {
            shares = cash / (price * (1 + feeRate));
            cash = 0;
        }
    }
    return (cash - 1) * 100;
}

/** Largest peak-to-trough drop of `equity`, in percent (0 when it never drops). */
export function maxDrawdownPct(
    equity: readonly number[],
    start?: number
): number {
    let peak = start ?? equity[0] ?? 0;
    let worst = 0;
    for (const value of equity) {
        if (value > peak) peak = value;
        if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
    }
    return worst * 100;
}

/**
 * Trading days until `equity` reaches `fiNumber` if every day returned
 * `returnPct`. 0 when already there; null when the day did not make money
 * (never reachable at that rate) or the answer is not a finite number.
 */
export function tradingDaysToFi(
    equity: number,
    returnPct: number,
    fiNumber = FISH_FI_NUMBER
): number | null {
    if (equity >= fiNumber) return 0;
    if (!(returnPct > 0) || !(equity > 0)) return null;
    const days = Math.ceil(
        Math.log(fiNumber / equity) / Math.log1p(returnPct / 100)
    );
    return Number.isFinite(days) ? days : null;
}

/**
 * Cleans a user-supplied fish name: strips markdown and mention characters,
 * collapses whitespace and caps the length. Falls back to `your fish`.
 */
export function sanitizeFishName(name: string | undefined): string {
    const clean = (name ?? '')
        .replace(/[*_~|<>@#`\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_FISH_NAME_LENGTH)
        .trim();
    return clean || DEFAULT_FISH_NAME;
}

/**
 * Parses the words after the command. `-seed <n>` and `-cash <amount>` may
 * appear anywhere; the remaining words form the fish's name.
 */
export function parseFishTradeArgs(
    args: string[]
): { ok: true; options: FishTradeOptions } | { ok: false; error: string } {
    const options: FishTradeOptions = {};
    const nameWords: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        const flag = word.toLowerCase().replace(/^--?/, '-');
        if (flag === '-seed') {
            const value = args[++i];
            if (value === undefined)
                return { ok: false, error: 'Missing value for `-seed`.' };
            if (!/^\d+$/.test(value) || Number(value) > MAX_SEED)
                return {
                    ok: false,
                    error: `\`-seed\` must be a whole number from 0 to ${MAX_SEED}.`,
                };
            options.seed = Number(value);
        } else if (flag === '-cash') {
            const value = args[++i];
            if (value === undefined)
                return { ok: false, error: 'Missing value for `-cash`.' };
            const cleaned = value.replace(/^\$/, '').replace(/,/g, '');
            const cash = Number(cleaned);
            if (
                !/^\d+(\.\d+)?$/.test(cleaned) ||
                cash < MIN_STARTING_CASH ||
                cash > MAX_STARTING_CASH
            )
                return {
                    ok: false,
                    error: '`-cash` must be an amount from $1 to $1,000,000.',
                };
            options.startingCash = cash;
        } else {
            nameWords.push(word);
        }
    }
    if (nameWords.length > 0) options.fishName = nameWords.join(' ');
    return { ok: true, options };
}

/** Simulates one trading day of the fish. Same options → same result. */
export function simulateFishTradingDay(
    options: FishTradeOptions = {}
): FishTradingDay {
    const seed =
        options.seed !== undefined
            ? options.seed >>> 0
            : Math.floor(Math.random() * (MAX_SEED + 1));
    const startingCash = options.startingCash ?? DEFAULT_STARTING_CASH;
    const fishName = sanitizeFishName(options.fishName);

    const marketRandom = mulberry32(seed);
    const ticker =
        FISH_TICKERS[Math.floor(marketRandom() * FISH_TICKERS.length)];
    const prices = generateFishMarket(marketRandom);

    const run = runFishStrategy(prices, startingCash);
    const endingCash = run.endingEquity;
    const returnPct = (endingCash / startingCash - 1) * 100;
    const wins = run.trades.filter((t) => t.pnl > 0).length;

    return {
        fishName,
        ticker,
        seed,
        strategy: describeStrategy(),
        prices,
        trades: run.trades,
        startingCash,
        endingCash,
        returnPct,
        baselineReturnPct: runPoorDecisionsBaseline(
            prices,
            mulberry32((seed ^ 0x9e3779b9) >>> 0)
        ),
        marketReturnPct: (prices[prices.length - 1] / prices[0] - 1) * 100,
        winRate: run.trades.length ? wins / run.trades.length : null,
        maxDrawdownPct: maxDrawdownPct(run.equity, startingCash),
        fiNumber: FISH_FI_NUMBER,
        fiProgressPct: (endingCash / FISH_FI_NUMBER) * 100,
        tradingDaysToFi: tradingDaysToFi(endingCash, returnPct),
    };
}

export interface FishTradeSummaryField {
    name: string;
    value: string;
    inline: boolean;
}

export interface FishTradeSummary {
    title: string;
    description: string;
    fields: FishTradeSummaryField[];
    color: 'success' | 'error' | 'info';
}

const money = (n: number) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const pct = (n: number) =>
    `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}%`;
const int = (n: number) => n.toLocaleString('en-US');

const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const SPARK_WIDTH = 24;

/** Text sparkline of `prices`, one character per bucket of bars. */
export function sparkline(
    prices: readonly number[],
    width = SPARK_WIDTH
): string {
    if (prices.length === 0) return '';
    const buckets = Math.min(width, prices.length);
    const points: number[] = [];
    for (let b = 0; b < buckets; b++) {
        const end = Math.floor(((b + 1) * prices.length) / buckets) - 1;
        points.push(prices[end]);
    }
    const lo = Math.min(...points);
    const hi = Math.max(...points);
    return points
        .map((v) => {
            const level =
                hi === lo
                    ? 3
                    : Math.round(
                          ((v - lo) / (hi - lo)) * (SPARK_CHARS.length - 1)
                      );
            return SPARK_CHARS[level];
        })
        .join('');
}

/** "about 3 weeks", "12 years", "> 1,000 years" for a number of trading days. */
export function formatTradingDays(days: number): string {
    if (days === 0) return 'already there';
    const years = days / TRADING_DAYS_PER_YEAR;
    if (years > 1000) return '> 1,000 years';
    if (days === 1) return '1 trading day';
    if (years < 1) return `${int(days)} trading days`;
    const rounded =
        years < 10 ? Math.round(years * 10) / 10 : Math.round(years);
    return `${int(days)} trading days (~${rounded} ${rounded === 1 ? 'year' : 'years'})`;
}

function verdict(day: FishTradingDay): string {
    const name = day.fishName;
    const r = day.returnPct;
    if (day.trades.length === 0)
        return `${name} watched the tape all day, saw no clean trend and stayed in cash. Discipline. 🧘`;
    if (r >= 3)
        return `${name} rode the current like a pro and is already shopping for a bigger tank. 🚀🐠`;
    if (r > 0.5)
        return `A solid day: ${name} followed the trend and kept the losers small. 🐟💰`;
    if (r > 0)
        return `${name} scraped out a small green day. Fish food is covered. 🍤`;
    if (r > -1)
        return `A choppy day. ${name}'s stops kept the damage to a scratch. 🩹`;
    return `Rough waters: ${name} got chopped up, but the risk limits held. Tomorrow is another tide. 🌊`;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function tradeLine(trade: FishTrade | undefined): string {
    if (!trade) return '—';
    return `${signedMoney(trade.pnl)} (${trade.side}, ${trade.reason})`;
}

/** Builds the embed-shaped summary of a simulated trading day. */
export function buildFishTradeSummary(day: FishTradingDay): FishTradeSummary {
    const up = day.returnPct >= 0;
    const title = `🐟${up ? '📈' : '📉'} ${capitalize(day.fishName)} day-traded ${day.ticker}`;
    const description = [
        verdict(day),
        `\`${sparkline(day.prices)}\` ${day.ticker} ${money(day.prices[0])} → ${money(day.prices[day.prices.length - 1])}`,
        `**Algorithm:** ${day.strategy}.`,
        '-# Simulated fish market. Not financial advice, especially for humans.',
    ].join('\n');

    const pnl = day.endingCash - day.startingCash;
    const sorted = [...day.trades].sort((a, b) => b.pnl - a.pnl);
    const best = sorted[0];
    const worst = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;

    const fiValue =
        day.tradingDaysToFi === null
            ? `${pct(day.fiProgressPct).replace(/^\+/, '')} of ${money(day.fiNumber)}\n` +
              'Not at this rate. Back to the drawing board (the tank glass). 🫧'
            : `${pct(day.fiProgressPct).replace(/^\+/, '')} of ${money(day.fiNumber)}\n` +
              `At today's rate: ${formatTradingDays(day.tradingDaysToFi)}`;

    const fields: FishTradeSummaryField[] = [
        {
            name: 'P&L',
            value: `${signedMoney(pnl)} (${pct(day.returnPct)})\n${money(day.startingCash)} → ${money(day.endingCash)}`,
            inline: true,
        },
        {
            name: 'vs. old strategy',
            value: `Coin flips: ${pct(day.baselineReturnPct)}\nBuy & hold: ${pct(day.marketReturnPct)}`,
            inline: true,
        },
        {
            name: 'Trades',
            value:
                day.winRate === null
                    ? '0'
                    : `${day.trades.length} (${Math.round(day.winRate * 100)}% won)`,
            inline: true,
        },
        {
            name: 'Max drawdown',
            value: pct(-day.maxDrawdownPct).replace(/^-0\.00%$/, '0.00%'),
            inline: true,
        },
        {
            name: 'Best / worst trade',
            value: `${tradeLine(best)}\n${worst ? tradeLine(worst) : '—'}`,
            inline: true,
        },
        {
            name: `Financial independence (${money(day.fiNumber)})`,
            value: fiValue,
            inline: false,
        },
        {
            name: 'Seed',
            value: `\`${day.seed}\` (replay with \`-seed ${day.seed}\`)`,
            inline: false,
        },
    ];

    return {
        title,
        description,
        fields,
        color:
            day.returnPct > 0
                ? 'success'
                : day.returnPct < 0
                  ? 'error'
                  : 'info',
    };
}
