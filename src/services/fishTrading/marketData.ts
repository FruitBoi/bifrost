/**
 * Real market data for the fish (issue #34): one regular session of
 * one-minute closes from the Yahoo Finance chart API (no API key needed).
 */

/** One regular trading session of a real ticker, as one-minute closes. */
export interface MarketSession {
    /** Normalized symbol as quoted by the data source, e.g. `AAPL`. */
    symbol: string;
    /** Company / fund name when known (longName, else shortName), else null. */
    name: string | null;
    /** Quote currency, e.g. `USD`. */
    currency: string;
    /** Human-readable exchange, e.g. `NasdaqGS`. */
    exchange: string;
    /** Session date `YYYY-MM-DD` in the exchange's time zone. */
    sessionDate: string;
    /** Unix seconds of each bar, ascending, regular session only. */
    timestamps: number[];
    /** One-minute closes matching `timestamps`; bars without a close are dropped. */
    prices: number[];
    /** Unix seconds of the regular session's open and close. */
    sessionOpen: number;
    sessionClose: number;
    /** True when the session had not closed yet when the data was fetched. */
    inProgress: boolean;
}

/** Thrown for unknown tickers, network failures and unusable data. Message is user-facing. */
export class MarketDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MarketDataError';
    }
}

/** Well-known liquid US tickers the fish picks from when none is given. */
export const REAL_TICKERS: readonly string[] = [
    'SPY',
    'QQQ',
    'DIA',
    'IWM',
    'AAPL',
    'MSFT',
    'NVDA',
    'TSLA',
    'AMZN',
    'GOOGL',
    'META',
    'AMD',
    'NFLX',
    'DIS',
    'KO',
    'JPM',
    'INTC',
    'BA',
];

const TICKER_PATTERN = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;
const MIN_BARS = 45;
const REQUEST_TIMEOUT_MS = 8000;
/** Yahoo answers 429 to full browser user agents without its cookies; a bare one works. */
const USER_AGENT = 'Mozilla/5.0';

/**
 * Normalizes user input like `aapl`, `$AAPL`, `brk.b` to a symbol, or null
 * when it does not look like a ticker. Only a syntactic check.
 */
export function normalizeTicker(input: string): string | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (s.startsWith('$')) s = s.slice(1);
    s = s.toUpperCase();
    return TICKER_PATTERN.test(s) ? s : null;
}

export interface FetchSessionOptions {
    /** Injected for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** Injected clock in milliseconds; defaults to Date.now. */
    now?: () => number;
}

interface CacheEntry {
    fetchedAt: number;
    session: MarketSession;
}

const cache = new Map<string, CacheEntry>();

/** Empties the session cache (for tests). */
export function clearMarketDataCache(): void {
    cache.clear();
}

interface YahooPeriod {
    start?: number;
    end?: number;
}

interface YahooResult {
    meta?: {
        currency?: string;
        symbol?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        longName?: string;
        shortName?: string;
        exchangeTimezoneName?: string;
        gmtoffset?: number;
        currentTradingPeriod?: { regular?: YahooPeriod };
        tradingPeriods?: YahooPeriod[][];
    };
    timestamp?: number[];
    indicators?: { quote?: { close?: (number | null)[] }[] };
}

const UNREACHABLE = "Couldn't reach the market data provider right now.";

/** Formats unix seconds as `YYYY-MM-DD` in the exchange's time zone. */
function formatSessionDate(
    seconds: number,
    timeZone: string | undefined,
    gmtoffset: number
): string {
    if (timeZone) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).formatToParts(new Date(seconds * 1000));
            const get = (type: string): string =>
                parts.find((p) => p.type === type)?.value ?? '';
            return `${get('year')}-${get('month')}-${get('day')}`;
        } catch {
            // Unknown zone: fall through to the fixed offset.
        }
    }
    return new Date((seconds + gmtoffset) * 1000).toISOString().slice(0, 10);
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function parseSession(
    symbol: string,
    json: unknown,
    nowMs: number
): MarketSession {
    const chart = (json as { chart?: { result?: YahooResult[] | null } } | null)
        ?.chart;
    const result = chart?.result?.[0];
    if (!result)
        throw new MarketDataError(`Couldn't find ticker \`${symbol}\`.`);
    const meta = result.meta ?? {};
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];

    const periods = meta.tradingPeriods;
    const period =
        periods?.[periods.length - 1]?.[0] ??
        meta.currentTradingPeriod?.regular;
    const sessionOpen = period?.start;
    const sessionClose = period?.end;
    if (!isFiniteNumber(sessionOpen) || !isFiniteNumber(sessionClose)) {
        throw new MarketDataError(UNREACHABLE);
    }

    const ts: number[] = [];
    const prices: number[] = [];
    for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        const c = closes[i];
        if (!isFiniteNumber(t) || t < sessionOpen || t >= sessionClose)
            continue;
        if (!isFiniteNumber(c) || c <= 0) continue;
        ts.push(t);
        prices.push(c);
    }
    if (ts.length < MIN_BARS) {
        throw new MarketDataError(
            `Not enough trading data for \`${symbol}\` yet today.`
        );
    }

    return {
        symbol: meta.symbol ?? symbol,
        name: meta.longName ?? meta.shortName ?? null,
        currency: meta.currency ?? 'USD',
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? 'unknown',
        sessionDate: formatSessionDate(
            sessionOpen,
            meta.exchangeTimezoneName,
            meta.gmtoffset ?? 0
        ),
        timestamps: ts,
        prices,
        sessionOpen,
        sessionClose,
        inProgress: nowMs / 1000 < sessionClose,
    };
}

/** Fetches the latest (or current) regular session of `symbol` in one-minute bars. */
export async function fetchIntradaySession(
    symbol: string,
    options: FetchSessionOptions = {}
): Promise<MarketSession> {
    const normalized = normalizeTicker(symbol);
    if (!normalized)
        throw new MarketDataError("That doesn't look like a ticker symbol.");
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    const nowMs = now();

    const cached = cache.get(normalized);
    if (
        cached &&
        nowMs - cached.fetchedAt >= 0 &&
        nowMs - cached.fetchedAt < CACHE_TTL_MS
    ) {
        return {
            ...cached.session,
            inProgress: nowMs / 1000 < cached.session.sessionClose,
        };
    }

    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}` +
        '?interval=1m&range=1d&includePrePost=false';
    let json: unknown;
    try {
        const res = await fetchImpl(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 404)
            throw new MarketDataError(
                `Couldn't find ticker \`${normalized}\`.`
            );
        if (!res.ok) throw new MarketDataError(UNREACHABLE);
        json = await res.json();
    } catch (err) {
        if (err instanceof MarketDataError) throw err;
        throw new MarketDataError(UNREACHABLE);
    }

    const session = parseSession(normalized, json, nowMs);
    cache.delete(normalized);
    cache.set(normalized, { fetchedAt: nowMs, session });
    while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return session;
}
