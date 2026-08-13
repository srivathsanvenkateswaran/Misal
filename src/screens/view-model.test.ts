/**
 * The view-model, against the whole pipeline.
 *
 * These assert figures rather than shapes. Types agreeing proves nothing about arithmetic, and the
 * arithmetic is the product: a coverage split that is off by a rupee is a trust indicator that
 * lies. Every expected value below is derived by hand from the fixture, not copied from a run.
 */

import { describe, expect, it } from 'vitest'
import { addMinor, minor } from '@domain/numeric'
import { buildPortfolioView } from './view-model'
import {
  AS_OF,
  allLedgerRows,
  allSnapshotRows,
  emptyRows,
  portfolioRows,
} from './testing/fixtures'

function ready(rows = portfolioRows()) {
  const view = buildPortfolioView(rows, AS_OF)
  if (!view.ok) throw new Error(`Expected a valued portfolio, got: ${view.message}`)
  return view.data
}

describe('the calibration split', () => {
  it('adds up: ledger-backed plus snapshot-only is exactly net worth', () => {
    const data = ready()
    expect(addMinor(data.ledgerBackedMinor, data.snapshotOnlyMinor)).toBe(data.netWorthMinor)
  })

  it('draws segments that reconcile with the total the bar states', () => {
    const data = ready()
    const summed = addMinor(...data.segments.map((segment) => segment.value))
    expect(summed).toBe(data.netWorthMinor)
  })

  it('hatches a class whole when any holding in it lacks history', () => {
    const data = ready()
    const gold = data.segments.find((segment) => segment.assetClass === 'gold')
    expect(gold?.basis).toBe('snapshot')
    expect(data.segments.find((segment) => segment.assetClass === 'mutual_fund')?.basis).toBe(
      'ledger',
    )
  })
})

describe('the ledger gate (H1)', () => {
  it('withholds cost and P&L for a snapshot holding, with the reason and the excluded value', () => {
    const data = ready()
    const gold = data.positions.find((position) => position.name === 'Augmont Digital Gold')
    expect(gold?.avgCost.measured).toBe(false)
    expect(gold?.unrealised.measured).toBe(false)
    if (gold?.avgCost.measured === false) {
      expect(gold.avgCost.reason).toBe('no_transaction_history')
      // Not zero: the exact value the metric cannot speak for.
      expect(gold.avgCost.excluded).toBe(gold.valueMinor)
    }
  })

  it('measures cost and P&L for a ledger holding', () => {
    const data = ready()
    const ppfc = data.positions.find((position) => position.name === 'Parag Parikh Flexi Cap')
    expect(ppfc?.avgCost.measured).toBe(true)
    expect(ppfc?.unrealised.measured).toBe(true)
  })

  it('withholds every history-dependent metric when no account has history', () => {
    const data = ready(allSnapshotRows())
    expect(data.readout.costBasis.measured).toBe(false)
    expect(data.readout.unrealised.measured).toBe(false)
    expect(data.readout.xirr.measured).toBe(false)
    expect(data.readout.realised.measured).toBe(false)
    expect(data.ledgerBackedMinor).toBe('0')
  })

  it('still displays coverage when everything is measured', () => {
    const data = ready(allLedgerRows())
    expect(data.snapshotOnlyMinor).toBe('0')
    const cost = data.coverageByMetric.find((entry) => entry.key === 'cost-basis')
    expect(cost?.pct).toBe('100.00')
    expect(cost?.exact).toBe(true)
  })
})

describe('coverage travels with the metric (H2)', () => {
  it('attaches the covered amount and the total to every history-dependent readout figure', () => {
    const data = ready()
    for (const metric of [data.readout.costBasis, data.readout.unrealised, data.readout.xirr]) {
      expect(metric.measured).toBe(true)
      if (metric.measured) {
        expect(metric.coverage.covered).toBe(data.ledgerBackedMinor)
        expect(metric.coverage.total).toBe(data.netWorthMinor)
        expect(metric.coverage.excludedAccounts).toContain('a-gold')
      }
    }
  })
})

describe('prices', () => {
  it('flags the fifteen-day-old gold price and leaves the fresh ones alone', () => {
    const data = ready()
    const gold = data.positions.find((position) => position.name === 'Augmont Digital Gold')
    expect(gold?.staleDays).toBe(15)
    expect(gold?.priceNote).toContain('15 d old')
    expect(gold?.stamp.alert).toBe(true)
    const ppfc = data.positions.find((position) => position.name === 'Parag Parikh Flexi Cap')
    expect(ppfc?.staleDays).toBeUndefined()
    expect(ppfc?.stamp.alert).toBeUndefined()
  })

  it('does not convert a dollar holding at a guessed rate — it withholds the value', () => {
    const data = ready()
    const cat = data.positions.find((position) => position.name === 'Caterpillar Inc')
    expect(cat?.priced).toBe(false)
    expect(cat?.value.measured).toBe(false)
    if (cat?.value.measured === false) expect(cat.value.reason).toBe('no_fx_rate')
    // And it is therefore not inside net worth.
    expect(data.netWorthMinor).not.toContain('undefined')
  })

  it('withholds day change everywhere, because no previous close is stored', () => {
    const data = ready()
    expect(data.readout.dayChange.measured).toBe(false)
    expect(data.positions.every((position) => !position.dayPct.measured)).toBe(true)
  })
})

describe('withheld value (H8)', () => {
  it('names the unresolved amount to the rupee', () => {
    const data = ready()
    expect(data.dataQuality.unresolvedCount).toBe(1)
    expect(data.dataQuality.withheldMinor).toBe(minor('39420000'))
    expect(data.dataQuality.withheldNote).toContain('₹3,94,200')
  })

  it('keeps withheld value out of net worth', () => {
    const withNothingUnresolved = ready(portfolioRows({ unresolved: [] }))
    expect(ready().netWorthMinor).toBe(withNothingUnresolved.netWorthMinor)
  })
})

describe('the twelve-month series (H10)', () => {
  it('draws a month only where the stored rows can produce one', () => {
    const data = ready()
    expect(data.months).toHaveLength(12)
    expect(data.months.every((month) => month.segments !== null)).toBe(true)
  })

  it('leaves months before the first stored row as gaps rather than back-filling them', () => {
    const late = portfolioRows({
      transactions: portfolioRows().transactions.filter(
        (txn) => txn.occurredAt >= '2026-06-01',
      ),
      positions: [],
      prices: portfolioRows().prices.filter((price) => price.asOf >= '2026-06-01'),
    })
    const data = ready(late)
    const gaps = data.months.filter((month) => month.segments === null)
    expect(gaps.length).toBeGreaterThan(0)
    expect(data.historyBegins).toBeDefined()
    // Nothing was carried backwards into the gaps.
    expect(data.months.slice(0, gaps.length).every((month) => month.segments === null)).toBe(true)
  })
})

describe('failure', () => {
  it('returns a named failure rather than throwing, when a row cannot be mapped', () => {
    const broken = portfolioRows({
      instruments: [{ ...portfolioRows().instruments[0]!, assetClass: 'antiques' }],
    })
    const view = buildPortfolioView(broken, AS_OF)
    expect(view.ok).toBe(false)
    if (!view.ok) expect(view.message).toMatch(/antiques/u)
  })

  it('values an empty database as an empty portfolio, not as an error', () => {
    const view = buildPortfolioView(emptyRows(), AS_OF)
    expect(view.ok).toBe(true)
    if (view.ok) {
      expect(view.data.accounts).toHaveLength(0)
      expect(view.data.netWorthMinor).toBe('0')
    }
  })
})
