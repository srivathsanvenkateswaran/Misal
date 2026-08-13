/**
 * Orchestrator tests.
 *
 * Two things are asserted over and over here, because they are the two that matter: what reached
 * the database, and what the user is told. A refresh that returns a cheerful report while writing
 * a wrong price, or that writes correctly while saying nothing about the forty instruments it
 * could not price, has failed in the way this product cares about.
 *
 * No test opens a socket. The market-data fetcher and the Tauri invoker are both injected, and
 * `tests/setup.ts` installs a guard that fails anything that tries.
 */

import { describe, expect, it } from 'vitest'
import type { PortfolioRows } from './client'
import type { Invoker } from './import'
import {
  RecordingPriceStore,
  buildProviders,
  describeProviderError,
  foreignCurrencies,
  neededFxDates,
  refreshPrices,
  ttlGate,
} from './refresh'
import { buildInstruments } from './portfolio'

const NOW = '2026-08-13T09:00:00.000+05:30'

const INFY_NS = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'INFY.NS',
          regularMarketTime: 1786594942,
          exchangeTimezoneName: 'Asia/Kolkata',
          regularMarketPrice: 1163.6,
          chartPreviousClose: 1175.1,
        },
      },
    ],
    error: null,
  },
})

const AAPL = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'AAPL',
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

const USD_INR = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'USDINR=X',
          regularMarketTime: 1786595064,
          exchangeTimezoneName: 'Europe/London',
          regularMarketPrice: 95.3575,
        },
      },
    ],
    error: null,
  },
})

/**
 * INFY with the trading period Yahoo really sends, mid-session.
 *
 * `currentTradingPeriod.regular` is 09:15–15:30 IST on 2026-08-13 and `regularMarketTime` is
 * 14:03 IST, so at `MID_SESSION` this is a live quote rather than that day's close.
 */
const INFY_OPEN = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'INFY.NS',
          regularMarketTime: 1786609994,
          exchangeTimezoneName: 'Asia/Kolkata',
          regularMarketPrice: 1170.4,
          chartPreviousClose: 1176.1,
          currentTradingPeriod: {
            regular: { timezone: 'IST', start: 1786592700, end: 1786615200, gmtoffset: 19800 },
          },
        },
      },
    ],
    error: null,
  },
})

const MID_SESSION = '2026-08-13T14:05:00+05:30'

/**
 * USD/INR across 11–14 June 2019, as the chart endpoint serves it.
 *
 * Bars are stamped at midnight UTC under Yahoo's `Europe/London` currency pseudo-exchange, and the
 * closes carry the float32 rounding every candle array does.
 */
const USD_INR_2019 = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'USDINR=X',
          exchangeName: 'CCY',
          exchangeTimezoneName: 'Europe/London',
        },
        timestamp: [1560211200, 1560297600, 1560384000, 1560470400],
        indicators: { quote: [{ close: [69.5, 69.62000274658203, 69.75, 69.80000305175781] }] },
      },
    ],
    error: null,
  },
})

/** USD/INR across 12–15 March 2024, in the same shape as the 2019 span above. */
const USD_INR_2024 = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: 'INR',
          symbol: 'USDINR=X',
          exchangeName: 'CCY',
          exchangeTimezoneName: 'Europe/London',
        },
        timestamp: [1710201600, 1710288000, 1710374400, 1710460800],
        indicators: { quote: [{ close: [82.8, 82.91, 82.97, 83.05] }] },
      },
    ],
    error: null,
  },
})

const BTC = JSON.stringify({ bitcoin: { inr: 6061005.018552231, last_updated_at: 1786594890 } })

/** A transaction as a sync writes one, with only the fields a test varies spelled out. */
function txn(over: Partial<PortfolioRows['transactions'][number]>): PortfolioRows['transactions'][number] {
  return {
    id: 't-1',
    accountId: 'a-kite',
    instrumentId: 'i-aapl',
    type: 'buy',
    occurredAt: '2024-03-15T09:30:00-04:00',
    occurredTz: null,
    quantity: '10.0000',
    price: '190.0000',
    amountMinor: '190000',
    brokerageMinor: '0',
    sttMinor: '0',
    gstMinor: '0',
    stampDutyMinor: '0',
    otherFeesMinor: '0',
    tdsMinor: '0',
    currency: 'USD',
    // No per-row rate, so the daily table is the only place a rate can come from.
    fxRate: null,
    sourceDocumentId: 'd-1',
    naturalKey: 'nk-1',
    occurrence: 0,
    authority: 'primary',
    createdAt: NOW,
    ...over,
  }
}

function rows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return {
    accounts: [
      {
        id: 'a-kite',
        providerId: 'zerodha-kite',
        label: 'Kite',
        externalRef: null,
        identityKey: null,
        capability: 'ledger',
        baseCurrency: 'INR',
        createdAt: NOW,
        providerShortCode: 'KIT',
      },
    ],
    instruments: [
      {
        id: 'i-infy',
        assetClass: 'indian_equity',
        taxRegime: 's112a_listed_equity',
        displayName: 'Infosys',
        isin: 'INE009A01021',
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-aapl',
        assetClass: 'us_equity',
        taxRegime: 'foreign_equity',
        displayName: 'Apple',
        isin: null,
        currency: 'USD',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-btc',
        assetClass: 'crypto',
        taxRegime: 's115bbh_vda',
        displayName: 'Bitcoin',
        isin: null,
        currency: 'INR',
        precision: 8,
        fmv31Jan2018: null,
      },
      {
        // No ISIN and no alias, so no provider can name it. The instrument that proves the
        // "no price source" note reaches the user rather than being counted as a silent failure.
        id: 'i-bond',
        assetClass: 'bond',
        taxRegime: 'other_asset',
        displayName: 'SGB 2031',
        isin: null,
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
    ],
    aliases: [
      { instrumentId: 'i-infy', scheme: 'nse', value: 'INFY', providerId: null },
      { instrumentId: 'i-aapl', scheme: 'ticker', value: 'AAPL', providerId: null },
      { instrumentId: 'i-btc', scheme: 'coingecko', value: 'bitcoin', providerId: null },
    ],
    transactions: [],
    positions: [],
    prices: [],
    fxRates: [],
    unresolved: [],
    settings: new Map([
      ['base_currency', 'INR'],
      ['price_cache_ttl_minutes', '360'],
    ]),
    ...over,
  }
}

interface Recorded {
  readonly command: string
  readonly args: Record<string, unknown> | undefined
}

/** A fake bridge that records every command, so "it never wrote" is assertable. */
function harness(routes: readonly { match: RegExp; status: number; body: string }[]) {
  const commands: Recorded[] = []
  const urls: string[] = []
  const call: Invoker = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    commands.push({ command, args })
    if (command === 'save_prices' || command === 'save_fx_rates') {
      const rowCount = (args?.rows as unknown[] | undefined)?.length ?? 0
      return Promise.resolve({ written: rowCount, heldByManual: [], unknown: [] } as T)
    }
    return Promise.resolve(undefined as T)
  }
  const fetcher = (url: string): Promise<{ status: number; body: string }> => {
    urls.push(url)
    const route = routes.find((r) => r.match.test(url))
    if (route === undefined) return Promise.reject(new Error(`no fixture for ${url}`))
    return Promise.resolve({ status: route.status, body: route.body })
  }
  const saved = (command: string): Record<string, unknown>[] =>
    (commands.find((c) => c.command === command)?.args?.rows as
      | Record<string, unknown>[]
      | undefined) ?? []
  return { call, fetcher, commands, urls, saved }
}

const ALL_GOOD = [
  { match: /INFY\.NS/, status: 200, body: INFY_NS },
  { match: /chart\/AAPL/, status: 200, body: AAPL },
  { match: /USDINR/, status: 200, body: USD_INR },
  { match: /simple\/price/, status: 200, body: BTC },
]

describe('the TTL gate', () => {
  it('lets a first refresh through', () => {
    expect(ttlGate(rows().settings, NOW).eligible).toBe(true)
  })

  it('holds a second refresh inside the window and says when it will be due', () => {
    // What stops a user clicking Refresh six times from making six rounds of provider calls.
    const settings = new Map([
      ['price_cache_ttl_minutes', '360'],
      ['last_price_refresh_at', '2026-08-13T08:00:00.000+05:30'],
    ])
    const gate = ttlGate(settings, NOW)
    expect(gate.eligible).toBe(false)
    expect(gate.nextEligibleAt).toContain('2026-08-13T14:00')
  })

  it('lets it through once the window has passed', () => {
    const settings = new Map([
      ['price_cache_ttl_minutes', '60'],
      ['last_price_refresh_at', '2026-08-13T07:00:00.000+05:30'],
    ])
    expect(ttlGate(settings, NOW).eligible).toBe(true)
  })

  it('falls back to the seeded default when the setting is missing or nonsense', () => {
    const base = [['last_price_refresh_at', '2026-08-13T08:59:00.000+05:30']] as [string, string][]
    expect(ttlGate(new Map(base), NOW).eligible).toBe(false)
    expect(ttlGate(new Map([...base, ['price_cache_ttl_minutes', 'soon']]), NOW).eligible).toBe(
      false,
    )
  })

  it('skips the whole refresh without touching the network', async () => {
    const { call, fetcher, urls, commands } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows({
        settings: new Map([
          ['base_currency', 'INR'],
          ['price_cache_ttl_minutes', '360'],
          ['last_price_refresh_at', '2026-08-13T08:59:00.000+05:30'],
        ]),
      }),
      call,
      fetcher,
      now: () => NOW,
    })
    expect(outcome.status).toBe('skipped_by_ttl')
    expect(urls).toHaveLength(0)
    expect(commands).toHaveLength(0)
    expect(outcome.nextEligibleAt).not.toBeNull()
  })

  it('runs anyway when the user asks explicitly', async () => {
    const { call, fetcher, urls } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows({
        settings: new Map([
          ['base_currency', 'INR'],
          ['price_cache_ttl_minutes', '360'],
          ['last_price_refresh_at', '2026-08-13T08:59:00.000+05:30'],
        ]),
      }),
      call,
      fetcher,
      now: () => NOW,
      force: true,
    })
    expect(outcome.status).toBe('ran')
    expect(urls.length).toBeGreaterThan(0)
  })
})

describe('routing', () => {
  it('sends each instrument to the provider that actually covers it', async () => {
    const { call, fetcher, urls } = harness(ALL_GOOD)
    await refreshPrices({ rows: rows(), call, fetcher, now: () => NOW, sleep: () => Promise.resolve() })
    expect(urls.some((u) => u.includes('chart/INFY.NS'))).toBe(true)
    expect(urls.some((u) => u.includes('chart/AAPL'))).toBe(true)
    expect(urls.some((u) => u.includes('simple/price') && u.includes('bitcoin'))).toBe(true)
    // The bond has no alias, so nothing was asked about it. AMFI's whole-book file was never
    // fetched either, because no instrument here is a fund it could recognise.
    expect(urls.some((u) => u.includes('amfi'))).toBe(false)
  })

  it('registers AMFI, CoinGecko and Yahoo without a key, and Twelve Data only with one', () => {
    const { fetcher } = harness([])
    expect(buildProviders(fetcher, null).providers.map((p) => p.id)).toEqual([
      'amfi',
      'coingecko',
      'yahoo',
    ])
    expect(
      buildProviders(fetcher, { apiKey: 'k', plan: 'basic' }).providers.map((p) => p.id),
    ).toEqual(['amfi', 'coingecko', 'yahoo', 'twelvedata'])
  })

  it('serves FX from the keyless provider, so rates work before any credential is entered', () => {
    const { fetcher } = harness([])
    expect(buildProviders(fetcher, null).fx?.id).toBe('yahoo')
  })
})

describe('what gets written', () => {
  it('persists exactly the prices that came back, with their provider named', async () => {
    const { call, fetcher, saved } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    const written = saved('save_prices')
    expect(written).toHaveLength(3)
    expect(written).toContainEqual({
      instrumentId: 'i-infy',
      asOf: '2026-08-13',
      close: '1163.6',
      currency: 'INR',
      source: 'yahoo',
      fetchedAt: NOW,
    })
    expect(written).toContainEqual({
      instrumentId: 'i-btc',
      asOf: '2026-08-13',
      close: '6061005.018552231',
      currency: 'INR',
      source: 'coingecko',
      fetchedAt: NOW,
    })
    // Apple's close is dated by New York, not by the machine's clock in Mumbai.
    expect(written.find((r) => r.instrumentId === 'i-aapl')?.asOf).toBe('2026-08-12')
    expect(outcome.pricesWritten).toBe(3)
  })

  it('writes an exchange rate for every foreign currency held', async () => {
    const { call, fetcher, saved } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    expect(saved('save_fx_rates')).toEqual([
      { base: 'USD', quote: 'INR', asOf: '2026-08-13', rate: '95.3575', source: 'yahoo' },
    ])
    expect(outcome.fxWritten).toBe(1)
  })

  it('does not file a live quote as the day’s close, and says why nothing was written', async () => {
    /*
     * The defect: a refresh at 11:00 IST took `meta.regularMarketPrice` — a live quote during an
     * open session — and wrote it dated today, into a table whose one row per day *is* the close.
     * A user who refreshed once mid-morning and never again left an 11:00 print on record as that
     * day's closing price for good, and every historical figure computed against it read it as
     * one. Nothing later could tell it from a real close in order to replace it.
     */
    const { call, fetcher, saved, commands } = harness([
      { match: /INFY\.NS/, status: 200, body: INFY_OPEN },
      { match: /chart\/AAPL/, status: 200, body: AAPL },
      { match: /USDINR/, status: 200, body: USD_INR },
      { match: /simple\/price/, status: 200, body: BTC },
    ])
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => MID_SESSION,
      sleep: () => Promise.resolve(),
    })

    expect(saved('save_prices').map((row) => row.instrumentId)).not.toContain('i-infy')
    // The rest of the batch is unaffected: Apple's session in New York is long closed.
    expect(saved('save_prices').map((row) => row.instrumentId)).toContain('i-aapl')
    expect(outcome.prices?.intradayHeld).toEqual(['i-infy'])

    const note = outcome.notes.find((n) => n.code === 'INTRADAY_QUOTE')
    expect(note?.subjects).toEqual(['Infosys'])
    expect(note?.message).toContain('still open')
    // Not reported as a failure: the fetch worked and the number is real. It is simply not a
    // close, and a close is the only thing this table can hold.
    expect(outcome.prices?.failures.some((f) => f.instrumentId === 'i-infy')).toBe(false)
    expect(commands.some((c) => c.command === 'record_price_refresh')).toBe(true)
  })

  it('stamps the refresh even when everything failed, so the TTL still protects the provider', async () => {
    const { call, fetcher, commands } = harness([{ match: /.*/, status: 429, body: '' }])
    await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    expect(commands.some((c) => c.command === 'record_price_refresh')).toBe(true)
  })

  it('fetches the historical rates old foreign transactions need, and only those days', async () => {
    /*
     * The defect: the refresh asked for `'latest'` and nothing else. `FxTable.on` reaches back
     * three days, so a 2019 RSU vest could never be dated — `buildCashflows` returned MISSING_FX,
     * and because XIRR is solved over a whole scope at once, that one row withheld the figure for
     * every rupee holding beside it, permanently, with nothing the user could do about it.
     */
    const withVest = rows({
      transactions: [
        {
          id: 't-vest-2019',
          accountId: 'a-kite',
          instrumentId: 'i-aapl',
          type: 'buy',
          occurredAt: '2019-06-14T09:30:00-04:00',
          occurredTz: 'America/New_York',
          quantity: '10.0000',
          price: '190.0000',
          amountMinor: '190000',
          brokerageMinor: '0',
          sttMinor: '0',
          gstMinor: '0',
          stampDutyMinor: '0',
          otherFeesMinor: '0',
          tdsMinor: '0',
          currency: 'USD',
          // No per-row rate, so the daily table is the only place the rate can come from.
          fxRate: null,
          sourceDocumentId: 'd-etr-1',
          naturalKey: 'etrade:aapl:2019-06-14',
          occurrence: 0,
          authority: 'primary',
          createdAt: NOW,
        },
      ],
    })
    // The history route is listed first: `replay` takes the first match, and the `latest` route's
    // pattern would otherwise swallow the dated request.
    const { call, fetcher, urls, commands } = harness([
      { match: /USDINR=X\?period1/, status: 200, body: USD_INR_2019 },
      ...ALL_GOOD,
    ])
    await refreshPrices({
      rows: withVest,
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })

    const history = urls.filter((url) => url.includes('USDINR=X?period1'))
    expect(history).toHaveLength(1)
    // Opened three days early so a vest that fell on a weekend can still be answered by the last
    // published rate before it — the same window `FxTable.on` reads back with.
    expect(history[0]).toContain('period1=1560211200')

    const fxRows = commands
      .filter((c) => c.command === 'save_fx_rates')
      .flatMap((c) => (c.args?.rows as Record<string, unknown>[] | undefined) ?? [])
    // Exactly one historical row: the rate published on the day of the vest. The other three bars
    // in the span came back in the same response and were not asked for, so they are not stored.
    expect(fxRows).toContainEqual({
      base: 'USD',
      quote: 'INR',
      asOf: '2019-06-14',
      rate: '69.80000305175781',
      source: 'yahoo',
    })
    expect(fxRows.filter((row) => (row.asOf as string).startsWith('2019'))).toHaveLength(1)
  })

  it('asks for no history when the stored table already dates every transaction', async () => {
    const dated = rows({
      transactions: [
        {
          id: 't-vest-2019',
          accountId: 'a-kite',
          instrumentId: 'i-aapl',
          type: 'buy',
          occurredAt: '2019-06-14T09:30:00-04:00',
          occurredTz: 'America/New_York',
          quantity: '10.0000',
          price: '190.0000',
          amountMinor: '190000',
          brokerageMinor: '0',
          sttMinor: '0',
          gstMinor: '0',
          stampDutyMinor: '0',
          otherFeesMinor: '0',
          tdsMinor: '0',
          currency: 'USD',
          fxRate: null,
          sourceDocumentId: 'd-etr-1',
          naturalKey: 'etrade:aapl:2019-06-14',
          occurrence: 0,
          authority: 'primary',
          createdAt: NOW,
        },
      ],
      fxRates: [
        { base: 'USD', quote: 'INR', asOf: '2019-06-14', rate: '69.80', source: 'yahoo' },
      ],
    })
    const { call, fetcher, urls } = harness(ALL_GOOD)
    await refreshPrices({ rows: dated, call, fetcher, now: () => NOW, sleep: () => Promise.resolve() })
    expect(urls.some((url) => url.includes('period1'))).toBe(false)
  })

  it('asks for no rate against a crypto quote currency, and does not spend a slot on one', async () => {
    /*
     * The defect: `neededFxDates` cast every transaction's currency to a `CurrencyCode`. Exchange
     * fills are stored in the `X:` namespace migration 0002 reserves — a Binance `BTCUSDT` fill is
     * `X:USDT` — and under the cast they passed both guards, found no bucket in `FxTable.on`, and
     * piled every fill date under an `X:USDT` key. `fxSymbolFor` turns that into `X:USDTINR=X`,
     * which Yahoo's symbol pattern rejects locally, so no request left the machine — but the slot
     * was counted before the call, so each cluster still spent one of the eight per-refresh
     * backfill slots, and since nothing was stored the same dates were re-derived every refresh.
     *
     * `list_transactions` orders by `occurred_at`, so a user whose earliest transaction is a
     * crypto fill had the twelve impossible clusters consume the budget before the real USD range
     * was ever reached — the exact failure `backfillFxHistory` was written to fix, with the note
     * advising an exchange or ticker alias for a pair that cannot exist.
     */
    const cryptoFirst = rows({
      transactions: [
        // Twelve fills across 2021-2023, each more than the 60-day clustering gap from the last,
        // so they would have become twelve separate range requests. Listed first, because that is
        // the order the database hands them back in.
        ...[
          '2021-02-05',
          '2021-05-04',
          '2021-08-03',
          '2021-11-02',
          '2022-02-01',
          '2022-05-03',
          '2022-08-02',
          '2022-11-01',
          '2023-01-31',
          '2023-05-02',
          '2023-08-01',
          '2023-10-31',
        ].map((date, index) =>
          txn({
            id: `t-fill-${String(index)}`,
            instrumentId: 'i-btc',
            occurredAt: `${date}T08:00:00.000Z`,
            currency: 'X:USDT',
            amountMinor: null,
            naturalKey: `binance:btcusdt:${date}`,
          }),
        ),
        txn({
          id: 't-vest-2024',
          instrumentId: 'i-aapl',
          occurredAt: '2024-03-15T09:30:00-04:00',
          occurredTz: 'America/New_York',
          currency: 'USD',
          amountMinor: '190000',
          naturalKey: 'etrade:aapl:2024-03-15',
        }),
      ],
    })

    // Nothing in the map is quoted in anything a rate could exist for but INR's counterparties.
    expect([...neededFxDates(cryptoFirst, 'INR').keys()]).toEqual(['USD'])

    const { call, fetcher, urls, commands } = harness([
      { match: /USDINR=X\?period1/, status: 200, body: USD_INR_2024 },
      ...ALL_GOOD,
    ])
    const outcome = await refreshPrices({
      rows: cryptoFirst,
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })

    // The genuine backfill is reached and answered, rather than starved behind twelve pairs that
    // cannot exist. Opened three days early, as `FxTable.on` reads back.
    const history = urls.filter((url) => url.includes('USDINR=X?period1'))
    expect(history).toHaveLength(1)
    expect(history[0]).toContain('period1=1710201600')
    const fxRows = commands
      .filter((c) => c.command === 'save_fx_rates')
      .flatMap((c) => (c.args?.rows as Record<string, unknown>[] | undefined) ?? [])
    expect(fxRows).toContainEqual({
      base: 'USD',
      quote: 'INR',
      asOf: '2024-03-15',
      rate: '83.05',
      source: 'yahoo',
    })

    // Nothing is said about a pair that cannot exist, and nothing is left outstanding. The old
    // advice — add an exchange or ticker alias — was unactionable for `X:USDT/INR`.
    const subjects = outcome.notes.flatMap((note) => note.subjects)
    expect(subjects.filter((subject) => subject.includes('X:USDT'))).toEqual([])
    expect(outcome.notes.some((note) => note.code === 'FX_HISTORY_INCOMPLETE')).toBe(false)
  })

  it('does not ask for FX at all when nothing foreign is held', async () => {
    const inrOnly = rows({
      instruments: rows().instruments.filter((i) => i.currency === 'INR'),
    })
    const { call, fetcher, urls, commands } = harness(ALL_GOOD)
    await refreshPrices({ rows: inrOnly, call, fetcher, now: () => NOW, sleep: () => Promise.resolve() })
    expect(urls.some((u) => u.includes('USDINR'))).toBe(false)
    expect(commands.some((c) => c.command === 'save_fx_rates')).toBe(false)
  })
})

describe('a failed fetch never writes a price', () => {
  it('writes nothing at all when every provider fails', async () => {
    const { call, fetcher, commands } = harness([{ match: /.*/, status: 500, body: 'nope' }])
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    expect(commands.some((c) => c.command === 'save_prices')).toBe(false)
    expect(outcome.pricesWritten).toBe(0)
    expect(outcome.prices?.updated).toBe(0)
  })

  it('keeps the good prices when one provider fails', async () => {
    // Partial success is the normal outcome, exactly as it is for an import.
    const { call, fetcher, saved } = harness([
      { match: /INFY\.NS/, status: 200, body: INFY_NS },
      { match: /chart\/AAPL/, status: 500, body: '' },
      { match: /USDINR/, status: 200, body: USD_INR },
      { match: /simple\/price/, status: 200, body: BTC },
    ])
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    const written = saved('save_prices').map((r) => r.instrumentId)
    expect(written).toContain('i-infy')
    expect(written).toContain('i-btc')
    expect(written).not.toContain('i-aapl')
    expect(outcome.prices?.failed).toBeGreaterThan(0)
  })

  it('leaves a stale stored price alone rather than replacing it with a failure', async () => {
    const stored = rows({
      prices: [
        {
          instrumentId: 'i-infy',
          asOf: '2026-08-01',
          close: '1400.00',
          currency: 'INR',
          source: 'yahoo',
          fetchedAt: '2026-08-01T16:00:00+05:30',
        },
      ],
    })
    const { call, fetcher, commands } = harness([{ match: /.*/, status: 503, body: '' }])
    await refreshPrices({ rows: stored, call, fetcher, now: () => NOW, sleep: () => Promise.resolve() })
    expect(commands.some((c) => c.command === 'save_prices')).toBe(false)
  })
})

describe('what the user is told', () => {
  it('reports a rate limit once, for everything it affected, and does not retry', async () => {
    const { call, fetcher, urls } = harness([{ match: /.*/, status: 429, body: '' }])
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    expect(outcome.rateLimited).toBe(true)
    const limited = outcome.notes.filter((n) => n.code === 'RATE_LIMITED')
    // One note for the prices, naming every instrument it cost, and one for FX, which is a
    // separate consequence worth its own sentence. Never one note per instrument.
    expect(limited).toHaveLength(2)
    expect(limited[0]?.subjects).toEqual(['Infosys', 'Apple', 'Bitcoin'])
    expect(limited[0]?.message).toContain('rather than retrying')
    expect(limited[1]?.subjects).toEqual(['USD/INR'])
    // One Yahoo request, one CoinGecko request, one FX request. Nothing was tried twice.
    expect(urls).toHaveLength(3)
  })

  it('names the instruments no provider can price, so a permanent gap is visible', async () => {
    const { call, fetcher } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    const note = outcome.notes.find((n) => n.code === 'NO_PRICE_SOURCE')
    expect(note?.subjects).toEqual(['SGB 2031'])
    expect(note?.message).toContain('manual price')
  })

  it('says when a manual override held, rather than reporting the day as unchanged', async () => {
    const { fetcher } = harness(ALL_GOOD)
    const call: Invoker = <T,>(command: string): Promise<T> => {
      if (command === 'save_prices') {
        return Promise.resolve({
          written: 2,
          heldByManual: ['i-infy 2026-08-13'],
          unknown: [],
        } as T)
      }
      if (command === 'save_fx_rates') {
        return Promise.resolve({ written: 1, heldByManual: [], unknown: [] } as T)
      }
      return Promise.resolve(undefined as T)
    }
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    const note = outcome.notes.find((n) => n.code === 'MANUAL_OVERRIDE_HELD')
    expect(note?.subjects).toEqual(['i-infy 2026-08-13'])
    expect(note?.message).toContain('never overwrites')
  })

  it('says a foreign holding is out of net worth entirely when its rate could not be fetched', async () => {
    // Not merely unpriced: the engine refuses to convert without a rate, so the holding is absent
    // from every total. Silent absence is the failure this note exists to prevent.
    const { call, fetcher } = harness([
      { match: /INFY\.NS/, status: 200, body: INFY_NS },
      { match: /chart\/AAPL/, status: 200, body: AAPL },
      { match: /USDINR/, status: 500, body: '' },
      { match: /simple\/price/, status: 200, body: BTC },
    ])
    const outcome = await refreshPrices({
      rows: rows(),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    expect(outcome.fx[0]?.ok).toBe(false)
    expect(outcome.notes.some((n) => n.message.includes('stay out of net worth'))).toBe(true)
  })

  it('refuses to fetch rates against a base currency other than INR', async () => {
    const { call, fetcher, urls } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: rows({
        settings: new Map([
          ['base_currency', 'USD'],
          ['price_cache_ttl_minutes', '360'],
        ]),
      }),
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })
    // The direction convention in fx.ts is fixed at quote = INR. Storing a rate the other way
    // round turns a ₹50 lakh holding into ₹6,500, so it is refused and named instead.
    expect(urls.some((u) => u.includes('=X'))).toBe(false)
    expect(outcome.notes.some((n) => n.code === 'FX_BASE_UNSUPPORTED')).toBe(true)
  })

  /**
   * Two defects in one note, both of them silences.
   *
   * `foreignCurrencies` is computed against the *configured* base, so a portfolio held entirely in
   * the misconfigured currency had no foreign currency at all and the function returned before the
   * note was ever pushed: the user whose whole portfolio was frozen was the only one told nothing.
   *
   * And the note claimed those holdings "will stay out of net worth", which is the opposite of what
   * happens. They stay in, converted at whatever rate was stored on the day the setting changed,
   * while prices carry on refreshing daily.
   */
  it('warns even when every holding is in the misconfigured currency, and says the rate freezes rather than that the holdings leave', async () => {
    const usdOnly = rows({
      accounts: [
        {
          id: 'a-etrade',
          providerId: 'etrade',
          label: 'E*TRADE',
          externalRef: null,
          identityKey: null,
          capability: 'ledger',
          baseCurrency: 'USD',
          createdAt: NOW,
          providerShortCode: 'ETR',
        },
      ],
      instruments: [
        {
          id: 'i-aapl',
          assetClass: 'us_equity',
          taxRegime: 'foreign_equity',
          displayName: 'Apple',
          isin: null,
          currency: 'USD',
          precision: 4,
          fmv31Jan2018: null,
        },
      ],
      aliases: [{ instrumentId: 'i-aapl', scheme: 'ticker', value: 'AAPL', providerId: null }],
      settings: new Map([
        ['base_currency', 'USD'],
        ['price_cache_ttl_minutes', '360'],
      ]),
    })
    // Nothing here is foreign *relative to USD*, which is exactly the case that used to be silent.
    expect(foreignCurrencies(buildInstruments(usdOnly, usdOnly.aliases), usdOnly, 'USD')).toEqual([])

    const { call, fetcher, urls } = harness(ALL_GOOD)
    const outcome = await refreshPrices({
      rows: usdOnly,
      call,
      fetcher,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    })

    const note = outcome.notes.find((n) => n.code === 'FX_BASE_UNSUPPORTED')
    expect(note).toBeDefined()
    // Named against INR, because that is the rate that has stopped being written.
    expect(note?.subjects).toEqual(['USD'])
    expect(note?.message).not.toContain('stay out of net worth')
    expect(note?.message).toContain('frozen')
    expect(urls.some((u) => u.includes('=X'))).toBe(false)
  })

  it('has a sentence for every provider failure the type system allows', () => {
    const errors = [
      { code: 'NOT_SUPPORTED' },
      { code: 'NOT_FOUND' },
      { code: 'PLAN_RESTRICTED', detail: 'Grow+ required' },
      { code: 'RATE_LIMITED', retryAfterMs: 1000 },
      { code: 'AUTH_FAILED' },
      { code: 'OFFLINE' },
      { code: 'MALFORMED_RESPONSE', detail: 'no price' },
      { code: 'UPSTREAM', status: 502 },
    ] as const
    for (const error of errors) {
      expect(describeProviderError(error).message.length).toBeGreaterThan(10)
    }
  })
})

describe('the recording store', () => {
  it('records only what it accepted, never what a manual override refused', () => {
    const store = new RecordingPriceStore()
    store.seed({
      instrumentId: 'i1',
      asOf: '2026-08-13',
      close: '100.00' as never,
      currency: 'INR',
      source: 'manual',
      fetchedAt: NOW,
    })
    const refused = store.put({
      instrumentId: 'i1',
      asOf: '2026-08-13',
      close: '110.00' as never,
      currency: 'INR',
      source: 'yahoo',
      fetchedAt: NOW,
    })
    expect(refused).toBe(false)
    expect(store.accepted).toHaveLength(0)
    expect(store.latest('i1')?.close).toBe('100.00')
  })

  it('records a re-fetch that confirms an existing price, so fetched_at moves forward', () => {
    // "Unchanged" still deserves a write: it is what tells the user their stale-looking number
    // was checked five minutes ago rather than left alone.
    const store = new RecordingPriceStore()
    store.seed({
      instrumentId: 'i1',
      asOf: '2026-08-13',
      close: '100.00' as never,
      currency: 'INR',
      source: 'yahoo',
      fetchedAt: '2026-08-13T06:00:00+05:30',
    })
    store.put({
      instrumentId: 'i1',
      asOf: '2026-08-13',
      close: '100.00' as never,
      currency: 'INR',
      source: 'yahoo',
      fetchedAt: NOW,
    })
    expect(store.accepted).toHaveLength(1)
  })
})

describe('which rates are needed', () => {
  it('is every currency held other than the base', () => {
    const instruments = buildInstruments(rows(), rows().aliases)
    expect(foreignCurrencies(instruments, rows(), 'INR')).toEqual(['USD'])
  })

  it('includes an account whose base currency is foreign even with nothing held in it', () => {
    const inrOnly = rows({
      instruments: rows().instruments.filter((i) => i.currency === 'INR'),
      accounts: [{ ...rows().accounts[0]!, baseCurrency: 'USD' }],
    })
    const instruments = buildInstruments(inrOnly, inrOnly.aliases)
    expect(foreignCurrencies(instruments, inrOnly, 'INR')).toEqual(['USD'])
  })
})
