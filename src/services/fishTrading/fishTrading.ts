/**
 * Fish day trading (issue #34).
 *
 * A just-for-fun chat command in the spirit of the meow replies: someone's
 * pet fish has been making extremely poor trading decisions, so it gets a
 * real algorithm. The fish day-trades one session ("while you're at work",
 * 09:30-16:00, up to 390 one-minute bars) with a trend-following strategy,
 * then reports how far it got towards financial independence.
 *
 * By default the fish paper-trades the real stock market: the latest (or
 * current) regular session of a real ticker is fetched as one-minute closes
 * (see `marketData.ts`) and the fish trades it as if live, flat at the last
 * bar. Nothing is ever ordered and nothing is persisted. When the market data
 * cannot be fetched and the user did not ask for a specific ticker, the fish
 * practises on the simulated fish exchange instead.
 *
 * The simulated fish exchange (`-sim`, or `-seed <n>` to replay a day) needs
 * no network access: a run is fully determined by its seed. The simulated
 * market is a regime-switching random walk on log prices: the price trends
 * up, trends down or chops sideways, and each regime persists for a while
 * before switching. That persistence is the edge a trend follower can
 * exploit, so the strategy genuinely makes money on average there (a test
 * checks this over hundreds of seeds) while individual days can and do lose.
 * Real markets offer no such guarantee.
 */
import {
    fetchIntradaySession,
    MarketDataError,
    MarketSession,
    normalizeTicker,
    REAL_TICKERS,
} from './marketData';

/** Chat command names (without prefix) that run the fish's trading day. */
export const FISH_TRADE_COMMAND_NAMES = [
    'fishtrade',
    'fishtrading',
    'stonks',
] as const;

/** Options for one trading day. */
export interface FishTradeOptions {
    /** Name of the fish; defaults to `your fish`. Sanitized before use. */
    fishName?: string;
    /**
     * Seed for the simulated market and the fish's old strategy; random by
     * default. Giving one implies the simulated market.
     */
    seed?: number;
    /** Starting bankroll in dollars; defaults to 100 (the fish's allowance). */
    startingCash?: number;
    /** Real ticker to trade (normalized); a random well-known one by default. */
    ticker?: string;
    /** Trade the simulated fish exchange instead of the real market. */
    simulated?: boolean;
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

/** Where the real prices of a trading day came from. */
export interface FishRealSession {
    /** Session date `YYYY-MM-DD` in the exchange's time zone. */
    sessionDate: string;
    /** Human-readable exchange, e.g. `NasdaqGS`. */
    exchange: string;
    /** Company / fund name when known. */
    companyName: string | null;
    /** Quote currency of the prices, e.g. `USD`. */
    currency: string;
    /** True when the market was still open: results are live so far. */
    inProgress: boolean;
}

/** Result of one trading day. */
export interface FishTradingDay {
    /** Real market prices or the simulated fish exchange. */
    market: 'real' | 'simulated';
    fishName: string;
    ticker: string;
    /**
     * Seed of the day. On the simulated market it replays the whole day
     * (`-seed <n>`); on a real day it only drives the coin-flip baseline.
     */
    seed: number;
    /** Details of the real session; null on the simulated market. */
    session: FishRealSession | null;
    /** Short note shown with the result (e.g. why the fish fell back to the fish exchange), or null. */
    notice: string | null;
    /** One-line description of the fish's algorithm. */
    strategy: string;
    /** One close per minute bar: 390 when simulated, up to 390 on a real day. */
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

/** Shortens user input for echoing it back in an error message. */
function echo(input: string): string {
    const clean = input.replace(/[`\\]/g, '');
    return clean.length > 16 ? `${clean.slice(0, 15)}…` : clean;
}

/**
 * Parses the words after the command. `-seed <n>`, `-cash <amount>`,
 * `-ticker <symbol>` and `-sim` may appear anywhere, and a bare `$TICKER`
 * word is taken as the ticker; the remaining words form the fish's name.
 * A ticker trades the real market, so it cannot be combined with `-sim` or
 * `-seed` (which replays a simulated day).
 */
export function parseFishTradeArgs(
    args: string[]
): { ok: true; options: FishTradeOptions } | { ok: false; error: string } {
    const options: FishTradeOptions = {};
    const nameWords: string[] = [];
    const setTicker = (value: string): string | null => {
        const ticker = normalizeTicker(value);
        if (ticker === null)
            return `\`${echo(value)}\` doesn't look like a ticker (try \`AAPL\`).`;
        if (options.ticker !== undefined && options.ticker !== ticker)
            return 'The fish can only watch one ticker at a time.';
        options.ticker = ticker;
        return null;
    };
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
        } else if (flag === '-ticker') {
            const value = args[++i];
            if (value === undefined)
                return { ok: false, error: 'Missing value for `-ticker`.' };
            const error = setTicker(value);
            if (error) return { ok: false, error };
        } else if (flag === '-sim') {
            options.simulated = true;
        } else if (/^\$[a-z^]/i.test(word)) {
            const error = setTicker(word);
            if (error) return { ok: false, error };
        } else {
            nameWords.push(word);
        }
    }
    if (
        options.ticker !== undefined &&
        (options.simulated || options.seed !== undefined)
    )
        return {
            ok: false,
            error: 'A ticker trades the real market; drop `-sim` / `-seed` to use it.',
        };
    if (nameWords.length > 0) options.fishName = nameWords.join(' ');
    return { ok: true, options };
}

/** Runs the strategy over `prices` and fills in the shared day statistics. */
function tradeDay(
    prices: number[],
    startingCash: number,
    seed: number
): Pick<
    FishTradingDay,
    | 'strategy'
    | 'prices'
    | 'trades'
    | 'startingCash'
    | 'endingCash'
    | 'returnPct'
    | 'baselineReturnPct'
    | 'marketReturnPct'
    | 'winRate'
    | 'maxDrawdownPct'
    | 'fiNumber'
    | 'fiProgressPct'
    | 'tradingDaysToFi'
> {
    // Flat at the last bar given: the close, or the latest price of a live session.
    const run = runFishStrategy(
        prices,
        startingCash,
        FISH_STRATEGY_PARAMS,
        prices.length - 1
    );
    const endingCash = run.endingEquity;
    const returnPct = (endingCash / startingCash - 1) * 100;
    const wins = run.trades.filter((t) => t.pnl > 0).length;
    return {
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

/** Simulates one trading day on the fish exchange. Same options → same result. */
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

    return {
        market: 'simulated',
        fishName,
        ticker,
        seed,
        session: null,
        notice: null,
        ...tradeDay(prices, startingCash, seed),
    };
}

/** Cleans text from the data source before it goes into an embed. */
function cleanSourceText(text: string, maxLength: number): string {
    const clean = text
        .replace(/[*_~|<>@#`\\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > maxLength
        ? `${clean.slice(0, maxLength - 1).trimEnd()}…`
        : clean;
}

/**
 * Paper-trades one real session: the fish trades the one-minute closes as if
 * live and is flat at the last bar (the close, or the latest price while the
 * market is still open). `seed` drives the coin-flip baseline.
 */
export function tradeRealSession(
    session: MarketSession,
    options: FishTradeOptions,
    seed: number
): FishTradingDay {
    const prices = session.prices.filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length < 2)
        throw new MarketDataError(
            `No usable prices for ${session.symbol} yet. Try again in a few minutes.`
        );
    const startingCash = options.startingCash ?? DEFAULT_STARTING_CASH;
    return {
        market: 'real',
        fishName: sanitizeFishName(options.fishName),
        ticker: cleanSourceText(session.symbol, 16) || 'ticker',
        seed: seed >>> 0,
        session: {
            sessionDate: cleanSourceText(session.sessionDate, 16),
            exchange: cleanSourceText(session.exchange, 32) || 'exchange',
            companyName: session.name
                ? cleanSourceText(session.name, 60) || null
                : null,
            currency: cleanSourceText(session.currency, 8) || 'USD',
            inProgress: session.inProgress,
        },
        notice: null,
        ...tradeDay(prices, startingCash, seed),
    };
}

/** Injectable dependencies of {@link runFishTradingDay}. */
export interface FishTradingDeps {
    /** Fetches the latest (or current) regular session of a ticker. */
    fetchSession: (symbol: string) => Promise<MarketSession>;
    /** Picks the random ticker and seeds; `[0, 1)`. */
    random: () => number;
}

const DEFAULT_DEPS: FishTradingDeps = {
    fetchSession: (symbol) => fetchIntradaySession(symbol),
    random: Math.random,
};

/**
 * Runs one trading day. By default the fish paper-trades a real ticker
 * (`options.ticker`, else a random well-known one); `simulated` or a `seed`
 * use the simulated fish exchange. When the real market data cannot be
 * fetched (a {@link MarketDataError}) and no ticker was asked for, the fish
 * practises on the fish exchange and the day carries a `notice`; with an
 * explicit ticker the MarketDataError is thrown so its message can be shown.
 * Other errors propagate.
 */
export async function runFishTradingDay(
    options: FishTradeOptions = {},
    deps: FishTradingDeps = DEFAULT_DEPS
): Promise<FishTradingDay> {
    if (options.simulated || options.seed !== undefined)
        return simulateFishTradingDay(options);

    const randomSeed = () => Math.floor(deps.random() * (MAX_SEED + 1));
    const explicit = options.ticker !== undefined;
    const symbol =
        options.ticker ??
        REAL_TICKERS[Math.floor(deps.random() * REAL_TICKERS.length)];
    try {
        if (!symbol) throw new MarketDataError('No real tickers configured.');
        const session = await deps.fetchSession(symbol);
        return tradeRealSession(session, options, randomSeed());
    } catch (err: unknown) {
        if (explicit || !(err instanceof MarketDataError)) throw err;
        const day = simulateFishTradingDay({
            ...options,
            seed: randomSeed(),
        });
        return {
            ...day,
            notice: `Couldn't reach the real market, so ${day.fishName} practised on the fish exchange.`,
        };
    }
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

/** A quote in its own currency: `$231.50`, or `231.50 EUR`. */
function quote(n: number, currency: string): string {
    if (currency === 'USD') return money(n);
    return `${n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} ${currency}`;
}

/** Title and description of a day on the real market. */
function describeRealDay(
    day: FishTradingDay,
    session: FishRealSession
): { title: string; description: string } {
    const up = day.returnPct >= 0;
    const name = capitalize(day.fishName);
    const title = session.inProgress
        ? `🐟${up ? '📈' : '📉'} ${name} is day-trading ${day.ticker} (${session.sessionDate}, live)`
        : `🐟${up ? '📈' : '📉'} ${name} day-traded ${day.ticker} on ${session.sessionDate}`;
    const first = day.prices[0];
    const last = day.prices[day.prices.length - 1];
    const label = session.companyName
        ? `${day.ticker} (${session.companyName})`
        : day.ticker;
    const lines = [
        verdict(day),
        `\`${sparkline(day.prices)}\` ${label} ${quote(first, session.currency)} → ${quote(last, session.currency)}${session.inProgress ? ' so far' : ''}`,
        `**Algorithm:** ${day.strategy}.`,
    ];
    if (session.inProgress)
        lines.push(
            `-# The market is still open, so this is live so far: ${day.fishName} closed out at the latest price.`
        );
    lines.push(
        `-# Paper trades on real ${session.exchange} prices from ${session.sessionDate} (1-minute bars, Yahoo Finance). Not financial advice, especially for humans.`
    );
    return { title, description: lines.join('\n') };
}

/** Builds the embed-shaped summary of a trading day (real or simulated). */
export function buildFishTradeSummary(day: FishTradingDay): FishTradeSummary {
    const up = day.returnPct >= 0;
    const session = day.market === 'real' ? day.session : null;
    const { title, description: baseDescription } = session
        ? describeRealDay(day, session)
        : {
              title: `🐟${up ? '📈' : '📉'} ${capitalize(day.fishName)} day-traded ${day.ticker}`,
              description: [
                  verdict(day),
                  `\`${sparkline(day.prices)}\` ${day.ticker} ${money(day.prices[0])} → ${money(day.prices[day.prices.length - 1])}`,
                  `**Algorithm:** ${day.strategy}.`,
                  '-# Simulated fish market. Not financial advice, especially for humans.',
              ].join('\n'),
          };
    const description = day.notice
        ? `${baseDescription}\n-# ${day.notice}`
        : baseDescription;

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
    ];
    if (!session)
        fields.push({
            name: 'Seed',
            value: `\`${day.seed}\` (replay with \`-seed ${day.seed}\`)`,
            inline: false,
        });

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
