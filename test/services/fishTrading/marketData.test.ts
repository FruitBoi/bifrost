import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MarketDataError,
    REAL_TICKERS,
    clearMarketDataCache,
    fetchIntradaySession,
    normalizeTicker,
} from '../../../src/services/fishTrading/marketData';

// 2026-10-23 09:30 EDT = 13:30 UTC
const OPEN = Date.UTC(2026, 9, 23, 13, 30) / 1000;
const CLOSE = OPEN + 390 * 60;

interface PayloadOptions {
    bars?: number;
    nullAt?: number[];
    includeCloseBar?: boolean;
}

function payload(opts: PayloadOptions = {}): unknown {
    const bars = opts.bars ?? 390;
    const timestamp: number[] = [OPEN - 120, OPEN - 60]; // pre-market strays
    const close: (number | null)[] = [99, 99];
    for (let i = 0; i < bars; i++) {
        timestamp.push(OPEN + i * 60);
        close.push(opts.nullAt?.includes(i) ? null : 100 + i * 0.01);
    }
    if (opts.includeCloseBar ?? true) {
        timestamp.push(CLOSE);
        close.push(150);
    }
    return {
        chart: {
            result: [
                {
                    meta: {
                        currency: 'USD',
                        symbol: 'AAPL',
                        exchangeName: 'NMS',
                        fullExchangeName: 'NasdaqGS',
                        longName: 'Apple Inc.',
                        shortName: 'Apple',
                        exchangeTimezoneName: 'America/New_York',
                        gmtoffset: -14400,
                        currentTradingPeriod: {
                            regular: { start: OPEN, end: CLOSE },
                        },
                        tradingPeriods: [[{ start: OPEN, end: CLOSE }]],
                    },
                    timestamp,
                    indicators: { quote: [{ close }] },
                },
            ],
            error: null,
        },
    };
}

function okFetch(body: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(
        async () => new Response(JSON.stringify(body), { status: 200 })
    );
}

beforeEach(() => clearMarketDataCache());

describe('normalizeTicker', () => {
    it('accepts and normalizes common tickers', () => {
        expect(normalizeTicker('aapl')).toBe('AAPL');
        expect(normalizeTicker('  $msft ')).toBe('MSFT');
        expect(normalizeTicker('BRK.B')).toBe('BRK.B');
        expect(normalizeTicker('brk-b')).toBe('BRK-B');
        expect(normalizeTicker('^gspc')).toBe('^GSPC');
        expect(normalizeTicker('btc-usd')).toBe('BTC-USD');
        expect(normalizeTicker('eurusd=x')).toBe('EURUSD=X');
    });

    it('rejects things that are not tickers', () => {
        for (const bad of [
            '',
            '   ',
            '$',
            'two words',
            '<@123>',
            'https://x.com',
            '-AAPL',
            'A'.repeat(16),
            'AA/PL',
        ]) {
            expect(normalizeTicker(bad)).toBeNull();
        }
    });

    it('REAL_TICKERS are all valid and unique', () => {
        expect(REAL_TICKERS.length).toBeGreaterThanOrEqual(15);
        expect(new Set(REAL_TICKERS).size).toBe(REAL_TICKERS.length);
        for (const t of REAL_TICKERS) expect(normalizeTicker(t)).toBe(t);
    });
});

describe('fetchIntradaySession', () => {
    it('parses a session, dropping stray, null and closing bars', async () => {
        const fetchImpl = okFetch(payload({ nullAt: [3, 7] }));
        const s = await fetchIntradaySession('aapl', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now: () => (OPEN + 3600) * 1000,
        });
        expect(s.symbol).toBe('AAPL');
        expect(s.name).toBe('Apple Inc.');
        expect(s.currency).toBe('USD');
        expect(s.exchange).toBe('NasdaqGS');
        expect(s.sessionDate).toBe('2026-10-23');
        expect(s.sessionOpen).toBe(OPEN);
        expect(s.sessionClose).toBe(CLOSE);
        expect(s.timestamps).toHaveLength(388);
        expect(s.prices).toHaveLength(388);
        expect(s.timestamps[0]).toBe(OPEN);
        expect(s.timestamps[s.timestamps.length - 1]).toBe(CLOSE - 60);
        expect(s.timestamps).not.toContain(OPEN + 3 * 60);
        expect(s.prices).not.toContain(150);
        expect(s.prices).not.toContain(99);
        expect(s.inProgress).toBe(true);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toContain('/v8/finance/chart/AAPL?interval=1m&range=1d');
        expect((init.headers as Record<string, string>)['User-Agent']).toMatch(
            /Mozilla/
        );
    });

    it('marks a finished session as not in progress and URL-encodes the symbol', async () => {
        const fetchImpl = okFetch(payload());
        const s = await fetchIntradaySession('^gspc', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now: () => (CLOSE + 10) * 1000,
        });
        expect(s.inProgress).toBe(false);
        expect(fetchImpl.mock.calls[0][0]).toContain('/chart/%5EGSPC?');
    });

    it('rejects invalid symbols without fetching', async () => {
        const fetchImpl = okFetch(payload());
        await expect(
            fetchIntradaySession('not a ticker', {
                fetchImpl: fetchImpl as unknown as typeof fetch,
            })
        ).rejects.toBeInstanceOf(MarketDataError);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('turns 404 into an unknown-ticker error', async () => {
        const body = {
            chart: {
                result: null,
                error: { code: 'Not Found', description: 'No data found' },
            },
        };
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify(body), { status: 404 })
        );
        await expect(
            fetchIntradaySession('XYZ', {
                fetchImpl: fetchImpl as unknown as typeof fetch,
            })
        ).rejects.toThrow("Couldn't find ticker `XYZ`.");
    });

    it('turns a null result on a 200 into an unknown-ticker error', async () => {
        const fetchImpl = okFetch({ chart: { result: null, error: null } });
        await expect(
            fetchIntradaySession('XYZ', {
                fetchImpl: fetchImpl as unknown as typeof fetch,
            })
        ).rejects.toThrow("Couldn't find ticker `XYZ`.");
    });

    it('wraps network failures without leaking the raw error', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNRESET secret-internal-detail');
        });
        const err = await fetchIntradaySession('AAPL', {
            fetchImpl: fetchImpl as unknown as typeof fetch,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MarketDataError);
        expect((err as Error).message).toBe(
            "Couldn't reach the market data provider right now."
        );
    });

    it('wraps non-OK statuses', async () => {
        const fetchImpl = vi.fn(
            async () => new Response('nope', { status: 500 })
        );
        await expect(
            fetchIntradaySession('AAPL', {
                fetchImpl: fetchImpl as unknown as typeof fetch,
            })
        ).rejects.toThrow("Couldn't reach the market data provider right now.");
    });

    it('rejects sessions with too few usable bars', async () => {
        const fetchImpl = okFetch(payload({ bars: 30 }));
        await expect(
            fetchIntradaySession('AAPL', {
                fetchImpl: fetchImpl as unknown as typeof fetch,
            })
        ).rejects.toThrow('Not enough trading data for `AAPL` yet today.');
    });

    it('caches for 60 seconds', async () => {
        const fetchImpl = okFetch(payload());
        let t = (OPEN + 3600) * 1000;
        const options = {
            fetchImpl: fetchImpl as unknown as typeof fetch,
            now: () => t,
        };
        await fetchIntradaySession('AAPL', options);
        t += 59_000;
        await fetchIntradaySession('aapl', options);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        t += 2_000;
        await fetchIntradaySession('AAPL', options);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not cache failures', async () => {
        const bad = vi.fn(async () => new Response('x', { status: 500 }));
        await expect(
            fetchIntradaySession('AAPL', {
                fetchImpl: bad as unknown as typeof fetch,
            })
        ).rejects.toBeInstanceOf(MarketDataError);
        const good = okFetch(payload());
        await fetchIntradaySession('AAPL', {
            fetchImpl: good as unknown as typeof fetch,
        });
        expect(good).toHaveBeenCalledTimes(1);
    });
});
