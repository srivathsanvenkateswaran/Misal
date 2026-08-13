/**
 * The view-model, against the whole pipeline.
 *
 * These assert figures rather than shapes. Types agreeing proves nothing about arithmetic, and the
 * arithmetic is the product: a coverage split that is off by a rupee is a trust indicator that
 * lies. Every expected value below is derived by hand from the fixture, not copied from a run.
 */

import { describe, expect, it } from 'vitest'
import { addMinor, minor } from '@domain/numeric'
import type {
  AccountRow,
  FxRateRow,
  InstrumentRow,
  PortfolioRows,
  PositionRow,
  PriceRow,
  TxnRow,
} from '../data/client'
import { formatFigure } from '@ui/figure'
import { buildPortfolioView } from './view-model'
import {
  ACCOUNTS,
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

const NO_FEES = {
  brokerageMinor: '0',
  sttMinor: '0',
  gstMinor: '0',
  stampDutyMinor: '0',
  otherFeesMinor: '0',
  tdsMinor: '0',
} as const

// ---------------------------------------------------------------------------
// A foreign holding with a transaction history, which the shipped fixture has not got.
//
// The RSU accounts this product exists to consolidate report in dollars, and their transactions
// carry no per-row `fx_rate` — the rate has to come from the stored daily table. That combination
// is what an empty `FxTable` breaks, and it breaks it for the rupee holdings beside it too, since
// XIRR is solved over the whole scope at once.
// ---------------------------------------------------------------------------

interface UsdTrade {
  readonly id: string
  readonly date: string
  readonly units: bigint
  readonly price: string
}

const CAT_TRADES: readonly UsdTrade[] = [
  { id: 'v1', date: '2024-11-14', units: 12n, price: '310.0000' },
  { id: 'v2', date: '2025-06-03', units: 10n, price: '340.0000' },
  { id: 'v3', date: '2026-02-19', units: 12n, price: '360.0000' },
]

/** Cents: units × price, in exact integer maths on the stored digits. */
function cents(price: string, units: bigint): string {
  return ((BigInt(price.replace('.', '')) * units) / 100n).toString()
}

function catTxns(): readonly TxnRow[] {
  return CAT_TRADES.map((trade, index) => ({
    id: `t-cat-${trade.id}`,
    accountId: 'a-etrade',
    instrumentId: 'i-cat',
    type: 'buy',
    occurredAt: `${trade.date}T09:30:00-05:00`,
    occurredTz: 'America/New_York',
    quantity: `${trade.units.toString()}.0000`,
    price: trade.price,
    amountMinor: cents(trade.price, trade.units),
    ...NO_FEES,
    currency: 'USD',
    // The point of the fixture: no per-row rate, so the daily table is the only source.
    fxRate: null,
    sourceDocumentId: 'd-etr-1',
    naturalKey: `etrade:cat:${trade.id}`,
    occurrence: index,
    authority: 'primary',
    createdAt: '2026-08-12T10:44:00+05:30',
  }))
}

const USD_INR: readonly FxRateRow[] = [
  { base: 'USD', quote: 'INR', asOf: '2024-11-14', rate: '84.2500', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2025-06-03', rate: '85.1000', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2026-02-19', rate: '86.4000', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2026-08-11', rate: '87.5000', source: 'manual' },
]

/**
 * The E*TRADE account promoted to a ledger, with the dollar rates its transactions need.
 *
 * `omitRatesBefore` drops the stored rates on and before a date, leaving the latest one in place:
 * the holding still values (present value uses the latest rate) but one old vest can no longer be
 * dated, which is the state `refresh.ts` actually leaves behind since it fetches only `latest`.
 */
function foreignLedgerRows(omitRatesBefore?: string): PortfolioRows {
  const base = portfolioRows()
  return portfolioRows({
    accounts: ACCOUNTS.map((account) =>
      account.id === 'a-etrade' ? { ...account, capability: 'ledger' as const } : account,
    ),
    transactions: [...base.transactions, ...catTxns()],
    positions: base.positions.filter((row) => row.accountId !== 'a-etrade'),
    fxRates:
      omitRatesBefore === undefined
        ? USD_INR
        : USD_INR.filter((row) => row.asOf > omitRatesBefore),
  })
}

// ---------------------------------------------------------------------------
// More than ten priced positions, which no shipped fixture has — and so the concentration
// chart's "Other" bucket had never once been built.
// ---------------------------------------------------------------------------

const TAIL_ACCOUNTS: readonly AccountRow[] = [
  {
    id: 'a-many',
    providerId: 'zerodha-kite',
    label: 'Kite — many holdings',
    externalRef: 'ZR0001',
    identityKey: 'ucc:ZR0001',
    capability: 'ledger',
    baseCurrency: 'INR',
    createdAt: '2024-08-01T00:00:00+05:30',
    providerShortCode: 'KIT',
  },
  {
    id: 'a-tail',
    providerId: 'augmont',
    label: 'Tail holdings, statement only',
    externalRef: null,
    identityKey: null,
    capability: 'snapshot',
    baseCurrency: 'INR',
    createdAt: '2024-08-01T00:00:00+05:30',
    providerShortCode: 'GRW',
  },
]

const TAIL_SIZE = 12

/** `close` in rupees for holding `index`, strictly descending so the ranking is unambiguous. */
function tailClose(index: number): string {
  return `${((TAIL_SIZE - index) * 100).toString()}.00`
}

/**
 * Twelve priced positions of descending value, the smallest held either as a ledger holding or as
 * a statement-only one. Ten fill the chart; the last two roll into "Other", so the bucket's basis
 * is decided by the twelfth.
 */
function concentrationRows(tail: 'ledger' | 'snapshot'): PortfolioRows {
  const instruments: InstrumentRow[] = []
  const prices: PriceRow[] = []
  const transactions: TxnRow[] = []
  const positions: PositionRow[] = []

  for (let index = 0; index < TAIL_SIZE; index += 1) {
    const id = `i-c${index.toString().padStart(2, '0')}`
    const close = tailClose(index)
    const last = index === TAIL_SIZE - 1
    instruments.push({
      id,
      assetClass: 'indian_equity',
      taxRegime: 's112a_listed_equity',
      displayName: `Holding ${index.toString().padStart(2, '0')}`,
      isin: null,
      currency: 'INR',
      precision: 0,
      fmv31Jan2018: null,
    })
    prices.push({
      instrumentId: id,
      asOf: '2026-08-11',
      close,
      currency: 'INR',
      source: 'twelvedata',
      fetchedAt: '2026-08-12T10:52:00+05:30',
    })
    if (last && tail === 'snapshot') {
      positions.push({
        id: `p-${id}`,
        accountId: 'a-tail',
        instrumentId: id,
        quantity: '10',
        asOf: '2026-08-10T00:00:00+05:30',
        sourceDocumentId: 'd-tail-1',
      })
      continue
    }
    transactions.push({
      id: `t-${id}`,
      accountId: 'a-many',
      instrumentId: id,
      type: 'buy',
      occurredAt: '2025-01-15T09:30:00+05:30',
      occurredTz: 'Asia/Kolkata',
      quantity: '10',
      price: close,
      amountMinor: (BigInt(close.replace('.', '')) * 10n).toString(),
      ...NO_FEES,
      currency: 'INR',
      fxRate: null,
      sourceDocumentId: 'd-many-1',
      naturalKey: `kite:${id}`,
      occurrence: index,
      authority: 'primary',
      createdAt: '2026-08-12T09:12:00+05:30',
    })
  }

  return portfolioRows({
    accounts: TAIL_ACCOUNTS,
    instruments,
    aliases: [],
    transactions,
    positions,
    prices,
    unresolved: [],
  })
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

  it('reports the age of the exchange rate the way it reports the age of a price', () => {
    /*
     * The residual the FX-bound fix left open, and it was the quieter half of the same defect.
     * `FxTable.latest` refuses a rate older than seven days, so above the bound the holding leaves
     * net worth loudly — but below it the conversion happened and *nothing said how old the rate
     * was*. A week-old price was counted in `stalePriceCount`, hatched and named; a week-old rate
     * moved every foreign total by whatever the currency had done in that time and was silent.
     *
     * The dollar price here is one day old, so everything below comes from the rate alone.
     */
    const stale = foreignLedgerRows()
    const rows = portfolioRows({
      ...stale,
      fxRates: stale.fxRates.map((row) =>
        row.asOf === '2026-08-11' ? { ...row, asOf: '2026-08-06' } : row,
      ),
    })
    const data = buildPortfolioView(rows, AS_OF)
    if (!data.ok) throw new Error(data.message)

    const cat = data.data.positions.find((position) => position.name === 'Caterpillar Inc')
    // Six days, which is inside the seven-day bound: the holding is still converted and still in
    // net worth. That is precisely the band in which nothing used to be said.
    expect(cat?.priced).toBe(true)
    expect(cat?.staleDays).toBe(6)
    expect(cat?.priceNote).toContain('rate 6 d old')
    expect(cat?.stamp.alert).toBe(true)

    const quality = data.data.dataQuality
    expect(quality.staleNote).toContain('USD/INR rate 6 d')
    // One entry per rate rather than per holding: there is one USD/INR rate and one thing wrong.
    expect(quality.stalePrices).toBeGreaterThan(0)

    const fresh = buildPortfolioView(foreignLedgerRows(), AS_OF)
    if (!fresh.ok) throw new Error(fresh.message)
    expect(quality.stalePrices).toBe(fresh.data.dataQuality.stalePrices + 1)
    expect(
      fresh.data.positions.find((position) => position.name === 'Caterpillar Inc')?.staleDays,
    ).toBeUndefined()
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

describe('XIRR and the stored FX table', () => {
  it('computes a portfolio XIRR from the stored daily rates rather than withholding it', () => {
    const data = ready(foreignLedgerRows())
    // Handed an empty table, the one dollar vest returns MISSING_FX and takes the rupee holdings
    // down with it, because the rate is solved over the whole scope at once.
    expect(data.readout.xirr.measured).toBe(true)
    if (data.readout.xirr.measured) {
      expect(formatFigure(data.readout.xirr.value)).toBe('13.01%')
    }
    expect(data.readout.xirrNote).toMatch(/cash flows over \d+ days/u)
  })

  it('computes the same XIRR for the foreign instrument itself', () => {
    const data = ready(foreignLedgerRows())
    const cat = data.instruments.find((instrument) => instrument.name === 'Caterpillar Inc')
    expect(cat?.xirr.measured).toBe(true)
    if (cat?.xirr.measured === true) {
      expect(formatFigure(cat.xirr.value)).toBe('13.09%')
    }
  })

  it('agrees with the coverage panel it sits beside', () => {
    const data = ready(foreignLedgerRows())
    // `pairFxUsable` counts a pair as XIRR-eligible when the daily table can date its
    // transactions. A blank figure beside a non-zero coverage percentage was the visible symptom.
    const xirrCoverage = data.coverageByMetric.find((entry) => entry.key === 'xirr')
    expect(xirrCoverage?.pct).toBe('88.85')
    expect(data.readout.xirr.measured).toBe(true)
  })

  it('names a missing rate as a missing rate, not as absent transaction history', () => {
    // Every rate before 2026 is gone, so the 2024 vest cannot be dated. The holding still values
    // — the latest rate is stored — so this is squarely a rate gap, not a history gap.
    const data = ready(foreignLedgerRows('2026-01-01'))
    expect(data.readout.xirr.measured).toBe(false)
    if (!data.readout.xirr.measured) {
      expect(data.readout.xirr.reason).toBe('no_fx_rate')
    }
    const cat = data.instruments.find((instrument) => instrument.name === 'Caterpillar Inc')
    expect(cat?.xirr.measured).toBe(false)
    if (cat?.xirr.measured === false) {
      // The instrument screen prints this reason directly above the lot table listing the very
      // transactions it would otherwise deny.
      expect(cat.xirr.reason).toBe('no_fx_rate')
      expect(cat.lots.length).toBeGreaterThan(0)
    }
  })
})

describe('the concentration chart’s "Other" bucket', () => {
  it('rolls the tail into one row once there are more than ten priced positions', () => {
    const data = ready(concentrationRows('ledger'))
    expect(data.positions.filter((position) => position.priced)).toHaveLength(TAIL_SIZE)
    const other = data.concentration.find((row) => row.key === 'other')
    expect(other?.label).toBe(`Other (${(TAIL_SIZE - 10).toString()} positions)`)
  })

  it('draws the bucket as snapshot-only when any holding inside it has no history', () => {
    const data = ready(concentrationRows('snapshot'))
    const other = data.concentration.find((row) => row.key === 'other')
    expect(other?.basis).toBe('snapshot')
  })

  it('keeps it ledger-backed when every holding inside it is', () => {
    const data = ready(concentrationRows('ledger'))
    const other = data.concentration.find((row) => row.key === 'other')
    expect(other?.basis).toBe('ledger')
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
