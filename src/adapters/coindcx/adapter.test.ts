import { describe, expect, it } from 'vitest'
import type { AcquiredPage, RawFill } from '../contract'
import { createHarness } from '../testing/harness'
import { createCoindcxAdapter, QUOTE_ASSET_SENTINEL } from './adapter'

const adapter = createCoindcxAdapter({ pageSize: 2 })

// CoinDCX needs no symbol enumeration - omitting the symbol returns fills across all of them -
// so the catalogue is only ever used downstream, by the runner.
const MARKETS = [
  { symbol: 'BTCINR', base: { code: 'BTC' }, quote: { code: 'INR' }, quantityPrecision: 8 },
]

async function collect(pages: AsyncIterable<AcquiredPage<RawFill>>): Promise<AcquiredPage<RawFill>[]> {
  const out: AcquiredPage<RawFill>[] = []
  for await (const page of pages) out.push(page)
  return out
}

/**
 * The test this adapter exists to pass.
 *
 * CoinDCX HMACs the serialised request body with no canonicalisation of any kind. Signing one
 * serialisation and transmitting another produces a permanent 401, and it is the failure that
 * breaks most CoinDCX clients in the wild - invisible to any test that only checks the signing
 * function in isolation.
 *
 * The property asserted here is structural: what reaches the transport is a *string*, and it is
 * the only serialisation that ever existed. The Rust transport signs that byte sequence and
 * transmits it unchanged, which its own test asserts on the other side of the boundary.
 */
describe('body signing', () => {
  it('hands the transport one string, which is what will be signed and sent', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['balances'] })
    await adapter.fetchBalances(h.ctx)

    const sent = h.transport.sent[0]
    expect(typeof sent?.body).toBe('string')
    expect(sent?.signing).toBe('coindcx-body')
    // Byte-exact, including key order. Re-encoding this object would produce different bytes.
    expect(sent?.body).toBe('{"timestamp":1786528800000}')
    // Nothing was smuggled into the query string, which CoinDCX does not sign.
    expect(sent?.query).toBe('')
  })

  it('keeps the caller’s key order, because order is part of the signed bytes', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      fixtures: ['trade-history-page-1', 'trade-history-page-2'],
    })
    await collect(adapter.fetchFills(h.ctx, null, MARKETS))

    expect(h.transport.sent[0]?.body).toBe('{"limit":2,"sort":"asc","timestamp":1786528800000}')
    expect(h.transport.sent[1]?.body).toBe(
      '{"limit":2,"sort":"asc","from_id":89,"timestamp":1786528800000}',
    )
  })

  it('applies the measured clock offset to the signed timestamp', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['markets-details', 'balances'] })
    await h.offset.resync()
    await adapter.fetchBalances(h.ctx)

    // The fixture's Date header is 2026-08-12T10:00:00Z and the test clock reads the same
    // instant, so the offset is zero - but it went through the offset, not through Date.now().
    expect(h.offset.offsetMs).toBe('0')
  })
})

describe('scope', () => {
  it('says plainly that there is nothing to introspect', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: [] })
    const scope = await adapter.describeScope(h.ctx)

    expect(scope.verification).toBe('unscopable')
    expect(scope.canTrade).toBe(true)
    // Not a permission finding: CoinDCX exposes no crypto-withdrawal endpoint at all.
    // Not false. A stored false reads as "this key cannot withdraw", which inverts the actual
    // risk: CoinDCX keys are full-access and there is no endpoint that would tell us otherwise.
    // Not false. ScopeReport is persisted into credential_ref.scope_flags and read later by code
    // that never sees the comment justifying it, so a stored false reads as "this key cannot
    // withdraw" - which inverts the actual risk. CoinDCX keys are full-access and no endpoint
    // will ever say otherwise, so unknown is the only defensible value.
    expect(scope.canWithdraw).toBe('unknown')
    // Unknown is for the unverifiable, not a blanket: hiding what we do know would understate
    // the exposure just as badly.
    expect(scope.canRead).toBe(true)
    expect(scope.canTrade).toBe(true)
    expect(scope.canTransferInternally).toBe('unknown')
    expect(scope.ipRestricted).toBe('unknown')
    expect(scope.ipRestricted).toBe('unknown')
    // And it cost no request, because there is no endpoint to ask.
    expect(h.transport.sent).toHaveLength(0)
  })
})

describe('markets', () => {
  it('maps CoinDCX’s target onto base, not its base', async () => {
    // CoinDCX calls the traded asset the "target" and the price denomination the "base" - the
    // opposite of everyone else. Mapping those by name would invert every position, silently.
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['markets-details'] })
    const markets = await adapter.markets(h.ctx)

    const btcinr = markets.find((m) => m.symbol === 'BTCINR')
    expect(btcinr?.base.code).toBe('BTC')
    expect(btcinr?.quote.code).toBe('INR')
  })

  it('reads a step size written in scientific notation', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['markets-details'] })
    const markets = await adapter.markets(h.ctx)
    // 1e-05 in the response; JSON.parse would have made it a double before we ever saw it.
    expect(markets.find((m) => m.symbol === 'BTCINR')?.quantityPrecision).toBe(8)
  })
})

describe('balances', () => {
  it('keeps all seventeen significant digits of a JSON float', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['balances'] })
    const page = await adapter.fetchBalances(h.ctx)
    expect(page.records.find((r) => r.asset.code === 'BTC')?.free).toBe('265.01745775027309')
  })

  it('carries the locked portion separately rather than reporting only what is spendable', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['balances'] })
    const page = await adapter.fetchBalances(h.ctx)
    const usdt = page.records.find((r) => r.asset.code === 'USDT')
    expect(usdt?.free).toBe('1000.00000000')
    expect(usdt?.locked).toBe('250.00000000')
  })

  it('drops zero balances, since whether they are returned is undocumented', async () => {
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['balances'] })
    const page = await adapter.fetchBalances(h.ctx)
    expect(page.records.some((r) => r.asset.code === 'ZEROCOIN')).toBe(false)
  })
})

describe('trade history', () => {
  it('truncates a fractional-millisecond timestamp instead of rounding it', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      fixtures: ['trade-history-page-1', 'trade-history-page-2'],
    })
    const fills = (await collect(adapter.fetchFills(h.ctx, null, MARKETS))).flatMap((p) => p.records)

    // 1718386512255.9999 truncates down. Rounding up would move the instant, change the natural
    // key, and defeat deduplication against the same trade from a CSV export.
    expect(fills[2]?.occurredAt).toBe(new Date(1718386512255).toISOString())
    expect(fills[0]?.occurredAt).toBe(new Date(1718386312255).toISOString())
  })

  it('pages on the exclusive from_id cursor and stops on a short page', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      fixtures: ['trade-history-page-1', 'trade-history-page-2'],
    })
    const pages = await collect(adapter.fetchFills(h.ctx, null, MARKETS))
    expect(pages.flatMap((p) => p.records).map((r) => r.externalId)).toEqual(['88', '89', '90'])
    expect(pages[pages.length - 1]?.nextCursor).toBe('90')
    expect(h.transport.sent).toHaveLength(2)
  })

  it('never asks for a symbol, because omitting it returns every symbol', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      fixtures: ['trade-history-page-1', 'trade-history-page-2'],
    })
    await collect(adapter.fetchFills(h.ctx, null, MARKETS))
    expect(h.transport.sent.every((r) => !(r.body ?? '').includes('symbol'))).toBe(true)
  })

  it('marks a fee whose currency the response never names', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      fixtures: ['trade-history-page-1', 'trade-history-page-2'],
    })
    const fills = (await collect(adapter.fetchFills(h.ctx, null, MARKETS))).flatMap((p) => p.records)
    expect(fills[0]?.fee?.amount).toBe('12.50000000000000')
    // Not guessed here: the runner substitutes the market's quote asset, where it is known.
    expect(fills[0]?.fee?.asset.code).toBe(QUOTE_ASSET_SENTINEL)
  })
})

describe('error handling', () => {
  it('reports a 401 as ambiguous between the key and the clock', async () => {
    const h = createHarness({
      adapter,
      exchange: 'coindcx',
      // The re-measurement reads the Date header of the markets request, since CoinDCX has no
      // server-time endpoint at all.
      fixtures: ['unauthorized', 'markets-details', 'unauthorized'],
    })

    await expect(adapter.fetchBalances(h.ctx)).rejects.toMatchObject({ code: 'auth_or_skew' })
    // It re-measured the clock before deciding, because CoinDCX cannot tell us which it was.
    expect(h.offset.resyncCount).toBe(1)
    await expect(adapter.fetchBalances(h.ctx)).rejects.toThrow(/clock/)
  })

  it('reports a Cloudflare 403 as an edge block, not an auth failure', async () => {
    // Telling the user their key is bad when the real fix is a request header sends them to
    // regenerate a perfectly good key.
    const h = createHarness({ adapter, exchange: 'coindcx', fixtures: ['edge-blocked'], maxAttempts: 1 })
    await expect(adapter.fetchBalances(h.ctx)).rejects.toMatchObject({
      code: 'blocked_by_edge',
      retryable: true,
    })
  })
})
