/**
 * CoinGecko provider tests, driven by captured response bodies.
 *
 * The important fixture is the one that looks like a success: `?ids=bitcoin,ethereum,not-a-real-coin`
 * returns HTTP 200 with two entries and no mention at all of the third. Everything about how this
 * provider reads a response follows from that.
 */

import { describe, expect, it } from 'vitest'
import { instrument } from '../__fixtures__/build'
import type { InstrumentRef } from '../types'
import { CoinGeckoProvider, coinIdFor, parseSimplePrice } from './coingecko'

const NEVER_ABORTED = new AbortController().signal

/** Captured. The unknown id is simply absent — no error, no null, no key. */
const SIMPLE_PRICE = JSON.stringify({
  bitcoin: { inr: 6061005.018552231, usd: 63554.20575823518, last_updated_at: 1786594890 },
  ethereum: { inr: 179699.9362355106, usd: 1884.2892700625744, last_updated_at: 1786594890 },
})

function replay(status: number, body: string): {
  fetcher: (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fetcher: (url) => {
      calls.push(url)
      return Promise.resolve({ status, body })
    },
  }
}

const coin = (id: string, gecko: string, currency: 'INR' | 'USD' = 'INR'): InstrumentRef =>
  instrument({
    id,
    assetClass: 'crypto',
    currency,
    displayName: gecko,
    aliases: [{ scheme: 'coingecko', value: gecko, providerId: null }],
  })

describe('anchoring on the coingecko alias', () => {
  it('uses the alias a human resolved, never a ticker', () => {
    expect(coinIdFor(coin('i1', 'bitcoin'))).toBe('bitcoin')
    // A ticker alias is not an identifier in crypto: CoinGecko carries many unrelated assets
    // sharing a symbol, and a wrong merge double-counts net worth.
    expect(
      coinIdFor(
        instrument({
          assetClass: 'crypto',
          aliases: [{ scheme: 'ticker', value: 'BTC', providerId: null }],
        }),
      ),
    ).toBeNull()
  })

  it('claims nothing outside crypto', () => {
    expect(
      coinIdFor(
        instrument({
          assetClass: 'us_equity',
          aliases: [{ scheme: 'coingecko', value: 'bitcoin', providerId: null }],
        }),
      ),
    ).toBeNull()
  })

  it('refuses an id that could reshape the query string', () => {
    for (const value of ['bit coin', 'bitcoin&x=1', 'BITCOIN?', '', '../x']) {
      expect(
        coinIdFor(
          instrument({
            assetClass: 'crypto',
            aliases: [{ scheme: 'coingecko', value, providerId: null }],
          }),
        ),
      ).toBeNull()
    }
  })
})

describe('parsing simple/price', () => {
  it('keeps every digit that arrived on the wire', () => {
    const parsed = parseSimplePrice(SIMPLE_PRICE, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.get('bitcoin/inr')?.price).toBe('6061005.018552231')
    expect(parsed.value.get('ethereum/usd')?.price).toBe('1884.2892700625744')
  })

  it('keys by currency so an INR holding is never handed the USD figure beside it', () => {
    const parsed = parseSimplePrice(SIMPLE_PRICE, 200)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.get('bitcoin/inr')?.price).not.toBe(parsed.value.get('bitcoin/usd')?.price)
  })

  it('reports a rate limit rather than an empty result set', () => {
    const parsed = parseSimplePrice('{"status":{"error_code":429}}', 429)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toEqual({ code: 'RATE_LIMITED', retryAfterMs: 60_000 })
  })
})

describe('fetching the latest price', () => {
  it('asks once for the whole book', async () => {
    const { fetcher, calls } = replay(200, SIMPLE_PRICE)
    const results = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [coin('i1', 'bitcoin'), coin('i2', 'ethereum')],
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('ids=bitcoin%2Cethereum')
    expect(calls[0]).toContain('precision=full')
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('reads a price in the instrument currency, dated by last_updated_at', async () => {
    const { fetcher } = replay(200, SIMPLE_PRICE)
    const [quote] = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [coin('i1', 'bitcoin')],
      NEVER_ABORTED,
    )
    expect(quote?.ok).toBe(true)
    if (quote?.ok !== true) return
    expect(quote.price).toEqual({ value: '6061005.018552231', currency: 'INR' })
    expect(quote.asOf).toBe('2026-08-13')
    // /simple/price carries no prior close; a repeated value would render as a flat 0.00% day.
    expect(quote.previousClose).toBeNull()
  })

  it('picks the right vs-currency per instrument in a mixed batch', async () => {
    const { fetcher, calls } = replay(200, SIMPLE_PRICE)
    const results = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [coin('i1', 'bitcoin', 'INR'), coin('i2', 'ethereum', 'USD')],
      NEVER_ABORTED,
    )
    expect(calls[0]).toContain('vs_currencies=inr%2Cusd')
    expect(results[0]?.ok === true ? results[0].price.value : null).toBe('6061005.018552231')
    expect(results[1]?.ok === true ? results[1].price.value : null).toBe('1884.2892700625744')
  })

  it('reports an id CoinGecko silently omitted rather than leaving it looking fresh', async () => {
    // The trap: a 200 with the coin simply missing. Iterating what came back would have lost it.
    const { fetcher } = replay(200, SIMPLE_PRICE)
    const results = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [coin('i1', 'bitcoin'), coin('i2', 'not-a-real-coin')],
      NEVER_ABORTED,
    )
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
    if (results[1]?.ok !== false) return
    expect(results[1].error.code).toBe('NOT_FOUND')
  })

  it('refuses the whole batch on a rate limit, and does not retry', async () => {
    const { fetcher, calls } = replay(429, '')
    const results = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [coin('i1', 'bitcoin'), coin('i2', 'ethereum')],
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(1)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('RATE_LIMITED')
    }
  })

  it('writes nothing when the transport fails', async () => {
    const provider = new CoinGeckoProvider({ fetcher: () => Promise.reject(new Error('offline')) })
    const results = await provider.fetchLatest([coin('i1', 'bitcoin')], NEVER_ABORTED)
    expect(results[0]?.ok).toBe(false)
    if (results[0]?.ok !== false) return
    expect(results[0].error.code).toBe('OFFLINE')
  })

  it('names an instrument it cannot cover without asking about it', async () => {
    const { fetcher, calls } = replay(200, SIMPLE_PRICE)
    const results = await new CoinGeckoProvider({ fetcher }).fetchLatest(
      [instrument({ assetClass: 'indian_equity' })],
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(0)
    expect(results[0]?.ok === false ? results[0].error.code : null).toBe('NOT_SUPPORTED')
  })
})

describe('history', () => {
  it('reads daily points and clips them to the requested range', async () => {
    const chart = JSON.stringify({
      prices: [
        [1786060800000, 5900000.5],
        [1786147200000, 5950000.25],
        [1786233600000, 6000000.75],
      ],
    })
    const { fetcher, calls } = replay(200, chart)
    const result = await new CoinGeckoProvider({ fetcher }).fetchHistory(
      coin('i1', 'bitcoin'),
      '2026-08-07',
      '2026-08-08',
      NEVER_ABORTED,
    )
    expect(calls[0]).toContain('/coins/bitcoin/market_chart')
    expect(calls[0]).toContain('vs_currency=inr')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((c) => c.asOf)).toEqual(['2026-08-07', '2026-08-08'])
    expect(result.value[0]?.close).toBe('5900000.5')
  })

  it('refuses a range beyond the public plan rather than mis-dating hourly points', async () => {
    const { fetcher, calls } = replay(200, '{"prices":[]}')
    const result = await new CoinGeckoProvider({ fetcher }).fetchHistory(
      coin('i1', 'bitcoin'),
      '2020-01-01',
      '2026-08-08',
      NEVER_ABORTED,
    )
    expect(calls).toHaveLength(0)
    expect(result.ok).toBe(false)
  })
})
