import { dec } from '@domain/numeric'
import { describe, expect, it } from 'vitest'
import { createBinanceAdapter } from '../binance/adapter'
import { createCoindcxAdapter } from '../coindcx/adapter'
import type { ExchangeAdapter } from '../contract'
import { RateLimiter } from '../ratelimit'
import { ManualClock } from '../testing/harness'
import { MemorySyncStore } from '../testing/memory-store'
import { createReplayTransport, loadFixtures, type ReplayTransport } from '../testing/replay-transport'
import { runSync, type SyncOptions } from './runner'

const NOW = new Date('2026-08-12T10:00:00.000Z')

const BINANCE_HAPPY = [
  'api-restrictions-read-only',
  'time',
  'exchange-info',
  'user-asset',
  'mytrades-btctusd-empty',
  'mytrades-btcusdt-page-1',
  'mytrades-btcusdt-page-2',
]

const COINDCX_HAPPY = ['markets-details', 'balances', 'trade-history-page-1', 'trade-history-page-2']

function options(
  adapter: ExchangeAdapter,
  exchange: 'binance' | 'coindcx',
  fixtures: readonly string[],
  store = new MemorySyncStore(),
): SyncOptions & { store: MemorySyncStore; transport: ReplayTransport } {
  return {
    store,
    adapter,
    accountId: 'account-1',
    transport: createReplayTransport(loadFixtures(exchange), { only: [...fixtures] }),
    limiter: new RateLimiter({ budgetPerMinute: 6000, maxPerSecond: 1000, clock: new ManualClock() }),
    userAgent: 'Misal/0.1 (test)',
    now: () => NOW,
  }
}

describe('a first sync', () => {
  it('commits balances before it starts the trade crawl', async () => {
    const adapter = createBinanceAdapter({ pageSize: 2 })
    const opts = options(adapter, 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)

    expect(outcome.status).toBe('completed')
    // BTC and USDT resolve; NEWCOIN does not and is withheld rather than guessed at.
    expect(outcome.balancesCommitted).toBe(2)
    expect(opts.store.unresolved.map((u) => u.rawIdentifier)).toEqual(['NEWCOIN'])

    const paths = opts.transport.sent.map((r) => r.path)
    expect(paths.indexOf('/sapi/v3/asset/getUserAsset')).toBeLessThan(
      paths.indexOf('/api/v3/myTrades'),
    )
  })

  it('records the withheld quantity so the UI can state what is missing', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY)
    await runSync(opts)
    expect(opts.store.unresolved[0]?.observedQuantity).toBe('42.000000000000000001')
  })

  it('turns a fee paid in kind into its own transaction', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    const fees = opts.store.transactions.filter((t) => t.type === 'fee')
    // BNB is in the catalogue, so the commission becomes a fee row against BNB rather than
    // being rounded into a minor-unit column that cannot hold 0.000114 of anything.
    expect(fees).toHaveLength(3)
    expect(fees[0]?.quantity).toBe('-0.00011400')
    expect(fees[0]?.currency).toBe('X:BNB')
    expect(opts.store.transactions.every((t) => t.otherFeesMinor === '0')).toBe(true)
  })

  it('records a crypto-quoted trade with no amount_minor', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    const buy = opts.store.transactions.find((t) => t.type === 'buy')
    // USDT has no ISO code and no minor unit, so the value is derived from quantity and price
    // at valuation time instead of being forced into an integer here.
    expect(buy?.currency).toBe('X:USDT')
    expect(buy?.amountMinor).toBeNull()
    expect(buy?.price).toBe('60000.00000000')
    expect(buy?.occurredTz).toBeNull()
  })

  it('records an INR-quoted trade in real minor units', async () => {
    const opts = options(createCoindcxAdapter({ pageSize: 2 }), 'coindcx', COINDCX_HAPPY)
    await runSync(opts)

    const buy = opts.store.transactions.find((t) => t.type === 'buy')
    expect(buy?.currency).toBe('INR')
    // 0.0012 BTC at 5,000,000 INR = 6,000 INR = 600,000 paise.
    expect(buy?.amountMinor).toBe('600000')
    // The fee was charged in INR, so it belongs in a fee column rather than as its own row.
    expect(buy?.otherFeesMinor).toBe('1250')
    expect(opts.store.transactions.some((t) => t.type === 'fee')).toBe(false)
  })

  it('signs a sell negative, so the fold means something', async () => {
    const opts = options(createCoindcxAdapter({ pageSize: 2 }), 'coindcx', COINDCX_HAPPY)
    await runSync(opts)
    const sell = opts.store.transactions.find((t) => t.type === 'sell')
    expect(sell?.quantity).toBe('-0.00030000000000')
  })
})

describe('idempotency', () => {
  it('replaying the whole sync twice leaves the row counts unchanged', async () => {
    const store = new MemorySyncStore()
    const adapter = createCoindcxAdapter({ pageSize: 2 })

    const first = await runSync(options(adapter, 'coindcx', COINDCX_HAPPY, store))
    const rowsAfterFirst = store.transactions.length
    const positionsAfterFirst = store.positions.length

    // A second run from a null cursor: the same pages, the same natural keys, no new rows.
    store.cursors.clear()
    const second = await runSync(options(adapter, 'coindcx', COINDCX_HAPPY, store))

    expect(first.fillsCommitted).toBeGreaterThan(0)
    expect(second.fillsCommitted).toBe(0)
    expect(second.fillsDuplicate).toBe(rowsAfterFirst)
    expect(store.transactions).toHaveLength(rowsAfterFirst)
    expect(store.positions).toHaveLength(positionsAfterFirst)
  })

  it('reuses the source document when the same page is fetched again', async () => {
    const store = new MemorySyncStore()
    const adapter = createCoindcxAdapter({ pageSize: 2 })
    await runSync(options(adapter, 'coindcx', COINDCX_HAPPY, store))
    const documents = store.documents.size
    store.cursors.clear()
    await runSync(options(adapter, 'coindcx', COINDCX_HAPPY, store))
    expect(store.documents.size).toBe(documents)
  })
})

describe('a partial sync', () => {
  it('keeps the committed page, stops at its watermark, and says so', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', [
      'api-restrictions-read-only',
      'time',
      'exchange-info',
      'user-asset',
      'mytrades-btctusd-empty',
      'mytrades-btcusdt-page-1',
      // The second page dies. The first must survive.
      'mytrades-server-error',
    ])
    const outcome = await runSync(opts)

    expect(outcome.status).toBe('completed')
    expect(outcome.partial).toBe(true)
    expect(outcome.rowsFailed).toBeGreaterThan(0)
    expect(outcome.errorCode).toBe('upstream_unavailable')
    expect(opts.store.accountStatus).toEqual({
      status: 'partial',
      errorCode: 'upstream_unavailable',
    })

    // Page one's rows are committed and the watermark sits on page one, not past it.
    expect(opts.store.transactions.filter((t) => t.type === 'buy')).toHaveLength(2)
    const cursor = await opts.store.readCursor('account-1', 'fills', '*')
    expect(cursor).toContain('28458')
    expect(cursor).not.toContain('28460')
  })

  it('resumes from the committed page and produces no duplicates', async () => {
    const store = new MemorySyncStore()
    const adapter = createBinanceAdapter({ pageSize: 2 })
    await runSync(
      options(adapter, 'binance', [
        'api-restrictions-read-only',
        'time',
        'exchange-info',
        'user-asset',
        'mytrades-btctusd-empty',
        'mytrades-btcusdt-page-1',
        'mytrades-server-error',
      ], store),
    )
    const afterFailure = store.transactions.length

    const resumed = await runSync(
      options(adapter, 'binance', [
        'api-restrictions-read-only',
        'time',
        'exchange-info',
        'user-asset',
        'mytrades-btcusdt-page-2',
        'mytrades-btcusdt-exhausted',
      ], store),
    )

    expect(resumed.status).toBe('completed')
    expect(store.transactions.length).toBeGreaterThan(afterFailure)

    // Uniqueness is on (natural_key, occurrence), not on the key alone. The two identical BNB
    // commissions in page one are genuinely two fees and both must survive; only a repeat of the
    // same pair would be a duplicate.
    const keys = store.transactions.map((t) => `${t.naturalKey}|${t.occurrence}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('balances are atomic', () => {
  it('writes nothing at all when the commit fails part-way', async () => {
    const store = new MemorySyncStore()
    // Yesterday's positions, which must survive today's failure untouched.
    await store.commitPositions('account-1', '2026-08-11', [
      { instrumentId: 'instrument-legacy', quantity: dec('1.00000000') },
    ], 'document-legacy')

    store.failPositionsAfter = 1
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY, store)
    const outcome = await runSync(opts)

    expect(outcome.balancesCommitted).toBe(0)
    expect(store.positions.filter((p) => p.asOf === '2026-08-12')).toHaveLength(0)
    // A half-written balance set is not incomplete, it is wrong: it would understate net worth
    // while looking complete. Yesterday's figures stand, visibly stale.
    expect(store.positions.filter((p) => p.asOf === '2026-08-11')).toHaveLength(1)
  })
})

describe('an over-scoped key found mid-life', () => {
  it('quarantines the account instead of syncing, and deletes nothing', async () => {
    const store = new MemorySyncStore()
    await store.commitPositions('account-1', '2026-08-11', [
      { instrumentId: 'instrument-legacy', quantity: dec('1.00000000') },
    ], 'document-legacy')

    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', [
      'api-restrictions-withdrawals',
    ], store)
    const outcome = await runSync(opts)

    expect(outcome.status).toBe('quarantined')
    expect(store.accountStatus).toEqual({ status: 'quarantined', errorCode: 'auth_over_scoped' })
    expect(store.positions).toHaveLength(1)
    expect(store.transactions).toHaveLength(0)
    // It stopped before spending a single request on data.
    expect(opts.transport.sent.map((r) => r.path)).toEqual(['/sapi/v1/account/apiRestrictions'])
  })
})

describe('coverage', () => {
  it('reports the gap between the fold and the balance as a warning, not an error', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)

    const gap = outcome.coverage.find((row) => !row.matches)
    expect(gap).toBeDefined()
    expect(outcome.issues.some((i) => i.code === 'coverage_gap' && i.severity === 'warning')).toBe(
      true,
    )
    // The account still completed. An incomplete history is a measurement, not a failure.
    expect(outcome.status).toBe('completed')
  })

  it('names the Convert gap explicitly rather than absorbing it', async () => {
    const opts = options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)
    expect(outcome.issues.map((i) => i.message).join(' ')).toMatch(/Convert trades never appear/)
    expect((await opts.store.readCursor('account-1', 'fills', '*')) !== null).toBe(true)
  })
})

describe('instrument resolution', () => {
  it('resolves BTC on both exchanges to a single instrument', async () => {
    const store = new MemorySyncStore()
    await runSync(options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY, store))
    await runSync(options(createCoindcxAdapter({ pageSize: 2 }), 'coindcx', COINDCX_HAPPY, store))

    const coingecko = store.aliases.filter((a) => a.scheme === 'coingecko' && a.value === 'bitcoin')
    expect(coingecko).toHaveLength(1)

    const providerLocal = store.aliases.filter(
      (a) => a.scheme === 'provider-local' && a.value === 'BTC',
    )
    expect(providerLocal.map((a) => a.providerId).sort()).toEqual(['binance', 'coindcx'])
    expect(new Set(providerLocal.map((a) => a.instrumentId)).size).toBe(1)
  })

  it('classifies a stablecoin as crypto and a fiat balance as cash', async () => {
    const store = new MemorySyncStore()
    await runSync(options(createCoindcxAdapter({ pageSize: 2 }), 'coindcx', COINDCX_HAPPY, store))

    const byName = new Map(store.instruments.map((i) => [i.displayName, i]))
    expect(byName.get('Tether USDt')?.assetClass).toBe('crypto')
    expect(byName.get('Indian rupee')?.assetClass).toBe('cash')
    expect(byName.get('Bitcoin')?.taxRegime).toBe('vda')
  })

  it('takes quantity precision from the market catalogue, not the schema default', async () => {
    const store = new MemorySyncStore()
    await runSync(options(createBinanceAdapter({ pageSize: 2 }), 'binance', BINANCE_HAPPY, store))
    // The core default of 4 would render a Bitcoin balance uselessly.
    expect(store.instruments.find((i) => i.displayName === 'Bitcoin')?.precision).toBe(5)
  })
})
