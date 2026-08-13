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

/**
 * A whole Binance sync's worth of recorded responses.
 *
 * The transfer and Convert fixtures are `repeatable`, because a sync walks one date window per
 * stream per run and the window moves every time: pinning a fixture to a window would make the
 * list a function of the test's clock. The two extra `myTrades` fixtures are the consequence of
 * fetching transfers at all - a WBTC deposit and an ETH conversion put two pairs into the symbol
 * sweep that the balance sheet alone would never have discovered.
 */
const BINANCE_HAPPY = [
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
  'mytrades-ethbtc-empty',
  'mytrades-wbtcbtc-empty',
]

/** One backfill window a sync, so a fixture set is a fixture set rather than a decade of them. */
function binance(): ExchangeAdapter {
  return createBinanceAdapter({ pageSize: 2, backfillWindows: 1 })
}

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
    const adapter = binance()
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
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)
    expect(opts.store.unresolved[0]?.observedQuantity).toBe('42.000000000000000001')
  })

  it('turns a fee paid in kind into its own transaction', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    const fees = opts.store.transactions.filter((t) => t.type === 'fee' && t.currency === 'X:BNB')
    // BNB is in the catalogue, so the commission becomes a fee row against BNB rather than
    // being rounded into a minor-unit column that cannot hold 0.000114 of anything. Filtered to
    // BNB because withdrawals now contribute a fee row of their own, in the withdrawn asset.
    expect(fees).toHaveLength(3)
    expect(fees[0]?.quantity).toBe('-0.00011400')
    expect(fees[0]?.currency).toBe('X:BNB')
    expect(opts.store.transactions.every((t) => t.otherFeesMinor === '0')).toBe(true)
  })

  it('records a crypto-quoted trade with no amount_minor', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    // By trade id, not by "the first buy": Convert acquisitions commit before trade history does
    // and are buys too, so position in the list stopped meaning anything.
    const buy = opts.store.transactions.find((t) => t.externalId === '28457')
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
    const opts = options(binance(), 'binance', [
      'api-restrictions-read-only',
      'time',
      'exchange-info',
      'user-asset',
      'deposit-hisrec',
      'withdraw-history',
      'convert-tradeflow',
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

    // Page one's rows are committed and the watermark sits on page one, not past it. Counted by
    // trade id so the Convert acquisition, which is also a buy, does not join the total.
    const fills = opts.store.transactions.filter((t) => ['28457', '28458'].includes(t.externalId))
    expect(fills).toHaveLength(2)
    const cursor = await opts.store.readCursor('account-1', 'fills', '*')
    expect(cursor).toContain('28458')
    expect(cursor).not.toContain('28460')
  })

  it('resumes from the committed page and produces no duplicates', async () => {
    const store = new MemorySyncStore()
    const adapter = binance()
    await runSync(
      options(adapter, 'binance', [
        'api-restrictions-read-only',
        'time',
        'exchange-info',
        'user-asset',
        'deposit-hisrec',
        'withdraw-history',
        'convert-tradeflow',
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
        'deposit-hisrec',
        'withdraw-history',
        'convert-tradeflow',
        'mytrades-btcusdt-page-2',
        'mytrades-btcusdt-exhausted',
        'mytrades-ethbtc-empty',
        'mytrades-wbtcbtc-empty',
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
    const opts = options(binance(), 'binance', BINANCE_HAPPY, store)
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

    const opts = options(binance(), 'binance', [
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
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)

    const gap = outcome.coverage.find((row) => !row.matches)
    expect(gap).toBeDefined()
    expect(outcome.issues.some((i) => i.code === 'coverage_gap' && i.severity === 'warning')).toBe(
      true,
    )
    // The account still completed. An incomplete history is a measurement, not a failure.
    expect(outcome.status).toBe('completed')
  })

  it('no longer leaves the Convert caveat ending on "and that is that"', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)
    const notes = outcome.issues.map((i) => i.message).join(' ')

    // The first clause was always true and stays: Convert fills really are absent from trade
    // history. What is no longer true is the consequence, and a caveat that has stopped being
    // true is worse than none, because it teaches the reader to discount the ones that still are.
    expect(notes).toMatch(/Convert trades never appear in trade history, so Misal reads them from/)
    expect((await opts.store.readCursor('account-1', 'fills', '*')) !== null).toBe(true)
  })

  it('states how far back the history it has actually read goes', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)
    // A bounded backfill is honest only if it says so. Otherwise a cost basis built from three
    // months of history is indistinguishable on screen from one built from all of it.
    const incomplete = outcome.issues.filter((i) => i.code === 'backfill_incomplete')
    expect(incomplete.length).toBeGreaterThan(0)
    expect(incomplete.every((i) => i.severity === 'warning')).toBe(true)
    expect(incomplete.map((i) => i.message).join(' ')).toMatch(/read back to \d{4}-\d{2}-\d{2}/)
  })
})

describe('Convert acquisitions reach the ledger', () => {
  it('records a Convert as a priced buy of the asset received', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)

    const eth = opts.store.instruments.find((i) => i.displayName === 'Ethereum')
    expect(eth).toBeDefined()
    const acquisition = opts.store.transactions.find((t) => t.instrumentId === eth?.id)

    // The whole point of gap B: 0.4 ETH acquired through Convert appears in no trade history at
    // all, and before this it existed only as a balance nothing explained.
    expect(acquisition).toBeDefined()
    expect(acquisition?.type).toBe('buy')
    expect(acquisition?.quantity).toBe('0.40000000')
    expect(acquisition?.price).toBe('3000.00000000')
    // USDT has no minor unit, so the cost is carried by quantity and price rather than forced
    // into an integer column.
    expect(acquisition?.currency).toBe('X:USDT')
    expect(acquisition?.amountMinor).toBeNull()
    expect(outcome.conversionsCommitted).toBe(1)
  })

  it('fetches it from tradeFlow rather than hoping myTrades carries it', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)
    const convert = opts.transport.sent.filter((r) => r.path === '/sapi/v1/convert/tradeFlow')
    expect(convert.length).toBeGreaterThan(0)
    // Both bounds are mandatory on this endpoint, and the interval may not exceed 30 days.
    for (const request of convert) {
      expect(request.query).toMatch(/startTime=\d+/)
      expect(request.query).toMatch(/endTime=\d+/)
      const start = BigInt(/startTime=(\d+)/.exec(request.query)?.[1] ?? '0')
      const end = BigInt(/endTime=(\d+)/.exec(request.query)?.[1] ?? '0')
      expect(end - start).toBeLessThanOrEqual(30n * 86_400_000n)
    }
  })
})

describe('a transfer is not an acquisition', () => {
  it('records a deposit as an unpriced transfer_in, never as a buy', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    const outcome = await runSync(opts)

    const wbtc = opts.store.instruments.find((i) => i.displayName === 'Wrapped Bitcoin')
    const rows = opts.store.transactions.filter((t) => t.instrumentId === wbtc?.id)
    expect(rows).toHaveLength(1)
    const deposit = rows[0]

    expect(deposit?.type).toBe('transfer_in')
    // The three fields that would turn units into a cost. All absent, and deliberately: the coin
    // was acquired somewhere Misal cannot see, so its cost is unknown rather than nil and rather
    // than the market price on the day it landed.
    expect(deposit?.price).toBeNull()
    expect(deposit?.amountMinor).toBeNull()
    expect(deposit?.otherFeesMinor).toBe('0')
    // Eighteen decimals, carried through untouched.
    expect(deposit?.quantity).toBe('0.250000000000000001')
    expect(outcome.transfersCommitted).toBeGreaterThan(0)
    expect(opts.store.transactions.some((t) => t.type === 'buy' && t.instrumentId === wbtc?.id))
      .toBe(false)
  })

  it('records a withdrawal as units out, plus the fee charged on top of them', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    const out = opts.store.transactions.find((t) => t.type === 'transfer_out')
    expect(out?.quantity).toBe('-0.02000000')
    expect(out?.price).toBeNull()

    // Binance deducts transactionFee in addition to the amount withdrawn. Dropping it would leave
    // the fold above the reported balance by exactly the fee and invent a coverage gap.
    const fee = opts.store.transactions.find((t) => t.externalId?.endsWith(':fee') === true)
    expect(fee?.type).toBe('fee')
    expect(fee?.quantity).toBe('-0.00050000')
  })

  it('discovers an asset that was deposited and never traded here', async () => {
    const opts = options(binance(), 'binance', BINANCE_HAPPY)
    await runSync(opts)

    // WBTC is in no balance row and no fill. It exists only because a deposit named it - and
    // because it is now a discovered asset, the symbol sweep went and asked about WBTCBTC.
    const discovered = await opts.store.readDiscoveredAssets('account-1')
    expect(discovered).toContain('WBTC')
    expect(opts.transport.sent.some((r) => r.query.includes('symbol=WBTCBTC'))).toBe(true)
  })
})

describe('instrument resolution', () => {
  it('resolves BTC on both exchanges to a single instrument', async () => {
    const store = new MemorySyncStore()
    await runSync(options(binance(), 'binance', BINANCE_HAPPY, store))
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
    await runSync(options(binance(), 'binance', BINANCE_HAPPY, store))
    // The core default of 4 would render a Bitcoin balance uselessly.
    expect(store.instruments.find((i) => i.displayName === 'Bitcoin')?.precision).toBe(5)
  })
})
