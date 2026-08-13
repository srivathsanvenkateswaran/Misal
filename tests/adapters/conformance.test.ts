/**
 * The adapter conformance suite.
 *
 * One adapter-agnostic set of tests that every exchange must pass, so adding an exchange means
 * writing an adapter and a fixture directory rather than a test plan.
 *
 * The first block is the one a reviewer should read first: it is the machine-checked version of
 * the claim that Misal cannot place a trade or move funds. It runs over every registered adapter,
 * so a new exchange is covered the moment it appears in the registry - there is nothing to
 * remember to add.
 */

import { describe, expect, it } from 'vitest'
import { classifyPath } from '@adapters/allowlist'
import type { AcquiredPage, ExchangeAdapter, MarketSpec, RawFill } from '@adapters/contract'
import { createAdapter, ADAPTER_IDS } from '@adapters/index'
import { decFromRaw } from '@adapters/decimal-text'
import { createBinanceAdapter } from '@adapters/binance/adapter'
import { createCoindcxAdapter } from '@adapters/coindcx/adapter'
import { RateLimiter } from '@adapters/ratelimit'
import { runSync } from '@adapters/sync/runner'
import { ManualClock, createHarness, withAssets } from '@adapters/testing/harness'
import { MemorySyncStore } from '@adapters/testing/memory-store'
import { createReplayTransport, loadFixtures } from '@adapters/testing/replay-transport'

const NOW = new Date('2026-08-12T10:00:00.000Z')

/**
 * Pull every integer watermark out of an opaque cursor, whatever shape it has.
 *
 * CoinDCX's is a bare trade id; Binance's is a JSON map of symbol to trade id. Core stores both
 * without interpretation, which is what lets a contributor add an exchange with a different
 * pagination model without touching the runner - so the conformance suite has to be equally
 * agnostic, and checks only the property that matters: nothing moves backwards.
 */
function watermarks(cursor: string): Map<string, bigint> {
  if (/^\d+$/.test(cursor)) return new Map([['*', BigInt(cursor)]])
  const parsed = JSON.parse(cursor) as { symbols?: Record<string, string> }
  return new Map(
    Object.entries(parsed.symbols ?? {}).map(([symbol, id]) => [symbol, BigInt(id)]),
  )
}

interface Case {
  readonly exchange: 'binance' | 'coindcx'
  readonly adapter: ExchangeAdapter
  /** The fixtures a full, successful sync consumes. */
  readonly syncFixtures: readonly string[]
  /** Fixtures whose response bodies must survive numerically intact. */
  readonly numericFixtures: readonly string[]
  readonly fillFixtures: readonly string[]
  readonly balanceFixtures: readonly string[]
  readonly assets: readonly string[]
  readonly markets: readonly MarketSpec[]
}

const CASES: readonly Case[] = [
  {
    exchange: 'binance',
    adapter: createBinanceAdapter({ pageSize: 2, backfillWindows: 1 }),
    syncFixtures: [
      'api-restrictions-read-only',
      'time',
      'exchange-info',
      'user-asset',
      'deposit-hisrec',
      'withdraw-history',
      'convert-tradeflow',
      'mytrades-btctusd-empty',
      'mytrades-btcusdt-page-1',
      'mytrades-btcusdt-page-2',
      // A deposit and a Convert each put a pair into the sweep that balances alone would not have.
      'mytrades-ethbtc-empty',
      'mytrades-wbtcbtc-empty',
    ],
    numericFixtures: ['user-asset', 'mytrades-btcusdt-page-1'],
    fillFixtures: ['mytrades-btctusd-empty', 'mytrades-btcusdt-page-1', 'mytrades-btcusdt-page-2'],
    balanceFixtures: ['user-asset'],
    assets: ['BTC', 'USDT'],
    markets: [
      { symbol: 'BTCUSDT', base: { code: 'BTC' }, quote: { code: 'USDT' }, quantityPrecision: 5 },
      { symbol: 'BTCTUSD', base: { code: 'BTC' }, quote: { code: 'TUSD' }, quantityPrecision: 5 },
    ],
  },
  {
    exchange: 'coindcx',
    adapter: createCoindcxAdapter({ pageSize: 2 }),
    syncFixtures: ['markets-details', 'balances', 'trade-history-page-1', 'trade-history-page-2'],
    numericFixtures: ['balances', 'trade-history-page-1', 'markets-details'],
    fillFixtures: ['trade-history-page-1', 'trade-history-page-2'],
    balanceFixtures: ['balances'],
    assets: ['BTC', 'INR'],
    markets: [
      { symbol: 'BTCINR', base: { code: 'BTC' }, quote: { code: 'INR' }, quantityPrecision: 8 },
    ],
  },
]

// ---------------------------------------------------------------------------
// The security property
// ---------------------------------------------------------------------------

describe('every adapter is structurally read-only', () => {
  const registered = ADAPTER_IDS.map(createAdapter)

  it('covers every registered adapter', () => {
    expect(registered.length).toBe(ADAPTER_IDS.length)
    expect(registered.length).toBeGreaterThan(0)
  })

  it.each(registered.map((r) => [r.adapter.id, r.adapter] as const))(
    '%s declares no mutating request',
    (_id, adapter) => {
      for (const entry of adapter.requestAllowlist) {
        const verdict = classifyPath(entry.pathPattern)
        expect(
          verdict.mutating,
          `${entry.method} ${entry.pathPattern}: ${verdict.reason}`,
        ).toBe(false)
      }
    },
  )

  it.each(registered.map((r) => [r.adapter.id, r.adapter] as const))(
    '%s cannot express an order, transfer or withdrawal',
    (_id, adapter) => {
      const forbidden = [
        '/api/v3/order',
        '/sapi/v1/capital/withdraw/apply',
        '/sapi/v1/asset/transfer',
        '/exchange/v1/orders/create',
        '/exchange/v1/orders/cancel',
        '/exchange/v1/wallets/withdrawals',
      ]
      for (const path of forbidden) {
        for (const method of ['GET', 'POST'] as const) {
          const listed = adapter.requestAllowlist.some(
            (e) => e.method === method && e.pathPattern === path,
          )
          expect(listed, `${adapter.id} lists ${method} ${path}`).toBe(false)
        }
      }
    },
  )

  it.each(registered.map((r) => [r.adapter.id, r.adapter] as const))(
    '%s is a snapshot account, because neither exchange can prove coverage',
    (_id, adapter) => {
      expect(adapter.capability).toBe('snapshot')
      expect(adapter.coverageGaps.length).toBeGreaterThan(0)
    },
  )

  it.each(registered.map((r) => [r.adapter.id, r.adapter] as const))(
    '%s either fetches transfers or states that it cannot',
    (_id, adapter) => {
      if (adapter.fetchTransfers !== undefined) return
      // An absent stream and an account with no deposits look identical in the data. The only
      // thing that can tell them apart is the adapter saying which one it is, so an adapter that
      // leaves the method off owes the user a sentence about why.
      expect(adapter.coverageGaps.join(' ')).toMatch(/deposit|withdraw|transfer/iu)
    },
  )
})

// ---------------------------------------------------------------------------
// Numeric fidelity
// ---------------------------------------------------------------------------

describe.each(CASES.map((c) => [c.exchange, c] as const))('%s numerics', (_name, testCase) => {
  it('round-trips every numeric literal in its fixtures exactly', () => {
    const fixtures = loadFixtures(testCase.exchange).filter((f) =>
      testCase.numericFixtures.includes(f.name),
    )
    expect(fixtures.length).toBe(testCase.numericFixtures.length)

    for (const fixture of fixtures) {
      // Every quoted and unquoted numeric literal in the recorded body.
      const literals = fixture.responseBody.match(/-?\d+\.\d+(?:[eE][+-]?\d+)?/g) ?? []
      expect(literals.length).toBeGreaterThan(0)
      for (const literal of literals) {
        const parsed = decFromRaw(literal)
        // Trailing zeros are significant and must survive; an exponent is expanded, not evaluated.
        if (!/[eE]/.test(literal)) expect(parsed).toBe(literal)
        else expect(decFromRaw(parsed)).toBe(parsed)
      }
    }
  })

  it('carries an eighteen-decimal quantity through the adapter untouched', async () => {
    const h = createHarness({
      adapter: testCase.adapter,
      exchange: testCase.exchange,
      fixtures: testCase.balanceFixtures,
    })
    const page = await testCase.adapter.fetchBalances(h.ctx)
    const widest = page.records
      .map((r) => r.free)
      .reduce((a, b) => ((a.split('.')[1] ?? '').length >= (b.split('.')[1] ?? '').length ? a : b))
    expect(h.transport.sent.length).toBeGreaterThan(0)
    // The exact string from the response body, digit for digit.
    expect(loadFixtures(testCase.exchange).some((f) => f.responseBody.includes(widest))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe.each(CASES.map((c) => [c.exchange, c] as const))('%s fill paging', (_name, testCase) => {
  async function walk(): Promise<AcquiredPage<RawFill>[]> {
    const h = createHarness({
      adapter: testCase.adapter,
      exchange: testCase.exchange,
      fixtures: testCase.fillFixtures,
    })
    const pages: AcquiredPage<RawFill>[] = []
    for await (const page of testCase.adapter.fetchFills(
      withAssets(h.ctx, testCase.assets),
      null,
      testCase.markets,
    )) {
      pages.push(page)
      // A stream that does not terminate would hang the suite rather than fail it.
      if (pages.length > 50) throw new Error('fetchFills did not terminate')
    }
    return pages
  }

  it('terminates', async () => {
    const pages = await walk()
    expect(pages.length).toBeLessThanOrEqual(50)
    expect(pages[pages.length - 1]?.nextCursor).not.toBe(undefined)
  })

  it('never returns the same trade twice within a run', async () => {
    const ids = (await walk()).flatMap((p) => p.records.map((r) => r.externalId))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('advances its cursor monotonically', async () => {
    const cursors = (await walk())
      .map((p) => p.nextCursor)
      .filter((c): c is string => c !== null)
    expect(cursors.length).toBeGreaterThan(0)
    // A cursor is opaque to core but not arbitrary: whatever it holds, no watermark inside it may
    // ever move backwards, or a resumed sync would re-walk history it has already committed.
    for (let i = 1; i < cursors.length; i += 1) {
      const previous = watermarks(cursors[i - 1] as string)
      const current = watermarks(cursors[i] as string)
      for (const [scope, mark] of previous) {
        expect(current.get(scope) ?? -1n, `${scope} went backwards`).toBeGreaterThanOrEqual(mark)
      }
    }
  })

  it('carries every record with a page document, and none without', async () => {
    for (const page of await walk()) {
      if (page.records.length > 0) expect(page.document).not.toBeNull()
      else expect(page.document).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Idempotency and symbol splitting
// ---------------------------------------------------------------------------

describe.each(CASES.map((c) => [c.exchange, c] as const))('%s sync', (_name, testCase) => {
  function syncOptions(store: MemorySyncStore) {
    return {
      store,
      adapter: testCase.adapter,
      accountId: 'account-1',
      transport: createReplayTransport(loadFixtures(testCase.exchange), {
        only: [...testCase.syncFixtures],
      }),
      limiter: new RateLimiter({
        budgetPerMinute: 6000,
        maxPerSecond: 1000,
        clock: new ManualClock(),
      }),
      userAgent: 'Misal/0.1 (test)',
      now: () => NOW,
    }
  }

  it('replaying the whole fixture sync twice produces identical row counts', async () => {
    const store = new MemorySyncStore()
    await runSync(syncOptions(store))
    const after = {
      transactions: store.transactions.length,
      positions: store.positions.length,
      documents: store.documents.size,
      instruments: store.instruments.length,
    }
    expect(after.transactions).toBeGreaterThan(0)

    store.cursors.clear()
    await runSync(syncOptions(store))

    expect({
      transactions: store.transactions.length,
      positions: store.positions.length,
      documents: store.documents.size,
      instruments: store.instruments.length,
    }).toEqual(after)
  })

  it('splits symbols through the market catalogue rather than the string', async () => {
    const store = new MemorySyncStore()
    await runSync(syncOptions(store))
    const markets = await store.readMarkets(testCase.adapter.id, '2026-08-12')

    expect(markets).not.toBeNull()
    for (const market of markets ?? []) {
      // The property that string splitting cannot provide: for WBTCBTC the base is WBTC and the
      // quote is BTC, even though the base code contains the quote code.
      expect(market.symbol.includes(market.base.code)).toBe(true)
      if (market.base.code.includes(market.quote.code)) {
        expect(market.symbol).toBe(`${market.base.code}${market.quote.code}`)
        expect(market.base.code).not.toBe(market.quote.code)
      }
    }
  })
})
