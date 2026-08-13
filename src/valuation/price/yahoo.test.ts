/**
 * Yahoo provider tests, driven entirely by captured response bodies.
 *
 * Every fixture below is a real Yahoo response, trimmed but not edited: the float32 artefacts, the
 * null currency on the scrip-code stub and the 404 error envelope are exactly what the endpoint
 * returns. Inventing a tidier body would have tested a Yahoo that does not exist, and three of
 * these cases were only discovered by looking.
 *
 * `tests/setup.ts` installs a socket guard, so a provider that reached the network here would fail
 * loudly rather than quietly hitting a real endpoint.
 */

import { describe, expect, it } from 'vitest'
import { instrument } from '../__fixtures__/build'
import type { InstrumentRef } from '../types'
import {
  YahooProvider,
  fxSymbolFor,
  parseChartHistory,
  parseChartQuote,
  yahooSymbolFor,
} from './yahoo'

const NEVER_ABORTED = new AbortController().signal

/** INFY on the NSE. Note `close` carries Yahoo's float32 rounding and `meta` does not. */
const INFY_NS = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'INFY.NS',
          exchangeName: 'NSI',
          instrumentType: 'EQUITY',
          regularMarketTime: 1786594942,
          gmtoffset: 19800,
          timezone: 'IST',
          exchangeTimezoneName: 'Asia/Kolkata',
          regularMarketPrice: 1163.6,
          chartPreviousClose: 1175.1,
          priceHint: 2,
        },
        timestamp: [1786074300, 1786333500],
        indicators: {
          quote: [{ close: [1175.0999755859375, 1183.0] }],
        },
      },
    ],
    error: null,
  },
})

/** AAPL, to prove the as-of date follows the exchange rather than the machine. */
const AAPL = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'AAPL',
          exchangeName: 'NMS',
          // 2026-08-12 20:00:01Z — already the 13th in IST, still the 12th in New York.
          regularMarketTime: 1786564801,
          exchangeTimezoneName: 'America/New_York',
          regularMarketPrice: 302.25,
          chartPreviousClose: 312.51,
        },
      },
    ],
    error: null,
  },
})

/**
 * The trap. `500209.BO` is Infosys's BSE *scrip code*; Yahoo answers 200 with no error and a
 * result whose meta has a null currency, no price, and a 2019 timestamp.
 */
const SCRIP_CODE_STUB = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: null,
          symbol: '500209.BO',
          exchangeName: 'YHD',
          instrumentType: 'MUTUALFUND',
          regularMarketTime: 1561759658,
          exchangeTimezoneName: 'America/New_York',
          fiftyTwoWeekHigh: 1672.45,
          priceHint: 2,
        },
        indicators: { quote: [{}], adjclose: [{}] },
      },
    ],
    error: null,
  },
})

const NOT_FOUND = JSON.stringify({
  chart: {
    result: null,
    error: { code: 'Not Found', description: 'No data found, symbol may be delisted' },
  },
})

const USD_INR = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'USDINR=X',
          exchangeName: 'CCY',
          instrumentType: 'CURRENCY',
          regularMarketTime: 1786595064,
          exchangeTimezoneName: 'Europe/London',
          regularMarketPrice: 95.3575,
          chartPreviousClose: 95.32,
          priceHint: 4,
        },
      },
    ],
    error: null,
  },
})

/** A replay transport. Records what was asked for, so "it did not ask" is assertable. */
function replay(routes: readonly { match: RegExp; status: number; body: string }[]): {
  fetcher: (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fetcher: (url) => {
      calls.push(url)
      const route = routes.find((r) => r.match.test(url))
      if (route === undefined) return Promise.reject(new Error(`no fixture for ${url}`))
      return Promise.resolve({ status: route.status, body: route.body })
    },
  }
}

function provider(
  routes: readonly { match: RegExp; status: number; body: string }[],
): { instance: YahooProvider; calls: string[] } {
  const { fetcher, calls } = replay(routes)
  return {
    instance: new YahooProvider({ fetcher, sleep: () => Promise.resolve() }),
    calls,
  }
}

const nse = (id = 'i-infy'): InstrumentRef =>
  instrument({
    id,
    assetClass: 'indian_equity',
    displayName: 'Infosys',
    aliases: [{ scheme: 'nse', value: 'INFY', providerId: null }],
  })

const us = (): InstrumentRef =>
  instrument({
    id: 'i-aapl',
    assetClass: 'us_equity',
    currency: 'USD',
    displayName: 'Apple',
    aliases: [{ scheme: 'ticker', value: 'AAPL', providerId: null }],
  })

describe('symbol construction', () => {
  it('suffixes NSE lines with .NS and prefers them over BSE', () => {
    expect(yahooSymbolFor(nse())).toBe('INFY.NS')
    expect(
      yahooSymbolFor(
        instrument({
          assetClass: 'indian_equity',
          aliases: [
            { scheme: 'bse', value: 'INFY', providerId: null },
            { scheme: 'nse', value: 'INFY', providerId: null },
          ],
        }),
      ),
    ).toBe('INFY.NS')
  })

  it('suffixes a BSE ticker with .BO', () => {
    expect(
      yahooSymbolFor(
        instrument({
          assetClass: 'indian_equity',
          aliases: [{ scheme: 'bse', value: 'infy', providerId: null }],
        }),
      ),
    ).toBe('INFY.BO')
  })

  it('refuses a numeric BSE scrip code rather than building a symbol that resolves to a stub', () => {
    // 500209.BO is a real Yahoo page. It carries a 2019 price and no currency, and would have
    // been accepted by any parser that trusted a 200.
    expect(
      yahooSymbolFor(
        instrument({
          assetClass: 'indian_equity',
          aliases: [{ scheme: 'bse', value: '500209', providerId: null }],
        }),
      ),
    ).toBeNull()
  })

  it('claims nothing it cannot name from an alias', () => {
    expect(yahooSymbolFor(instrument({ assetClass: 'indian_equity' }))).toBeNull()
    expect(yahooSymbolFor(instrument({ assetClass: 'mutual_fund' }))).toBeNull()
    expect(yahooSymbolFor(instrument({ assetClass: 'crypto' }))).toBeNull()
    expect(yahooSymbolFor(instrument({ assetClass: 'gold' }))).toBeNull()
  })

  it('refuses a symbol that could reshape the URL', () => {
    for (const value of ['../../admin', 'INFY?x=1', 'IN FY', 'INFY&a=b', '']) {
      expect(
        yahooSymbolFor(
          instrument({
            assetClass: 'indian_equity',
            aliases: [{ scheme: 'nse', value, providerId: null }],
          }),
        ),
      ).toBeNull()
    }
  })

  it('builds the currency-pair symbol Yahoo actually uses', () => {
    expect(fxSymbolFor({ base: 'USD', quote: 'INR' })).toBe('USDINR=X')
  })
})

describe('parsing a quote', () => {
  it('takes the price from meta, not from the float32 candles', () => {
    // The whole reason meta is preferred: the candle for the same session says
    // 1175.0999755859375. Storing that would put four digits of Yahoo's rounding error in the row.
    const parsed = parseChartQuote(INFY_NS, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.price).toBe('1163.6')
    expect(parsed.value.previousClose).toBe('1175.1')
    expect(parsed.value.currency).toBe('INR')
  })

  it('dates the price by the exchange, not by the machine', () => {
    const parsed = parseChartQuote(AAPL, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // 20:00Z is the 13th in Mumbai and the 12th in New York. A US close belongs to the 12th.
    expect(parsed.value.asOf).toBe('2026-08-12')
  })

  it('refuses a result with no regularMarketPrice instead of reaching into the candles', () => {
    const parsed = parseChartQuote(SCRIP_CODE_STUB, 200)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('MALFORMED_RESPONSE')
  })

  it('reads the delisted envelope as NOT_FOUND', () => {
    const parsed = parseChartQuote(NOT_FOUND, 404)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('NOT_FOUND')
  })

  it('reports a rate limit rather than a missing price', () => {
    const parsed = parseChartQuote('', 429)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toEqual({ code: 'RATE_LIMITED', retryAfterMs: 60_000 })
  })

  it('treats an edge block as upstream rather than as an auth failure', () => {
    // Yahoo has no key to be wrong, so telling the user to check their credentials would send
    // them to fix something that does not exist.
    const parsed = parseChartQuote('<html>blocked</html>', 403)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toEqual({ code: 'UPSTREAM', status: 403 })
  })

  it('refuses a body that is not JSON at all', () => {
    const parsed = parseChartQuote('<!DOCTYPE html><h1>Will be right back</h1>', 200)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('MALFORMED_RESPONSE')
  })
})

describe('fetching the latest price', () => {
  it('returns a quote in the instrument currency', async () => {
    const { instance, calls } = provider([{ match: /INFY\.NS/, status: 200, body: INFY_NS }])
    const [quote] = await instance.fetchLatest([nse()], NEVER_ABORTED)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/v8/finance/chart/INFY.NS')
    expect(quote?.ok).toBe(true)
    if (quote?.ok !== true) return
    expect(quote.price).toEqual({ value: '1163.6', currency: 'INR' })
    expect(quote.asOf).toBe('2026-08-13')
    expect(quote.previousClose).toEqual({ value: '1175.1', currency: 'INR' })
  })

  it('refuses to convert when Yahoo quotes a different currency', async () => {
    // The pence trap: an LSE line comes back as GBp. A hundredfold error that looks plausible.
    const pence = JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              currency: 'GBp',
              symbol: 'INFY.NS',
              regularMarketTime: 1786594942,
              exchangeTimezoneName: 'Asia/Kolkata',
              regularMarketPrice: 116360,
            },
          },
        ],
        error: null,
      },
    })
    const { instance } = provider([{ match: /INFY/, status: 200, body: pence }])
    const [quote] = await instance.fetchLatest([nse()], NEVER_ABORTED)
    expect(quote?.ok).toBe(false)
    if (quote?.ok !== false) return
    expect(quote.error.code).toBe('MALFORMED_RESPONSE')
  })

  it('names an instrument it cannot cover rather than asking about it', async () => {
    const { instance, calls } = provider([])
    const [quote] = await instance.fetchLatest(
      [instrument({ assetClass: 'mutual_fund' })],
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(0)
    expect(quote?.ok).toBe(false)
    if (quote?.ok !== false) return
    expect(quote.error.code).toBe('NOT_SUPPORTED')
  })

  it('stops the batch at a rate limit instead of retrying into a longer block', async () => {
    const { instance, calls } = provider([{ match: /.*/, status: 429, body: '' }])
    const results = await instance.fetchLatest(
      [nse('a'), nse('b'), nse('c'), us()],
      NEVER_ABORTED,
    )
    // One request, four refusals. Every further attempt would extend the block and buy nothing.
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(4)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('RATE_LIMITED')
    }
  })

  it('stops the batch when the transport is unreachable', async () => {
    const calls: string[] = []
    const instance = new YahooProvider({
      fetcher: (url) => {
        calls.push(url)
        return Promise.reject(new Error('offline'))
      },
      sleep: () => Promise.resolve(),
    })
    const results = await instance.fetchLatest([nse('a'), nse('b')], NEVER_ABORTED)
    expect(calls).toHaveLength(1)
    expect(results.every((r) => !r.ok)).toBe(true)
  })

  it('reports one bad symbol without losing the rest of the batch', async () => {
    const { instance } = provider([
      { match: /INFY\.NS/, status: 200, body: INFY_NS },
      { match: /AAPL/, status: 404, body: NOT_FOUND },
    ])
    const results = await instance.fetchLatest([nse(), us()], NEVER_ABORTED)
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
  })

  it('does not fetch once the refresh has been cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { instance, calls } = provider([{ match: /.*/, status: 200, body: INFY_NS }])
    const results = await instance.fetchLatest([nse()], controller.signal)
    expect(calls).toHaveLength(0)
    expect(results[0]?.ok).toBe(false)
  })
})

describe('history', () => {
  it('keeps the candle literal exactly as sent, artefacts and all', () => {
    // Yahoo stores candles as float32. The rounding is theirs; repairing it here would be an
    // invented price, which is a worse thing to store than an inherited one.
    const parsed = parseChartHistory(INFY_NS, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.closes.map((c) => c.close)).toEqual(['1175.0999755859375', '1183'])
  })

  it('drops a session with no print rather than carrying the previous close forward', () => {
    const halted = JSON.stringify({
      chart: {
        result: [
          {
            meta: { currency: 'INR', exchangeTimezoneName: 'Asia/Kolkata' },
            timestamp: [1786074300, 1786333500, 1786419900],
            indicators: { quote: [{ close: [1175.1, null, 1190.7] }] },
          },
        ],
        error: null,
      },
    })
    const parsed = parseChartHistory(halted, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.closes).toHaveLength(2)
  })

  it('asks for the full range inclusive of the last day', async () => {
    const { instance, calls } = provider([{ match: /.*/, status: 200, body: INFY_NS }])
    await instance.fetchHistory(nse(), '2026-08-01', '2026-08-05', NEVER_ABORTED)
    // 1785542400 is 1 Aug and 1785888000 is 5 Aug. period2 cuts at an instant rather than at the
    // end of a day, so it sits a day past `to` or the last day asked for is silently missing.
    expect(calls[0]).toContain('period1=1785542400')
    expect(calls[0]).toContain('period2=1785974400')
  })
})

describe('exchange rates', () => {
  it('reads USD/INR keylessly, which is what lets a foreign holding into net worth at all', async () => {
    const { instance, calls } = provider([{ match: /USDINR/, status: 200, body: USD_INR }])
    const [quote] = await instance.fetchFx([{ base: 'USD', quote: 'INR' }], 'latest', NEVER_ABORTED)
    expect(calls[0]).toContain('/v8/finance/chart/USDINR=X')
    expect(quote?.ok).toBe(true)
    if (quote?.ok !== true) return
    expect(quote.rate).toBe('95.3575')
    // Dated on the base currency's calendar rather than Yahoo's Europe/London pseudo-exchange.
    expect(quote.asOf).toBe('2026-08-13')
  })

  it('refuses a pair that came back quoted in something else', async () => {
    // An inverted or reinterpreted rate turns a ₹50 lakh holding into ₹6,500. Never guessed at.
    const wrong = USD_INR.replace('"currency":"INR"', '"currency":"USD"')
    const { instance } = provider([{ match: /USDINR/, status: 200, body: wrong }])
    const [quote] = await instance.fetchFx([{ base: 'USD', quote: 'INR' }], 'latest', NEVER_ABORTED)
    expect(quote?.ok).toBe(false)
    if (quote?.ok !== false) return
    expect(quote.error.code).toBe('MALFORMED_RESPONSE')
  })

  it('takes the last close at or before a requested date, never an interpolation', async () => {
    const series = JSON.stringify({
      chart: {
        result: [
          {
            meta: { currency: 'INR', exchangeTimezoneName: 'Asia/Kolkata' },
            // 6, 7 and 10 August; the 8th and 9th are a weekend with no print.
            timestamp: [1785974400, 1786060800, 1786320000],
            indicators: { quote: [{ close: [94.1, 94.5, 95.2] }] },
          },
        ],
        error: null,
      },
    })
    const { instance } = provider([{ match: /USDINR/, status: 200, body: series }])
    const [quote] = await instance.fetchFx(
      [{ base: 'USD', quote: 'INR' }],
      '2026-08-09',
      NEVER_ABORTED,
    )
    expect(quote?.ok).toBe(true)
    if (quote?.ok !== true) return
    expect(quote.rate).toBe('94.5')
    expect(quote.asOf).toBe('2026-08-09')
  })

  it('reports a rate limit on the FX path too', async () => {
    const { instance, calls } = provider([{ match: /.*/, status: 429, body: '' }])
    const results = await instance.fetchFx(
      [
        { base: 'USD', quote: 'INR' },
        { base: 'USD', quote: 'INR' },
      ],
      'latest',
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(1)
    expect(results.every((r) => !r.ok)).toBe(true)
  })
})
