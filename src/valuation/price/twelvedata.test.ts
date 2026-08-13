/**
 * Twelve Data provider tests, with the clock and the sleep both injected.
 *
 * The subject here is the rate limiting, which is the part of this provider that was missing
 * rather than wrong. Twelve Data charges **one credit per symbol** — batching twenty symbols into
 * one request costs twenty credits against an eight-a-minute allowance — so the failure is not a
 * loop that goes too fast but a single request that is too large. Every test below therefore
 * asserts on *what was asked for*, not only on what came back.
 *
 * `tests/setup.ts` installs a socket guard: nothing here reaches a network.
 */

import { describe, expect, it } from 'vitest'
import { instrument } from '../__fixtures__/build'
import type { InstrumentRef } from '../types'
import { MinuteWindow, TwelveDataProvider, symbolFor } from './twelvedata'

const NEVER_ABORTED = new AbortController().signal

/** The plan-independent case: US tickers, which Basic covers. */
const us = (n: number): InstrumentRef =>
  instrument({
    id: `i-${n.toString()}`,
    assetClass: 'us_equity',
    currency: 'USD',
    displayName: `Holding ${n.toString()}`,
    aliases: [{ scheme: 'ticker', value: `SYM${n.toString().padStart(2, '0')}`, providerId: null }],
  })

/** A quote body answering every symbol asked for, so nothing fails for an unrelated reason. */
function quoteBody(url: string): string {
  const symbols = decodeURIComponent(/symbol=([^&]*)/.exec(url)?.[1] ?? '').split(',')
  const entries: Record<string, unknown> = {}
  for (const symbol of symbols) {
    entries[symbol] = {
      symbol,
      close: '100.00',
      previous_close: '99.00',
      datetime: '2026-08-12',
      is_market_open: false,
    }
  }
  return JSON.stringify(entries)
}

/**
 * A transport that records every URL, and a clock that only moves when the provider sleeps.
 *
 * Time advancing solely through `sleep` is what makes the window assertable: if the provider did
 * not pace itself, the clock never moves and the window never clears.
 */
function harness(status: (call: number) => number = () => 200) {
  const urls: string[] = []
  const waits: number[] = []
  let clock = 1_786_000_000_000
  const provider = new TwelveDataProvider({
    apiKey: 'k',
    plan: 'basic',
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms)
      clock += ms
      return Promise.resolve()
    },
    fetcher: (url) => {
      urls.push(url)
      const code = status(urls.length)
      return Promise.resolve({ status: code, body: code === 429 ? '' : quoteBody(url) })
    },
  })
  return { provider, urls, waits, symbolsIn: (url: string) => symbolsOf(url).length }
}

function symbolsOf(url: string): string[] {
  return decodeURIComponent(/symbol=([^&]*)/.exec(url)?.[1] ?? '').split(',')
}

describe('the minute window', () => {
  it('lets the allowance through and then holds until the oldest spend expires', () => {
    const window = new MinuteWindow(8)
    window.record(5, 1_000)
    expect(window.waitFor(3, 1_000)).toBe(0)
    window.record(3, 1_000)
    // Full. The next credit waits for the 1_000 spend to age out, not for a smooth refill: the
    // provider's limit is "no more than eight in any sixty seconds".
    expect(window.waitFor(1, 2_000)).toBe(60_000 - 1_000)
    expect(window.waitFor(1, 61_500)).toBe(0)
  })
})

describe('the per-minute limit', () => {
  it('splits a batch into chunks the allowance can carry, instead of spending twenty credits at once', async () => {
    // The defect: `/quote` takes a comma-separated list, so twenty holdings went out as one
    // request — twenty credits against an eight-a-minute limit, refused outright, sync failed.
    const { provider, urls, waits } = harness()
    const refs = Array.from({ length: 20 }, (_, index) => us(index))
    const results = await provider.fetchLatest(refs, NEVER_ABORTED)

    expect(urls).toHaveLength(3)
    for (const url of urls) expect(symbolsOf(url).length).toBeLessThanOrEqual(8)
    expect(symbolsOf(urls[0] ?? '')).toHaveLength(8)
    expect(symbolsOf(urls[2] ?? '')).toHaveLength(4)
    // Two waits, one before each chunk after the first, each a full window.
    expect(waits).toEqual([60_000, 60_000])
    expect(results).toHaveLength(20)
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('asks for nothing at all when the batch fits', async () => {
    const { provider, urls, waits } = harness()
    await provider.fetchLatest([us(1), us(2)], NEVER_ABORTED)
    expect(urls).toHaveLength(1)
    expect(waits).toEqual([])
  })
})

describe('a refusal', () => {
  it('stands down for the rest of the run rather than retrying into a ban', async () => {
    // 429 on the first chunk. The remaining twelve symbols are reported as rate limited without
    // a single further request: every one would be refused, and each would lengthen the block.
    const { provider, urls } = harness((call) => (call === 1 ? 429 : 200))
    const refs = Array.from({ length: 20 }, (_, index) => us(index))
    const results = await provider.fetchLatest(refs, NEVER_ABORTED)

    expect(urls).toHaveLength(1)
    expect(results).toHaveLength(20)
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('RATE_LIMITED')
    }
  })

  it('refuses a later call locally while the stand-down is still running', async () => {
    const { provider, urls } = harness((call) => (call === 1 ? 429 : 200))
    await provider.fetchLatest([us(1)], NEVER_ABORTED)
    expect(urls).toHaveLength(1)

    // Nothing has moved the clock — the provider does not sleep off a refusal — so the second
    // call is answered from the stand-down without touching the transport.
    const [again] = await provider.fetchLatest([us(2)], NEVER_ABORTED)
    expect(urls).toHaveLength(1)
    expect(again?.ok).toBe(false)
    if (again?.ok !== false) return
    expect(again.error).toEqual({ code: 'RATE_LIMITED', retryAfterMs: 60_000 })
  })

  it('reads a 429 inside a 200 body as a refusal too', async () => {
    const urls: string[] = []
    const provider = new TwelveDataProvider({
      apiKey: 'k',
      plan: 'basic',
      now: () => 1_786_000_000_000,
      sleep: () => Promise.resolve(),
      fetcher: (url) => {
        urls.push(url)
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({
            SYM01: { status: 'error', code: 429, message: 'You have run out of API credits' },
          }),
        })
      },
    })
    const [first] = await provider.fetchLatest([us(1)], NEVER_ABORTED)
    expect(first?.ok).toBe(false)
    await provider.fetchLatest([us(2)], NEVER_ABORTED)
    // One request in total: the second call was refused locally.
    expect(urls).toHaveLength(1)
  })
})

describe('the session', () => {
  it('does not store a quote taken while the market is open', async () => {
    const provider = new TwelveDataProvider({
      apiKey: 'k',
      plan: 'basic',
      now: () => 1_786_000_000_000,
      sleep: () => Promise.resolve(),
      fetcher: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({
            SYM01: {
              symbol: 'SYM01',
              close: '100.00',
              datetime: '2026-08-12',
              is_market_open: true,
            },
          }),
        }),
    })
    const [quote] = await provider.fetchLatest([us(1)], NEVER_ABORTED)
    expect(quote?.ok).toBe(true)
    if (quote?.ok !== true) return
    // Twelve Data states the session outright, so nothing has to be inferred from a timestamp.
    expect(quote.intraday).toBe(true)
  })
})

describe('symbols', () => {
  it('builds an exchange-suffixed symbol from the alias, never from the display name', () => {
    expect(symbolFor(us(1))).toBe('SYM01')
  })
})
