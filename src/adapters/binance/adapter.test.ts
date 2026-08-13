import { describe, expect, it } from 'vitest'
import type { AcquiredPage, AdapterContext, RawConversion, RawTransfer } from '../contract'
import { AdapterError } from '../errors'
import { createHarness, withAssets } from '../testing/harness'
import { createBinanceAdapter } from './adapter'
import { HISTORY_START_MS, TRANSFER_SPAN_MS } from './history'
import { planWindows } from './windows'

const adapter = createBinanceAdapter({ pageSize: 2 })
/** One backfill window a run, so a test's fixture list is a fixture list. */
const bounded = createBinanceAdapter({ pageSize: 2, backfillWindows: 1 })

async function collect<T>(pages: AsyncIterable<AcquiredPage<T>>): Promise<AcquiredPage<T>[]> {
  const out: AcquiredPage<T>[] = []
  for await (const page of pages) out.push(page)
  return out
}

function records<T>(pages: readonly AcquiredPage<T>[]): T[] {
  return pages.flatMap((page) => [...page.records])
}

/**
 * Both streams are optional on the contract, so a test that quietly fell back to an empty list
 * would pass just as well against an adapter that had stopped implementing them.
 */
function transfers(ctx: AdapterContext, cursor: string | null = null) {
  const stream = bounded.fetchTransfers?.(ctx, cursor)
  if (stream === undefined) throw new Error('the Binance adapter no longer fetches transfers')
  return collect<RawTransfer>(stream)
}

function conversions(ctx: AdapterContext, cursor: string | null = null) {
  const stream = bounded.fetchConversions?.(ctx, cursor)
  if (stream === undefined) throw new Error('the Binance adapter no longer fetches conversions')
  return collect<RawConversion>(stream)
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

describe('date-window planning', () => {
  const nowMs = BigInt(Date.UTC(2026, 7, 12, 10, 0, 0))
  const plan = (
    covered: Parameters<typeof planWindows>[0]['covered'],
    windows = 3,
    revisitMs = 0n,
  ) =>
    planWindows({
      covered,
      nowMs,
      spanMs: TRANSFER_SPAN_MS,
      historyStartMs: HISTORY_START_MS,
      backfillWindows: windows,
      revisitMs,
    })

  it('never asks for a span wider than the endpoint allows', () => {
    for (const step of plan(null, 6)) {
      // 90 days is a hard limit, not a default: a wider window is rejected outright.
      expect(step.window.endMs - step.window.startMs).toBeLessThan(TRANSFER_SPAN_MS)
      expect(step.window.startMs).toBeLessThanOrEqual(step.window.endMs)
    }
  })

  it('walks backwards from now on a first run, and covers the present instant', () => {
    const first = plan(null, 1)[0]
    expect(first?.direction).toBe('backfill')
    // The instant `now` must be inside a window that was actually requested, not merely claimed.
    expect(first?.window.endMs).toBe(nowMs)
  })

  it('resumes below where it stopped rather than re-walking', () => {
    const firstRun = plan(null, 2)
    const after = firstRun[firstRun.length - 1]?.covered
    const secondRun = plan(after ?? null, 2)
    // No overlap: the next window ends one millisecond below the floor already covered.
    expect(secondRun[0]?.window.endMs).toBe(BigInt(after?.floorMs ?? '0') - 1n)
  })

  it('fills the gap since the last sync before it extends history downwards', () => {
    const stale = { floorMs: `${nowMs - 10n * 86_400_000n}`, highMs: `${nowMs - 86_400_000n}`, done: false }
    const steps = plan(stale, 1)
    expect(steps[0]?.direction).toBe('forward')
    expect(steps[0]?.window.endMs).toBe(nowMs)
    // And the forward pass is not bounded by the backfill budget: a hole is a hole.
    expect(steps.filter((s) => s.direction === 'backfill')).toHaveLength(1)
  })

  it('re-reads a trailing overlap, so a transfer that was still pending is not lost', () => {
    const day = 86_400_000n
    const lastSync = { floorMs: `${nowMs - 100n * day}`, highMs: `${nowMs - day}`, done: false }

    // Without an overlap the forward pass resumes strictly above the covered high, and a deposit
    // that was still confirming when its window was read - correctly skipped, because units that
    // have not arrived are not inventory - keeps its timestamp inside that window and is never
    // looked at again. Silently lost, and visible later only as an unexplained coverage gap.
    const tight = plan(lastSync, 1)
    expect(tight[0]?.window.startMs).toBe(nowMs - day + 1n)

    const overlapping = plan(lastSync, 1, 7n * day)
    expect(overlapping[0]?.window.startMs).toBe(nowMs - 8n * day + 1n)
    expect(overlapping[0]?.direction).toBe('forward')
    // And re-reading costs nothing beyond the request: every row in the overlap deduplicates on
    // its natural key.
    expect(overlapping.filter((s) => s.direction === 'forward')).toHaveLength(1)
  })

  it('does not re-read on a first sync, which has nothing to re-read', () => {
    // `now` is the covered high on a fresh cursor, so an unguarded overlap would emit a forward
    // window duplicating the first backfill one.
    expect(plan(null, 1, 7n * 86_400_000n).every((s) => s.direction === 'backfill')).toBe(true)
  })

  it('stops at the exchange’s own beginning and says it is finished', () => {
    const nearFloor = { floorMs: `${HISTORY_START_MS + 10n}`, highMs: `${nowMs}`, done: false }
    const steps = plan(nearFloor, 5)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.window.startMs).toBe(HISTORY_START_MS)
    expect(steps[0]?.covered.done).toBe(true)
    // And a finished walk asks for nothing at all next time.
    expect(plan(steps[0]?.covered ?? null, 5)).toHaveLength(0)
  })
})

describe('deposits and withdrawals', () => {
  const fixtures = ['deposit-hisrec', 'withdraw-history']

  it('reads both endpoints and never a mutating sibling', async () => {
    const h = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    await transfers(h.ctx)

    const paths = h.transport.sent.map((r) => r.path)
    expect(paths).toContain('/sapi/v1/capital/deposit/hisrec')
    expect(paths).toContain('/sapi/v1/capital/withdraw/history')
    // The whole security claim in one assertion: reading withdrawals is not performing one, and
    // /capital/withdraw/apply is not expressible from here.
    expect(paths.every((p) => !p.endsWith('/apply'))).toBe(true)
  })

  it('prices the two endpoints apart, because Binance does', async () => {
    // An account budget too small to hold one withdrawal page. Deposits are metered per IP and
    // cost nothing against it, so they go through; the withdrawal is refused outright rather
    // than sleeping forever against a budget it could never fit into.
    const h = createHarness({
      adapter: bounded,
      exchange: 'binance',
      fixtures,
      uidBudgetPerMinute: 20_000,
    })
    await expect(transfers(h.ctx)).rejects.toMatchObject({ code: 'rate_limited' })

    const paths = h.transport.sent.map((r) => r.path)
    expect(paths).toContain('/sapi/v1/capital/deposit/hisrec')
    expect(paths).not.toContain('/sapi/v1/capital/withdraw/history')
    expect(h.clock.slept).toHaveLength(0)
  })

  it('paces a long withdrawal walk against the account budget rather than the IP one', async () => {
    // Binance's real figures: 18,000 a page against 180,000 a minute, of which the limiter
    // targets half. Five pages fit in a minute and the sixth waits - which is exactly why the
    // production window counts are what they are.
    const wide = createBinanceAdapter({ pageSize: 2, backfillWindows: 6 })
    const h = createHarness({
      adapter: wide,
      exchange: 'binance',
      fixtures,
      uidBudgetPerMinute: 180_000,
    })
    const stream = wide.fetchTransfers?.(h.ctx, null)
    if (stream === undefined) throw new Error('the Binance adapter no longer fetches transfers')
    await collect<RawTransfer>(stream)

    expect(h.clock.slept.length).toBeGreaterThan(0)
    // Six deposit pages at IP weight 1 barely register against a 6,000-a-minute budget.
    expect(h.transport.sent.filter((r) => r.path.endsWith('/hisrec'))).toHaveLength(6)
  })

  it('is not able to describe a transfer as an acquisition', async () => {
    const h = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    const all = records(await transfers(h.ctx))
    // RawTransfer has no `price` and no `side`, so this is a type-level guarantee as much as a
    // runtime one; the assertion pins the shape against a well-meaning future addition.
    for (const transfer of all) {
      expect(Object.keys(transfer)).not.toContain('price')
      expect(Object.keys(transfer)).not.toContain('side')
      expect(transfer.quantity.startsWith('-')).toBe(false)
    }
  })

  it('reads a withdrawal’s civil timestamp as UTC rather than as local time', async () => {
    const h = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    const all = records(await transfers(h.ctx))
    const out = all.find((t) => t.direction === 'out')
    // `completeTime` is '2026-06-15 08:41:12' with no zone marker at all. Handing that to Date
    // would shift it by the machine's offset and move some withdrawals to the previous day -
    // and the day is what the natural key is built on.
    expect(out?.occurredAt).toBe('2026-06-15T08:41:12.000Z')
    expect(out?.fee).toEqual({ amount: '0.00050000', asset: { code: 'BTC' } })
  })

  it('pages within a window by offset', async () => {
    const h = createHarness({
      adapter: bounded,
      exchange: 'binance',
      fixtures: ['deposit-hisrec-page-1', 'deposit-hisrec-page-2', 'withdraw-history'],
    })
    const pages = await transfers(h.ctx)
    const all = records(pages)
    const deposits = all.filter((t) => t.direction === 'in')
    expect(deposits.map((t) => t.asset.code)).toEqual(['WBTC', 'SOL', 'XRP'])
    expect(h.transport.sent.filter((r) => r.query.includes('offset=2'))).toHaveLength(1)

    // No page inside a window may claim the window. `offset` is not a watermark: committing page
    // one and then dying must re-read the window, or pages two and three are lost for good.
    const depositPages = pages.filter((p) => p.document?.pageRef.includes('deposits') === true)
    expect(depositPages).toHaveLength(2)
    for (const page of depositPages) {
      const covered = (JSON.parse(page.nextCursor ?? '{}') as { deposits: { floorMs: string } })
        .deposits
      // Still the empty interval - one millisecond past now - so nothing is yet claimed as read.
      expect(BigInt(covered.floorMs)).toBeGreaterThan(BigInt(Date.UTC(2026, 7, 12, 10, 0, 0)))
    }

    // And the window checkpoint that follows them does advance it.
    const checkpoint = pages.find((p) => p.records.length === 0)
    const advanced = (JSON.parse(checkpoint?.nextCursor ?? '{}') as {
      deposits: { floorMs: string }
    }).deposits
    expect(BigInt(advanced.floorMs)).toBeLessThan(BigInt(Date.UTC(2026, 7, 12, 10, 0, 0)))
  })

  it('separates settled transfers from those that have not happened', async () => {
    const h = createHarness({
      adapter: bounded,
      exchange: 'binance',
      fixtures: ['deposit-hisrec-page-1', 'deposit-hisrec-page-2', 'withdraw-history'],
    })
    const all = records(await transfers(h.ctx))
    const byStatus = new Map(all.map((t) => [t.asset.code, t.status]))
    expect(byStatus.get('WBTC')).toBe('completed')
    // Status 0 is 'pending': the units have not arrived and must not become inventory.
    expect(byStatus.get('SOL')).toBe('pending')
    // Status 7 is 'wrong deposit'. It is reported rather than dropped, so the report can say so.
    expect(byStatus.get('XRP')).toBe('failed')
  })

  it('checkpoints every window, so a bounded backfill resumes where it stopped', async () => {
    const h = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    const pages = await transfers(h.ctx)
    const cursor = pages[pages.length - 1]?.nextCursor
    expect(cursor).not.toBeNull()

    const parsed = JSON.parse(cursor ?? '{}') as {
      deposits: { floorMs: string; done: boolean }
      withdrawals: { floorMs: string; done: boolean }
    }
    // Not finished, and the cursor says exactly how far back the figures currently go.
    expect(parsed.deposits.done).toBe(false)
    expect(BigInt(parsed.deposits.floorMs)).toBeGreaterThan(HISTORY_START_MS)

    const next = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    await transfers(next.ctx, cursor)
    const resumedEnd = /endTime=(\d+)/.exec(next.transport.sent[0]?.query ?? '')?.[1]
    expect(BigInt(resumedEnd ?? '0')).toBe(BigInt(parsed.deposits.floorMs) - 1n)
  })

  it('says out loud that the backfill has not reached the beginning', async () => {
    const h = createHarness({ adapter: bounded, exchange: 'binance', fixtures })
    await transfers(h.ctx)
    expect(h.issues.some((i) => i.code === 'backfill_incomplete')).toBe(true)
  })
})

describe('Convert history', () => {
  it('asks tradeFlow for both bounds, within its thirty-day maximum', async () => {
    const h = createHarness({
      adapter: bounded,
      exchange: 'binance',
      fixtures: ['convert-tradeflow'],
    })
    const all = records(await conversions(h.ctx))

    const request = h.transport.sent[0]
    expect(request?.path).toBe('/sapi/v1/convert/tradeFlow')
    const start = BigInt(/startTime=(\d+)/.exec(request?.query ?? '')?.[1] ?? '0')
    const end = BigInt(/endTime=(\d+)/.exec(request?.query ?? '')?.[1] ?? '0')
    expect(end - start).toBeLessThan(30n * 86_400_000n)

    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      externalId: '940708407462087195',
      from: { code: 'USDT' },
      fromQuantity: '1200.00000000',
      to: { code: 'ETH' },
      toQuantity: '0.40000000',
      // The exchange's own inverseRatio, not fromAmount divided by toAmount: a division here
      // would be a rounding decision Binance has already made.
      price: '3000.00000000',
    })
  })

  it('narrows the window when the exchange says there is more, rather than repeating itself', async () => {
    const h = createHarness({
      adapter: bounded,
      exchange: 'binance',
      fixtures: ['convert-tradeflow-more', 'convert-tradeflow-tail'],
    })
    const all = records(await conversions(h.ctx))

    // tradeFlow has no offset. `moreData: true` is answered by pulling endTime down to just below
    // the oldest row already seen; sending the same endTime again would loop on the same rows.
    expect(all.map((c) => c.to.code)).toEqual(['SOL', 'ETH', 'BNB'])
    const ends = h.transport.sent.map((r) => /endTime=(\d+)/.exec(r.query)?.[1])
    expect(new Set(ends).size).toBe(ends.length)
    expect(ends[1]).toBe('1784999999999')
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
