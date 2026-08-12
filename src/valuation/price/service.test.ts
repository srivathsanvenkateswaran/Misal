/**
 * Price service: reads that never fetch, manual overrides that survive a refresh, a credit budget
 * that survives a restart, and staleness that is defined per asset class.
 */

import { describe, expect, it } from 'vitest'
import { dec } from '@domain/numeric'
import { instrument, instrumentMap } from '../__fixtures__/build'
import {
  CreditBudget,
  InMemoryBudgetStore,
  InMemoryPriceStore,
  PriceService,
} from './service'
import { priceAge } from './staleness'
import { TwelveDataProvider, parseQuoteBody, symbolFor } from './twelvedata'
import type { InstrumentRef, IsoDate } from '../types'
import type { PricePoint, PriceProvider, QuoteResult } from './types'

const NOW = '2026-08-12T18:30:00+05:30'

function point(instrumentId: string, close: string, asOf: IsoDate, source: PricePoint['source']): PricePoint {
  return {
    instrumentId,
    asOf,
    close: dec(close),
    currency: 'INR',
    source,
    fetchedAt: `${asOf}T20:00:00+05:30`,
  }
}

/** A provider that answers from a script, so the tests never touch a network. */
function fakeProvider(script: ReadonlyMap<string, string>, id: 'amfi' | 'twelvedata' = 'amfi'): PriceProvider {
  return {
    id,
    capabilities: {
      assetClasses: ['mutual_fund', 'indian_equity'],
      requiresApiKey: false,
      latency: 'eod',
      supportsHistory: false,
      supportsFx: false,
      rateLimit: { perMinute: 8, perDay: 800, creditsPerSymbol: 1 },
    },
    supports: (ref: InstrumentRef) => ref.assetClass !== 'bond',
    fetchLatest: (refs) =>
      Promise.resolve(
        refs.map<QuoteResult>((ref) => {
          const close = script.get(ref.id)
          if (close === undefined) return { ok: false, ref, error: { code: 'NOT_FOUND' } }
          return {
            ok: true,
            ref,
            price: { value: dec(close), currency: ref.currency },
            asOf: '2026-08-12',
            previousClose: null,
          }
        }),
      ),
    fetchHistory: () => Promise.resolve({ ok: false, error: { code: 'NOT_SUPPORTED' } }),
  }
}

describe('reads', () => {
  const fund = instrument({ id: 'fund', assetClass: 'mutual_fund' })
  const bond = instrument({ id: 'bond', assetClass: 'bond' })
  const instruments = instrumentMap(fund, bond)

  it('distinguishes "never fetched" from "no provider covers it"', () => {
    const service = new PriceService({ store: new InMemoryPriceStore(), instruments, now: () => NOW })
    service.register(fakeProvider(new Map()))
    const supported = service.priceAt('fund', 'latest')
    const unsupported = service.priceAt('bond', 'latest')
    expect(supported.ok).toBe(false)
    if (!supported.ok) expect(supported.error.code).toBe('NO_PRICE')
    expect(unsupported.ok).toBe(false)
    // Permanent until a manual price is entered, which is a different prompt for the user.
    if (!unsupported.ok) expect(unsupported.error.code).toBe('NO_PRICE_SOURCE')
  })

  it('returns the most recent row at or before the requested date', () => {
    const store = new InMemoryPriceStore()
    store.put(point('fund', '100.0000', '2026-08-03', 'amfi'))
    store.put(point('fund', '110.0000', '2026-08-10', 'amfi'))
    const service = new PriceService({ store, instruments, now: () => NOW })
    const read = service.priceAt('fund', '2026-08-07')
    if (!read.ok) throw new Error('expected a price')
    expect(read.value.close).toBe('100.0000')
    expect(read.value.asOf).toBe('2026-08-03')
  })

  it('rejects a price in the wrong currency rather than valuing with it', () => {
    const store = new InMemoryPriceStore()
    store.put({ ...point('fund', '100.0000', '2026-08-10', 'amfi'), currency: 'USD' })
    const service = new PriceService({ store, instruments, now: () => NOW })
    const read = service.priceAt('fund', 'latest')
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('PRICE_CURRENCY_MISMATCH')
  })
})

describe('manual override precedence', () => {
  it('survives a refresh that would return a different value for the same date', async () => {
    const fund = instrument({ id: 'fund', assetClass: 'mutual_fund' })
    const instruments = instrumentMap(fund)
    const store = new InMemoryPriceStore()
    store.put(point('fund', '999.0000', '2026-08-12', 'manual'))
    const service = new PriceService({ store, instruments, now: () => NOW })
    service.register(fakeProvider(new Map([['fund', '100.0000']])))

    const report = await service.refresh({}, new AbortController().signal)
    expect(report.updated).toBe(0)
    const read = service.priceAt('fund', 'latest')
    if (!read.ok) throw new Error('expected a price')
    expect(read.value.close).toBe('999.0000')
    expect(read.value.source).toBe('manual')
  })

  it('lets a manual write replace a fetched value', () => {
    const store = new InMemoryPriceStore()
    expect(store.put(point('fund', '100.0000', '2026-08-12', 'amfi'))).toBe(true)
    expect(store.put(point('fund', '101.0000', '2026-08-12', 'manual'))).toBe(true)
    expect(store.put(point('fund', '102.0000', '2026-08-12', 'amfi'))).toBe(false)
    expect(store.latest('fund')?.close).toBe('101.0000')
  })
})

describe('refresh', () => {
  it('is a partial success: one unknown symbol does not lose the others', async () => {
    const good = instrument({ id: 'good', assetClass: 'mutual_fund' })
    const bad = instrument({ id: 'bad', assetClass: 'mutual_fund' })
    const instruments = instrumentMap(good, bad)
    const store = new InMemoryPriceStore()
    const service = new PriceService({ store, instruments, now: () => NOW })
    service.register(fakeProvider(new Map([['good', '250.0000']])))

    const report = await service.refresh({}, new AbortController().signal)
    expect(report.updated).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.failures[0]).toEqual({ instrumentId: 'bad', error: { code: 'NOT_FOUND' } })
    expect(store.latest('good')?.close).toBe('250.0000')
  })

  it('refuses instruments no provider covers, rather than reporting them as fetched', async () => {
    const bond = instrument({ id: 'bond', assetClass: 'bond' })
    const service = new PriceService({
      store: new InMemoryPriceStore(),
      instruments: instrumentMap(bond),
      now: () => NOW,
    })
    service.register(fakeProvider(new Map()))
    const report = await service.refresh({}, new AbortController().signal)
    expect(report.failures).toEqual([{ instrumentId: 'bond', error: { code: 'NOT_SUPPORTED' } }])
  })
})

describe('credit budget', () => {
  it('survives a restart and refuses until the IST date rolls over', async () => {
    const fund = instrument({ id: 'fund', assetClass: 'mutual_fund' })
    const instruments = instrumentMap(fund)
    const budgetStore = new InMemoryBudgetStore()
    const budget = new CreditBudget(budgetStore, 800)
    budget.consume(800, '2026-08-12')

    // A fresh service over the same persistent store — the restart.
    const service = new PriceService({
      store: new InMemoryPriceStore(),
      instruments,
      now: () => NOW,
      budget: new CreditBudget(budgetStore, 800),
    })
    service.register(fakeProvider(new Map([['fund', '100.0000']])))
    const report = await service.refresh({}, new AbortController().signal)
    expect(report.rateLimited).toBe(true)
    expect(report.updated).toBe(0)
    expect(report.failures[0]!.error.code).toBe('RATE_LIMITED')

    // Tomorrow, the counter starts again.
    expect(new CreditBudget(budgetStore, 800).remaining('2026-08-13')).toBe(800)
  })
})

describe('staleness', () => {
  const cases: [string, IsoDate, 'fresh' | 'stale' | 'very_stale'][] = [
    ['same day', '2026-08-12', 'fresh'],
    ['two business days', '2026-08-10', 'fresh'],
    ['a week of business days', '2026-07-30', 'very_stale'],
  ]
  for (const [label, asOf, expected] of cases) {
    it(`calls a fund NAV from ${label} ${expected}`, () => {
      const { age } = priceAge({
        point: point('fund', '100.0000', asOf, 'amfi'),
        assetClass: 'mutual_fund',
        valuationDate: '2026-08-12',
      })
      expect(age.staleness).toBe(expected)
    })
  }

  it('still produces a value for a very stale price, flagged rather than blanked', () => {
    const { age, warnings } = priceAge({
      point: point('fund', '100.0000', '2026-06-01', 'amfi'),
      assetClass: 'mutual_fund',
      valuationDate: '2026-08-12',
    })
    expect(age.staleness).toBe('very_stale')
    expect(age.ageDays).toBe(72)
    expect(warnings.map((w) => w.code)).toContain('PRICE_VERY_STALE')
  })

  it('warns when the trading calendar does not cover the year instead of mislabelling a holiday', () => {
    const { warnings } = priceAge({
      point: point('inst', '100.00', '2026-08-10', 'amfi'),
      assetClass: 'indian_equity',
      valuationDate: '2026-08-12',
      calendar: { holidays: new Set(['2025-10-20']), years: new Set([2025]) },
    })
    expect(warnings.map((w) => w.code)).toContain('TRADING_CALENDAR_STALE')
  })
})

describe('twelve data', () => {
  const nse = instrument({
    id: 'infy',
    assetClass: 'indian_equity',
    aliases: [{ scheme: 'nse', value: 'INFY', providerId: null }],
  })
  const us = instrument({
    id: 'aapl',
    assetClass: 'us_equity',
    currency: 'USD',
    aliases: [{ scheme: 'ticker', value: 'AAPL', providerId: null }],
  })

  it('builds symbols from aliases, never from the display name', () => {
    expect(symbolFor(nse)).toBe('INFY:NSE')
    expect(symbolFor(us)).toBe('AAPL')
    expect(symbolFor(instrument({ assetClass: 'indian_equity' }))).toBeNull()
  })

  it('refuses Indian equities on a Basic key before spending a credit', async () => {
    const provider = new TwelveDataProvider({
      apiKey: 'k',
      plan: 'basic',
      fetcher: () => Promise.reject(new Error('should not be called')),
    })
    const [quote] = await provider.fetchLatest([nse], new AbortController().signal)
    if (quote === undefined || quote.ok) throw new Error('expected a refusal')
    expect(quote.error.code).toBe('PLAN_RESTRICTED')
  })

  it('reads per-symbol errors out of a 200 body', () => {
    const entries = parseQuoteBody(
      JSON.stringify({
        AAPL: { symbol: 'AAPL', close: '223.45', previous_close: '220.10', datetime: '2026-08-11' },
        'INFY:NSE': { code: 403, message: 'plan does not include this exchange', status: 'error' },
      }),
    )
    if (entries === null) throw new Error('expected entries')
    expect(entries.get('AAPL')?.close).toBe('223.45')
    expect(entries.get('INFY:NSE')?.status).toBe('error')
  })

  it('commits the successes in a mixed batch', async () => {
    const provider = new TwelveDataProvider({
      apiKey: 'k',
      plan: 'paid',
      fetcher: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({
            AAPL: { symbol: 'AAPL', close: '223.45', previous_close: '220.10', datetime: '2026-08-11' },
            'INFY:NSE': { code: 404, message: 'not found', status: 'error' },
          }),
        }),
    })
    const quotes = await provider.fetchLatest([us, nse], new AbortController().signal)
    const [appleQuote, infyQuote] = quotes
    if (appleQuote === undefined || !appleQuote.ok) throw new Error('expected AAPL to succeed')
    expect(appleQuote.price.value).toBe('223.45')
    expect(appleQuote.previousClose?.value).toBe('220.10')
    if (infyQuote === undefined || infyQuote.ok) throw new Error('expected INFY to fail')
    expect(infyQuote.error.code).toBe('NOT_FOUND')
  })
})
