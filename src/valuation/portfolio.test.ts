/**
 * End-to-end valuation: positions, prices and FX in, net worth and coverage out.
 *
 * The portfolio here is deliberately mixed — a measured ledger holding, a snapshot holding, a USD
 * holding, an unpriced holding and an unresolved instrument — because every interesting rule in the
 * spec is about how those interact, not about any of them alone.
 */

import { describe, expect, it } from 'vitest'
import { addMinor, dec, minor } from '@domain/numeric'
import {
  instrument,
  instrumentMap,
  measuredUnpricedInput,
  resetIds,
  snapshot,
  txn,
} from './__fixtures__/build'
import { FxTable } from './fx'
import type { FoldInput } from './fold'
import { InMemoryPriceStore, PriceService } from './price/service'
import type { PricePoint } from './price/types'
import { reconcilesToTotal, valuePortfolio } from './portfolio'
import { xirrForScope } from './xirr-scope'
import type { InstrumentRef, UnresolvedInstrumentRow } from './types'

const AS_OF = '2026-08-12T18:30:00+05:30'

const infy = instrument({ id: 'infy', displayName: 'Infosys', assetClass: 'indian_equity', fmv: '1130.00' })
const fund = instrument({ id: 'fund', displayName: 'Some Fund', assetClass: 'mutual_fund' })
const aapl = instrument({ id: 'aapl', displayName: 'Apple', assetClass: 'us_equity', currency: 'USD' })
const dark = instrument({ id: 'dark', displayName: 'Unlisted Thing', assetClass: 'bond' })

function price(instrumentId: string, close: string, asOf: string, currency: 'INR' | 'USD' = 'INR'): PricePoint {
  return {
    instrumentId,
    asOf,
    close: dec(close),
    currency,
    source: 'manual',
    fetchedAt: `${asOf}T20:00:00+05:30`,
  }
}

function buildPortfolio(instruments: ReadonlyMap<string, InstrumentRef>) {
  const store = new InMemoryPriceStore()
  store.put(price('infy', '1500.00', '2026-08-12'))
  store.put(price('fund', '200.0000', '2026-08-12'))
  store.put(price('aapl', '200.00', '2026-08-12', 'USD'))
  // 'dark' deliberately has no price row and no provider.
  const prices = new PriceService({ store, instruments, now: () => AS_OF })
  const fx = new FxTable([
    { base: 'USD', quote: 'INR', asOf: '2019-05-01', rate: dec('68.00'), source: 'seed' },
    { base: 'USD', quote: 'INR', asOf: '2026-08-12', rate: dec('88.00'), source: 'seed' },
  ])
  return { store, prices, fx }
}

function accounts(): FoldInput[] {
  resetIds()
  const instruments = instrumentMap(infy, fund, aapl, dark)
  const ledger: FoldInput = {
    accountId: 'acc-ledger',
    capability: 'ledger',
    txns: [
      txn({
        type: 'buy',
        date: '2024-01-10',
        quantity: '100',
        amount: '10000000',
        instrumentId: 'infy',
        accountId: 'acc-ledger',
      }),
      txn({
        type: 'buy',
        date: '2025-01-10',
        quantity: '50',
        amount: '500000',
        instrumentId: 'dark',
        accountId: 'acc-ledger',
      }),
    ],
    snapshots: [],
    instruments,
    asOf: AS_OF,
  }
  const usd: FoldInput = {
    accountId: 'acc-usd',
    capability: 'ledger',
    txns: [
      txn({
        type: 'buy',
        date: '2019-05-01',
        quantity: '10',
        amount: '100000',
        currency: 'USD',
        fxRate: '68.00',
        instrumentId: 'aapl',
        accountId: 'acc-usd',
      }),
    ],
    snapshots: [],
    instruments,
    asOf: AS_OF,
  }
  const snapshotAccount: FoldInput = {
    accountId: 'acc-snapshot',
    capability: 'snapshot',
    txns: [],
    snapshots: [snapshot('fund', '100.0000', '2026-08-01', 'acc-snapshot')],
    instruments,
    asOf: AS_OF,
  }
  return [ledger, usd, snapshotAccount]
}

const unresolved: readonly UnresolvedInstrumentRow[] = [
  {
    id: 'u1',
    accountId: 'acc-ledger',
    rawIdentifier: 'SOME FUND - GROWTH',
    rawName: null,
    observedQuantity: dec('12.3450'),
    observedValueMinor: minor('4500000'),
    currency: 'INR',
    resolvedAt: null,
  },
]

function snapshotOf() {
  const instruments = instrumentMap(infy, fund, aapl, dark)
  const { prices, fx } = buildPortfolio(instruments)
  const result = valuePortfolio({
    accounts: accounts(),
    instruments,
    prices,
    fx,
    unresolved,
    asOf: AS_OF,
  })
  if (!result.ok) throw new Error(`valuation failed: ${result.error.message}`)
  return { snapshot: result.value, warnings: result.warnings, prices, fx }
}

describe('net worth', () => {
  it('is the sum of the priced positions, and nothing else', () => {
    const { snapshot: valued } = snapshotOf()
    // 100 × ₹1,500 + 100 × ₹200 + 10 × $200 × ₹88.
    expect(valued.netWorthMinor).toBe(
      addMinor(minor('15000000'), minor('2000000'), minor('17600000')),
    )
    expect(reconcilesToTotal(valued)).toBe(true)
  })

  it('excludes withheld value from net worth and reports it beside', () => {
    const { snapshot: valued } = snapshotOf()
    expect(valued.coverage.withheldMinor).toBe('4500000')
    expect(valued.coverage.breakdown.valuedMinor).toBe(valued.netWorthMinor)
    expect(valued.coverage.unresolvedInstrumentCount).toBe(1)
  })

  it('counts an unpriced position rather than valuing it at cost', () => {
    const { snapshot: valued, warnings } = snapshotOf()
    expect(valued.coverage.breakdown.unpricedCount).toBe(1)
    expect(valued.coverage.breakdown.unpricedInstrumentIds).toEqual(['dark'])
    expect(warnings.some((w) => w.code === 'NO_PRICE_SOURCE')).toBe(true)
    const darkPair = valued.pairs.find((p) => p.instrumentId === 'dark')!
    expect(darkPair.marketValue.measured).toBe(false)
  })
})

describe('unrealised P&L', () => {
  it('converts cost at the acquisition-date rate and value at today’s, keeping the currency return', () => {
    const { snapshot: valued } = snapshotOf()
    const pair = valued.pairs.find((p) => p.instrumentId === 'aapl')!
    if (!pair.unrealised.measured) throw new Error('expected a measured P&L')
    // $1,000 at ₹68 = ₹68,000 of cost; $2,000 at ₹88 = ₹1,76,000 of value.
    expect(pair.unrealised.value.costMinor).toBe('6800000')
    expect(pair.unrealised.value.marketValueMinor).toBe('17600000')
    expect(pair.unrealised.value.pnlMinor).toBe('10800000')
    expect(pair.unrealised.value.pnlPct).toBe('158.8235294117647058823529411764705882353')
  })

  it('is withheld for a snapshot holding rather than being computed from a guess', () => {
    const { snapshot: valued } = snapshotOf()
    const pair = valued.pairs.find((p) => p.instrumentId === 'fund')!
    expect(pair.measurement).toBe('not_measured')
    expect(pair.unrealised.measured).toBe(false)
    expect(pair.costMinor.measured).toBe(false)
    // The value is still counted: a snapshot holding is worth what it is worth.
    expect(pair.marketValue.measured && pair.marketValue.value).toBe('2000000')
  })
})

describe('coverage', () => {
  it('is value-weighted over net worth, with the snapshot holding outside it', () => {
    const { snapshot: valued } = snapshotOf()
    // ₹1,50,000 + ₹1,76,000 measured out of ₹3,46,000 valued.
    expect(valued.coverage.measuredMinor).toBe('32600000')
    expect(valued.coverage.historyCoveragePct).toBe('94.21')
    expect(addMinor(valued.coverage.measuredMinor, valued.coverage.unmeasuredMinor)).toBe(
      valued.netWorthMinor,
    )
  })

  it('reconciles every metric: covered plus excluded equals net worth', () => {
    const { snapshot: valued } = snapshotOf()
    for (const metric of valued.coverage.perMetric) {
      expect(addMinor(metric.coveredMinor, metric.excludedValueMinor)).toBe(valued.netWorthMinor)
    }
  })

  it('excludes day change entirely when no prior close is available', () => {
    const { snapshot: valued } = snapshotOf()
    const dayChange = valued.coverage.perMetric.find((m) => m.metric === 'day_change')!
    expect(dayChange.coveredMinor).toBe('0')
    expect(dayChange.pct).toBe('0.00')
  })
})

// ---------------------------------------------------------------------------
// The input that separates `cost_basis` from `unrealised_pnl`, and the reason no coverage figure
// can show that it has.
// ---------------------------------------------------------------------------

describe('a measured holding the price table cannot price', () => {
  function valued() {
    const result = valuePortfolio(measuredUnpricedInput())
    if (!result.ok) throw new Error(`valuation failed: ${result.error.message}`)
    return result.value
  }

  it('keeps a measured cost while having no market value, no P&L and no weight', () => {
    const pair = valued().pairs.find((p) => p.instrumentId === 'unpriced')!
    // Measured, not snapshot: the lot chain is complete. `costInInr` converts each lot at its own
    // acquisition-date rate and never asks for a price, so the cost survives the missing row.
    expect(pair.measurement).toBe('measured')
    expect(pair.costMinor.measured && pair.costMinor.value).toBe('500000')
    expect(pair.marketValue.measured).toBe(false)
    expect(pair.unrealised.measured).toBe(false)
  })

  it('puts that pair inside cost_basis and outside unrealised_pnl', () => {
    const metrics = valued().coverage.perMetric
    const cost = metrics.find((m) => m.metric === 'cost_basis')!
    const pnl = metrics.find((m) => m.metric === 'unrealised_pnl')!
    expect(cost.excludedPairs.map((p) => p.instrumentId)).toEqual([])
    expect(pnl.excludedPairs.map((p) => p.instrumentId)).toEqual(['unpriced'])
  })

  it('reports the two at identical coverage, because the divergence is worth exactly zero', () => {
    const metrics = valued().coverage.perMetric
    const cost = metrics.find((m) => m.metric === 'cost_basis')!
    const pnl = metrics.find((m) => m.metric === 'unrealised_pnl')!
    /*
     * This is why the defect above it was invisible for as long as it was. Coverage is weighted by
     * *market value*, and the market value of a pair that could not be priced is zero — so the pair
     * that is in one population and not the other moves neither figure. Two badges reading 100.00%
     * of ₹1,50,000 sit beside two rupee figures summed over different sets of holdings.
     *
     * Nothing here is wrong. It is the reason a consumer of these metrics may not form a ratio out
     * of one metric's numerator and another's denominator, and `sumPnlCost` in
     * `src/screens/view-model.ts` is where that rule is now enforced.
     */
    expect(cost.coveredMinor).toBe(pnl.coveredMinor)
    expect(cost.pct).toBe(pnl.pct)
    expect(cost.pct).toBe('100.00')

    // The rupee cost each population carries, which is where they differ: ₹1,05,000 against
    // ₹1,00,000, on the same portfolio, at the same coverage.
    const pairs = valued().pairs
    const measuredCost = addMinor(
      ...pairs.map((p) => (p.costMinor.measured ? p.costMinor.value : minor('0'))),
    )
    const pnlCost = addMinor(
      ...pairs.map((p) => (p.unrealised.measured ? p.unrealised.value.costMinor : minor('0'))),
    )
    expect(measuredCost).toBe('10500000')
    expect(pnlCost).toBe('10000000')
  })
})

describe('a portfolio that is entirely unresolved', () => {
  it('reports zero net worth with a non-zero withheld figure', () => {
    const instruments = instrumentMap(infy)
    const prices = new PriceService({
      store: new InMemoryPriceStore(),
      instruments,
      now: () => AS_OF,
    })
    const result = valuePortfolio({
      accounts: [],
      instruments,
      prices,
      fx: new FxTable([]),
      unresolved,
      asOf: AS_OF,
    })
    if (!result.ok) throw new Error('valuation failed')
    expect(result.value.netWorthMinor).toBe('0')
    expect(result.value.coverage.withheldMinor).toBe('4500000')
    // Null, not 0%: there is nothing to cover, which is not the same as covering nothing.
    expect(result.value.coverage.historyCoveragePct).toBeNull()
  })
})

describe('XIRR scopes', () => {
  it('refuses a scope containing an unmeasured pair instead of answering a different question', () => {
    const { snapshot: valued, prices, fx } = snapshotOf()
    const result = xirrForScope({
      scope: { kind: 'portfolio' },
      pairs: valued.pairs,
      accounts: accounts(),
      fx,
      prices,
      asOf: AS_OF,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('SCOPE_NOT_MEASURED')
    if (result.error.code !== 'SCOPE_NOT_MEASURED') return
    // Only the snapshot holding is unmeasured. The unpriced bond is measured — it has a complete
    // lot chain — and would fail later, at MISSING_PRICE, which is a different remedy for the user.
    expect(result.error.pairs.map((p) => p.instrumentId)).toEqual(['fund'])
  })

  it('computes a rate for a fully measured pair', () => {
    const { snapshot: valued, prices, fx } = snapshotOf()
    const result = xirrForScope({
      scope: { kind: 'pair', accountId: 'acc-ledger', instrumentId: 'infy' },
      pairs: valued.pairs,
      accounts: accounts(),
      fx,
      prices,
      asOf: AS_OF,
    })
    if (!result.ok) throw new Error(`expected a rate, got ${result.error.code}`)
    // ₹1,00,000 in on 2024-01-10, ₹1,50,000 of value on 2026-08-12: about 17% a year.
    expect(result.value.uniquenessGuaranteed).toBe(true)
    expect(result.value.rate.startsWith('0.16')).toBe(true)
  })
})

describe('a realised gain on a US holding, in a snapshot denominated in rupees', () => {
  // Worth doing end to end: `realised` is rendered beside `netWorthMinor`, and `netWorthMinor` is
  // paise. A disposal that reported cents put ₹1,000 on the dashboard where the truth was ₹87,000 —
  // understated eighty-sevenfold, netted against genuine rupee gains in the same sum, fully
  // `measured`, at full coverage, with no reason shown anywhere.
  function usPortfolio() {
    const instruments = instrumentMap(infy, aapl)
    const store = new InMemoryPriceStore()
    store.put(price('infy', '1500.00', '2026-08-12'))
    store.put(price('aapl', '200.00', '2026-08-12', 'USD'))
    const prices = new PriceService({ store, instruments, now: () => AS_OF })
    const fx = new FxTable([
      { base: 'USD', quote: 'INR', asOf: '2024-01-10', rate: dec('83.00'), source: 'seed' },
      { base: 'USD', quote: 'INR', asOf: '2026-05-10', rate: dec('86.00'), source: 'seed' },
      { base: 'USD', quote: 'INR', asOf: '2026-06-12', rate: dec('87.00'), source: 'seed' },
      { base: 'USD', quote: 'INR', asOf: '2026-08-12', rate: dec('88.00'), source: 'seed' },
    ])
    resetIds()
    const rupees: FoldInput = {
      accountId: 'acc-inr',
      capability: 'ledger',
      txns: [
        txn({ type: 'buy', date: '2024-01-10', quantity: '100', amount: '10000000', instrumentId: 'infy', accountId: 'acc-inr' }),
      ],
      snapshots: [],
      instruments,
      asOf: AS_OF,
    }
    const dollars: FoldInput = {
      accountId: 'acc-usd',
      capability: 'ledger',
      txns: [
        // 20 shares at $100.
        txn({ type: 'buy', date: '2024-01-10', quantity: '20', amount: '200000', currency: 'USD', instrumentId: 'aapl', accountId: 'acc-usd' }),
        // 10 shares at $200: a $1,000 gain, realised on a day the dollar was worth ₹87.
        txn({ type: 'sell', date: '2026-06-12', quantity: '10', amount: '200000', currency: 'USD', instrumentId: 'aapl', accountId: 'acc-usd' }),
        // A $50 dividend, on a day the dollar was worth ₹86.
        txn({ type: 'dividend', date: '2026-05-10', quantity: '0', amount: '5000', currency: 'USD', instrumentId: 'aapl', accountId: 'acc-usd' }),
      ],
      snapshots: [],
      instruments,
      asOf: AS_OF,
    }
    const result = valuePortfolio({
      accounts: [rupees, dollars],
      instruments,
      prices,
      fx,
      unresolved: [],
      asOf: AS_OF,
    })
    if (!result.ok) throw new Error(`valuation failed: ${result.error.message}`)
    return result.value
  }

  it('reports the gain in the same units as the net worth it is shown beside', () => {
    const valued = usPortfolio()
    const foreign = valued.realised.byRegime.get('foreign_equity')!
    expect(foreign.ltcgMinor).toBe('8700000')
    expect(valued.realised.currency).toBe('INR')
    // ₹1,00,000 of Infosys plus 10 shares at $200 × ₹88.
    expect(valued.netWorthMinor).toBe('32600000')
  })

  it('converts dividend income at each row’s own date rather than summing cents into paise', () => {
    const valued = usPortfolio()
    const dividend = valued.realised.dividendIncomeMinor
    // $50 at ₹86 is ₹4,300. Unconverted it accumulated as 5000, which reads as ₹50.
    expect(dividend.measured && dividend.value).toBe('430000')
  })

  it('keeps realised P&L at full coverage, because nothing here is withheld', () => {
    const valued = usPortfolio()
    expect(valued.realisedCoverage.excludedValueMinor).toBe('0')
    expect(valued.disposals.every((d) => d.currency === 'INR')).toBe(true)
  })

  it('withholds both the gain and the dividend when no rate covers their dates', () => {
    const instruments = instrumentMap(aapl)
    const store = new InMemoryPriceStore()
    store.put(price('aapl', '200.00', '2026-08-12', 'USD'))
    const prices = new PriceService({ store, instruments, now: () => AS_OF })
    // Only a current rate: neither the 2026-06-12 disposal nor the 2026-05-10 dividend has one
    // within `MAX_FX_BACKFILL_DAYS`, and today's rate is not allowed to stand in for either.
    const fx = new FxTable([
      { base: 'USD', quote: 'INR', asOf: '2026-08-12', rate: dec('88.00'), source: 'seed' },
    ])
    resetIds()
    const dollars: FoldInput = {
      accountId: 'acc-usd',
      capability: 'ledger',
      txns: [
        txn({ type: 'buy', date: '2024-01-10', quantity: '20', amount: '200000', currency: 'USD', fxRate: '83.00', instrumentId: 'aapl', accountId: 'acc-usd' }),
        txn({ type: 'sell', date: '2026-06-12', quantity: '10', amount: '200000', currency: 'USD', instrumentId: 'aapl', accountId: 'acc-usd' }),
        txn({ type: 'dividend', date: '2026-05-10', quantity: '0', amount: '5000', currency: 'USD', instrumentId: 'aapl', accountId: 'acc-usd' }),
      ],
      snapshots: [],
      instruments,
      asOf: AS_OF,
    }
    const result = valuePortfolio({
      accounts: [dollars],
      instruments,
      prices,
      fx,
      unresolved: [],
      asOf: AS_OF,
    })
    if (!result.ok) throw new Error('valuation failed')
    const valued = result.value
    expect(valued.realised.byRegime.size).toBe(0)
    expect(valued.realised.unavailableDisposals[0]!.reason).toBe('NO_FX_RATE')
    expect(valued.realised.dividendIncomeMinor.measured).toBe(false)
    // The holding itself is still valued — 10 shares at $200 × ₹88 — because present value uses the
    // current rate, which exists. Only the figures needing a historical rate are withheld.
    expect(valued.netWorthMinor).toBe('17600000')
    expect(valued.realisedCoverage.coveredMinor).toBe('0')
  })
})
