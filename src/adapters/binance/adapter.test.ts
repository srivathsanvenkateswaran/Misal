import { describe, expect, it } from 'vitest'
import type { AcquiredPage, RawFill } from '../contract'
import { AdapterError } from '../errors'
import { createHarness, withAssets } from '../testing/harness'
import { createBinanceAdapter } from './adapter'

const adapter = createBinanceAdapter({ pageSize: 2 })

async function collect(pages: AsyncIterable<AcquiredPage<RawFill>>): Promise<AcquiredPage<RawFill>[]> {
  const out: AcquiredPage<RawFill>[] = []
  for await (const page of pages) out.push(page)
  return out
}

describe('scope introspection', () => {
  it('reads the key permissions, not the account permissions', async () => {
    // The guard against a scope check that silently does nothing: /api/v3/account reports
    // canWithdraw: true for a healthy account even when the key cannot withdraw a thing. A
    // credential like this must be ACCEPTED.
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['api-restrictions-read-only', 'account-can-withdraw'],
    })
    const scope = await adapter.describeScope(h.ctx)

    expect(scope.canWithdraw).toBe(false)
    expect(scope.verification).toBe('introspected')
    expect(scope.canRead).toBe(true)
    expect(scope.canTrade).toBe(false)
    // And it never asked the account endpoint at all.
    expect(h.transport.sent.map((r) => r.path)).not.toContain('/api/v3/account')
  })

  it('reports a withdrawal-enabled key', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['api-restrictions-withdrawals'],
    })
    const scope = await adapter.describeScope(h.ctx)
    expect(scope.canWithdraw).toBe(true)
    expect(scope.ipRestricted).toBe(true)
  })

  it('treats any trading-adjacent permission as trade capability', async () => {
    const h = createHarness({ adapter, exchange: 'binance', fixtures: ['api-restrictions-trading'] })
    const scope = await adapter.describeScope(h.ctx)
    expect(scope.canTrade).toBe(true)
    expect(scope.canWithdraw).toBe(false)
  })
})

describe('clock skew', () => {
  it('re-measures exactly once, then fails with the drift', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      // Two -1021s in a row: one retry, then a typed error. Retrying indefinitely against a
      // broken clock burns rate budget and hides a real machine problem.
      fixtures: ['clock-skew', 'time', 'clock-skew'],
    })

    await expect(adapter.describeScope(h.ctx)).rejects.toMatchObject({
      code: 'clock_skew',
    })
    expect(h.offset.resyncCount).toBe(1)
  })

  it('succeeds on the retry when the drift was the only problem', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['clock-skew', 'time', 'api-restrictions-read-only'],
    })
    const scope = await adapter.describeScope(h.ctx)
    expect(scope.canWithdraw).toBe(false)
    expect(h.offset.resyncCount).toBe(1)
  })
})

describe('balances', () => {
  it('counts everything held, not just what is spendable', async () => {
    const h = createHarness({ adapter, exchange: 'binance', fixtures: ['user-asset'] })
    const page = await adapter.fetchBalances(h.ctx)

    const btc = page.records.find((r) => r.asset.code === 'BTC')
    // `free` is carried through verbatim, trailing zeros and all.
    expect(btc?.free).toBe('0.50000000')
    // `locked` is locked + freeze + withdrawing + ipoable. Omitting any of them would understate
    // the holding. It is a sum, so its scale is the arithmetic's rather than the response's -
    // the value is exact, which is what matters.
    expect(btc?.locked).toBe('0.1')
    expect(page.records.find((r) => r.asset.code === 'NEWCOIN')?.free).toBe(
      '42.000000000000000001',
    )
  })

  it('hashes the day into the document, so a second day records a second position', async () => {
    const monday = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['user-asset'],
      now: new Date('2026-08-12T10:00:00Z'),
    })
    const tuesday = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['user-asset'],
      now: new Date('2026-08-13T10:00:00Z'),
    })
    const a = await adapter.fetchBalances(monday.ctx)
    const b = await adapter.fetchBalances(tuesday.ctx)
    expect(a.document?.contentHash).not.toBe(b.document?.contentHash)
  })
})

describe('markets', () => {
  it('splits a symbol whose base code contains its quote code', async () => {
    // WBTCBTC is WBTC over BTC. Any splitter that strips a known quote from the end of the
    // string gets this wrong, which is why the catalogue is the only source.
    const h = createHarness({ adapter, exchange: 'binance', fixtures: ['exchange-info'] })
    const markets = await adapter.markets(h.ctx)
    const wbtc = markets.find((m) => m.symbol === 'WBTCBTC')
    expect(wbtc?.base.code).toBe('WBTC')
    expect(wbtc?.quote.code).toBe('BTC')
  })

  it('takes precision from the lot-size step and skips non-trading symbols', async () => {
    const h = createHarness({ adapter, exchange: 'binance', fixtures: ['exchange-info'] })
    const markets = await adapter.markets(h.ctx)
    expect(markets.find((m) => m.symbol === 'BTCUSDT')?.quantityPrecision).toBe(5)
    expect(markets.some((m) => m.symbol === 'DELISTEDUSDT')).toBe(false)
  })
})

describe('trade history', () => {
  const markets = [
    { symbol: 'BTCUSDT', base: { code: 'BTC' }, quote: { code: 'USDT' }, quantityPrecision: 5 },
    { symbol: 'BTCTUSD', base: { code: 'BTC' }, quote: { code: 'TUSD' }, quantityPrecision: 5 },
    { symbol: 'WBTCBTC', base: { code: 'WBTC' }, quote: { code: 'BTC' }, quantityPrecision: 4 },
  ]

  it('pages by trade id and never by a date window', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: [
        'mytrades-btctusd-empty',
        'mytrades-btcusdt-page-1',
        'mytrades-btcusdt-page-2',
      ],
    })
    const pages = await collect(
      adapter.fetchFills(withAssets(h.ctx, ['BTC', 'USDT']), null, markets),
    )

    const ids = pages.flatMap((p) => p.records.map((r) => r.externalId))
    expect(ids).toEqual(['28457', '28458', '28460'])

    const queries = h.transport.sent.map((r) => r.query)
    expect(queries.some((q) => q.includes('startTime'))).toBe(false)
    // fromId is inclusive on Binance, so the next page starts one past the last id seen.
    expect(queries.some((q) => q.includes('fromId=28459'))).toBe(true)
  })

  it('never enumerates a symbol whose base asset the account has never held', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['mytrades-btctusd-empty', 'mytrades-btcusdt-page-1', 'mytrades-btcusdt-page-2'],
    })
    await collect(adapter.fetchFills(withAssets(h.ctx, ['BTC', 'USDT']), null, markets))
    expect(h.transport.sent.some((r) => r.query.includes('WBTCBTC'))).toBe(false)
  })

  it('remembers that a symbol has no trades, and skips it next time', async () => {
    const first = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['mytrades-btctusd-empty', 'mytrades-btcusdt-page-1', 'mytrades-btcusdt-page-2'],
    })
    const pages = await collect(
      adapter.fetchFills(withAssets(first.ctx, ['BTC', 'USDT']), null, markets),
    )
    const cursor = pages[pages.length - 1]?.nextCursor
    expect(cursor).toContain('BTCTUSD')

    const second = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['mytrades-btcusdt-exhausted'],
    })
    await collect(adapter.fetchFills(withAssets(second.ctx, ['BTC', 'USDT']), cursor ?? null, markets))
    expect(second.transport.sent.some((r) => r.query.includes('BTCTUSD'))).toBe(false)
  })

  it('carries a fee paid in kind through as its own asset', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['mytrades-btctusd-empty', 'mytrades-btcusdt-page-1', 'mytrades-btcusdt-page-2'],
    })
    const pages = await collect(
      adapter.fetchFills(withAssets(h.ctx, ['BTC', 'USDT']), null, markets),
    )
    const first = pages.flatMap((p) => p.records)[0]
    expect(first?.fee).toEqual({ amount: '0.00011400', asset: { code: 'BNB' } })
    expect(first?.side).toBe('buy')
    expect(first?.quantity).toBe('0.10000000')
  })
})

describe('transport failures', () => {
  it('halts on an IP ban rather than retrying into it', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['ip-banned'],
      maxAttempts: 5,
    })
    const markets = [
      { symbol: 'BTCUSDT', base: { code: 'BTC' }, quote: { code: 'USDT' }, quantityPrecision: 5 },
    ]

    await expect(
      collect(adapter.fetchFills(withAssets(h.ctx, ['BTC', 'USDT']), null, markets)),
    ).rejects.toBeInstanceOf(AdapterError)
    // One attempt, not five. A ban escalates from two minutes to three days for repeat offenders.
    expect(h.transport.sent).toHaveLength(1)
    expect(h.limiter.halted).toBe(true)
  })

  it('waits out a 429 and loses no data', async () => {
    const h = createHarness({
      adapter,
      exchange: 'binance',
      fixtures: ['rate-limited', 'mytrades-btcusdt-page-1', 'mytrades-btcusdt-page-2'],
    })
    const markets = [
      { symbol: 'BTCUSDT', base: { code: 'BTC' }, quote: { code: 'USDT' }, quantityPrecision: 5 },
    ]
    const pages = await collect(
      adapter.fetchFills(withAssets(h.ctx, ['BTC', 'USDT']), null, markets),
    )
    expect(pages.flatMap((p) => p.records)).toHaveLength(3)
    // Retry-After: 1 was honoured rather than a backoff of our own choosing.
    expect(h.clock.slept).toContain(1000)
  })
})
