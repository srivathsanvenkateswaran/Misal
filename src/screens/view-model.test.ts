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
  UnresolvedRow,
} from '../data/client'
import { formatFigure } from '@ui/figure'
import { buildPortfolioView } from './view-model'
import {
  ACCOUNTS,
  AS_OF,
  TRANSACTIONS,
  allLedgerRows,
  allSnapshotRows,
  emptyRows,
  freshInstallRows,
  nearlyFullCoverageRows,
  noPricesRows,
  partlyPricedAccountRows,
  portfolioRows,
  subPaisaRows,
  unpricedSnapshotRows,
  usdLedgerRows,
  zeroQuantityRows,
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

/**
 * A dollar close at two past month ends, with a rate that is current for the first and not the
 * second. Nothing in the shipped corpus prices a foreign holding at a *past* month end, which is
 * why the monthly series could convert the whole of history at today's rate unchallenged.
 */
const CAT_MONTH_END_PRICES: readonly PriceRow[] = [
  {
    instrumentId: 'i-cat',
    asOf: '2025-09-30',
    close: '300.0000',
    currency: 'USD',
    source: 'twelvedata',
    fetchedAt: '2025-09-30T20:00:00+05:30',
  },
  {
    instrumentId: 'i-cat',
    asOf: '2025-10-31',
    close: '305.0000',
    currency: 'USD',
    source: 'twelvedata',
    fetchedAt: '2025-10-31T20:00:00+05:30',
  },
]

/**
 * Two stored rates, eleven months apart — the reviewers' pair, and the shape a real table takes
 * when `refresh.ts` fetches only `latest`: one rate from around the time the statement was
 * imported, and one from today.
 */
const REWIND_FX: readonly FxRateRow[] = [
  { base: 'USD', quote: 'INR', asOf: '2025-09-29', rate: '83.0000', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2026-08-12', rate: '88.0000', source: 'manual' },
]

// ---------------------------------------------------------------------------
// Unresolved rows with no stated value — the shape `record_unresolved` actually writes, and the
// one the shipped fixture has never carried: its single row states both a value and a currency.
// ---------------------------------------------------------------------------

const NULL_VALUED_UNRESOLVED: readonly UnresolvedRow[] = [
  {
    id: 'u-coin-1',
    accountId: 'a-etrade',
    rawIdentifier: 'provider-local:XPLA',
    rawName: null,
    assetClassHint: 'crypto',
    observedQuantity: '412.0000',
    observedValueMinor: null,
    currency: null,
    firstSeenAt: '2026-08-09T21:03:00+05:30',
  },
  {
    id: 'u-coin-2',
    accountId: 'a-etrade',
    rawIdentifier: 'provider-local:JASMY',
    rawName: null,
    assetClassHint: 'crypto',
    observedQuantity: '9000.0000',
    observedValueMinor: null,
    currency: null,
    firstSeenAt: '2026-08-09T21:03:00+05:30',
  },
]

const STATED_UNRESOLVED: UnresolvedRow = {
  id: 'u-stated',
  accountId: 'a-etrade',
  rawIdentifier: 'isin:INF179K01YV8',
  rawName: 'An unrecognised scheme',
  assetClassHint: 'mutual_fund',
  observedQuantity: '1200.0000',
  observedValueMinor: '11864000',
  currency: 'INR',
  firstSeenAt: '2026-08-09T21:03:00+05:30',
}

function fxRewindRows(): PortfolioRows {
  const base = foreignLedgerRows()
  return portfolioRows({
    ...base,
    prices: [...base.prices, ...CAT_MONTH_END_PRICES],
    fxRates: REWIND_FX,
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

  it('never states ₹0 withheld for rows whose source stated no value', () => {
    /*
     * The *default* for an exchange sync: `record_unresolved` inserts neither
     * `observed_value_minor` nor `currency`, so every coin it cannot name is NULL/NULL. A
     * tradebook with no valuation column reaches the same place. Two of them used to print
     * "Unresolved instruments: 2" directly above "₹0 withheld from every total" — a zero standing
     * in for an amount nobody knows, which is the one substitution the review queue exists to stop.
     */
    const data = ready(portfolioRows({ unresolved: NULL_VALUED_UNRESOLVED }))
    expect(data.dataQuality.unresolvedCount).toBe(2)
    expect(data.dataQuality.withheldNote).toContain('unknown, not zero')
    expect(data.dataQuality.withheldNote).toContain('the source stated no value')
    expect(data.dataQuality.withheldNote).not.toContain('₹0')
    expect(data.dataQuality.withheldNote).not.toMatch(/withheld from every total/u)
  })

  it('says what a stated total leaves out when only some rows state a value', () => {
    // The sharper case: one row carries ₹1,18,640 and two carry nothing, so an unqualified
    // "₹1,18,640 withheld" is an exact-looking figure for two thirds of the rows.
    const data = ready(
      portfolioRows({ unresolved: [STATED_UNRESOLVED, ...NULL_VALUED_UNRESOLVED] }),
    )
    expect(data.dataQuality.unresolvedCount).toBe(3)
    expect(data.dataQuality.withheldMinor).toBe(minor('11864000'))
    expect(data.dataQuality.withheldNote).toContain('₹1,18,640 withheld from every total')
    expect(data.dataQuality.withheldNote).toContain(
      'plus 2 whose amount the source did not state',
    )
  })

  it('agrees with the review queue: a foreign row is counted, never folded into the rupee total', () => {
    const data = ready(
      portfolioRows({
        unresolved: [
          STATED_UNRESOLVED,
          { ...STATED_UNRESOLVED, id: 'u-usd', currency: 'USD', observedValueMinor: '150000' },
        ],
      }),
    )
    expect(data.dataQuality.withheldMinor).toBe(minor('11864000'))
    expect(data.dataQuality.withheldNote).toContain('plus 1 in a currency this total cannot absorb')
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

  it('converts a past month at that month’s stored rate, not at today’s', () => {
    /*
     * `rowsAsAt` filtered transactions, positions and prices and spread `...rows` for the rest, so
     * `fxRates` still held every rate up to today. `FxTable.latest` returns the newest row it has
     * and its age guard is one-sided — a rate dated *after* the valuation date is not stale, by
     * design — so a negative age always passed and every past month converted at today's rate
     * while the prices beside it were that month's closes. The currency leg of the whole chart was
     * flat by construction, and nothing on the column said so. Crypto rides on this too: those
     * pairs carry `X:USDT`.
     *
     * September 2025 holds 22 CAT at $300. The rate stored two days earlier is ₹83.00, and the
     * only other stored rate is today's ₹88.00.
     */
    const data = ready(fxRewindRows())
    const september = data.months.find((month) => month.key === '2025-09-30')
    const us = september?.segments?.find((segment) => segment.assetClass === 'us_equity')
    // 22 × $300 × ₹83.00 = ₹5,47,800.
    expect(us?.value).toBe(minor('54780000'))
    // What it used to draw: 22 × $300 × ₹88.00 = ₹5,80,800, dated from the future.
    expect(us?.value).not.toBe(minor('58080000'))
  })

  it('drops a foreign holding out of a month it cannot date, rather than dating it from today', () => {
    // October 2025 has a dollar close of its own, and the newest rate it can see is 32 days old —
    // past `MAX_FX_LATEST_AGE_DAYS`. The stated preference is that the holding leaves the column.
    const data = ready(fxRewindRows())
    const october = data.months.find((month) => month.key === '2025-10-31')
    expect(october?.segments?.some((segment) => segment.assetClass === 'us_equity')).toBe(false)
    // And the column says it is short of a holding rather than presenting itself as complete.
    expect(october?.unpricedCount).toBe(1)
  })

  it('marks a month whose stored rows priced only part of what was held', () => {
    /*
     * There is no historical price backfill in this product: price rows begin the day an
     * instrument is first refreshed, while the fold produces holdings for every month the
     * transactions cover. Here CAT is held from November 2024 and priced only from 2026-08-11, so
     * eleven columns omit the whole of US equity — and used to draw at full height with an exact
     * rupee total in the accessible table and no mark of any kind.
     */
    const data = ready(foreignLedgerRows())
    const july = data.months.find((month) => month.key === '2026-07-31')
    expect(july?.unpricedCount).toBe(1)
    expect(july?.segments?.some((segment) => segment.assetClass === 'us_equity')).toBe(false)
    // ₹7,77,565 drawn, over a portfolio that also held 34 CAT that month.
    expect(addMinor(...(july?.segments ?? []).map((segment) => segment.value))).toBe(
      minor('77756500'),
    )

    // The month pricing begins: ₹21,53,064, a 177% step that is an artefact of the price table
    // rather than a movement in net worth. The two columns are not comparable, and only the first
    // of them is now allowed to say it is a total.
    const august = data.months.find((month) => month.key === '2026-08-12')
    expect(august?.unpricedCount).toBe(0)
    expect(addMinor(...(august?.segments ?? []).map((segment) => segment.value))).toBe(
      minor('215306433'),
    )
  })

  it('reports the current month as incomplete when a holding in it is unpriced', () => {
    // The shipped fixture stores no rate for the dollar holding at all, so the last column omits
    // it. That is true of the live dashboard too, and the column has to say so.
    const data = ready()
    const last = data.months[data.months.length - 1]
    expect(last?.unpricedCount).toBe(1)
    expect(data.months.slice(0, -1).every((month) => month.unpricedCount === 0)).toBe(true)
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

// ---------------------------------------------------------------------------
// A native-currency amount, rendered and exported as though it were rupees.
// ---------------------------------------------------------------------------

describe('lots and transactions in a currency that is not the rupee', () => {
  it('states a dollar lot’s cost in dollars, beside a rupee tile derived from the same lot', () => {
    const data = ready(usdLedgerRows())
    const cat = data.instruments.find((instrument) => instrument.name === 'Caterpillar Inc')
    const lot = cat?.lots[0]
    expect(lot?.currency).toBe('USD')
    expect(lot?.cost.measured).toBe(true)
    if (lot?.cost.measured === true) {
      // 12 × $310 = $3,720, and it says so. Under the old call this was "3,720" beneath a static
      // "Cost ₹" header: right digits, wrong unit, and ~87× away from what it appeared to claim.
      expect(formatFigure(lot.cost.value)).toBe('$3,720')
      expect(formatFigure(lot.cost.value)).not.toBe('3,720')
    }

    // The tile a reader compares it against is the same cost through `costInInr` — a genuinely
    // different quantity, ~87× larger, and stated in rupees under a label that says so.
    expect(cat?.totalCost.measured).toBe(true)
    if (cat?.totalCost.measured === true) {
      expect(formatFigure(cat.totalCost.value)).toBe('9,75,998')
    }
  })

  it('states a dollar transaction’s amount in dollars', () => {
    const data = ready(usdLedgerRows())
    const cat = data.instruments.find((instrument) => instrument.name === 'Caterpillar Inc')
    const txn = cat?.transactions.find((entry) => entry.occurredOn === '2024-11-14')
    expect(txn?.currency).toBe('USD')
    expect(txn?.amount.measured).toBe(true)
    if (txn?.amount.measured === true) {
      expect(formatFigure(txn.amount.value)).toBe('$3,720')
    }
  })

  it('keeps a rupee transaction printing as rupees', () => {
    const data = ready()
    const rel = data.instruments.find((instrument) => instrument.name === 'Reliance Industries')
    const txn = rel?.transactions.find((entry) => entry.id === 't-rel-r18')
    expect(txn?.currency).toBe('INR')
    expect(txn?.amount.measured).toBe(true)
    if (txn?.amount.measured === true) {
      expect(formatFigure(txn.amount.value)).toBe('₹1,93,020')
    }
  })

  it('names the unit of a USDT-quoted fill, and withholds the amount it cannot format', () => {
    /*
     * `X:` is migration 0002's namespace for anything with no minor unit and no rupee rate. This
     * is the reachable half of the defect and the route is worth stating: `buildAccounts` drops a
     * snapshot account's transactions before mapping them, so no `MappingError` is raised — but
     * `buildInstrumentViews` reads `rows.transactions` directly, so the fill still reaches the
     * transactions table. Its quote price sat under a static "Price ₹" header: BTC at 43,000 USDT
     * read "₹43,000", three lines below a panel meta stating "USD per unit".
     */
    const rows = portfolioRows({
      transactions: [
        ...TRANSACTIONS,
        {
          ...TRANSACTIONS[0]!,
          id: 't-cat-usdt',
          accountId: 'a-etrade',
          instrumentId: 'i-cat',
          quantity: '1.00000000',
          price: '43000.00000000',
          amountMinor: '4300000',
          currency: 'X:USDT',
          naturalKey: 'binance:btcusdt:1',
        },
      ],
    })
    const data = ready(rows)
    const cat = data.instruments.find((instrument) => instrument.name === 'Caterpillar Inc')
    const txn = cat?.transactions.find((entry) => entry.id === 't-cat-usdt')
    expect(txn?.currency).toBe('USDT')
    // The price is stated, in its own unit — the cell appends `currency` rather than sitting under
    // a header that names a currency it cannot know.
    expect(txn?.price).toBe('43000.00000000')
    // The amount is not: there is no formatting rule for USDT, and a bare integer beside rupees is
    // exactly what must not be printed.
    expect(txn?.amount.measured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// "No history" said of months that have one.
// ---------------------------------------------------------------------------

describe('a month that held everything and could price none of it', () => {
  it('does not call it a gap, and does not claim history begins this month', () => {
    /*
     * Eleven columns held 24 SIP purchases and three equity trades and priced none of them,
     * because the only stored price rows are dated today. Net worth is zero for those months, and
     * zero net worth used to take the gap branch — which threw away the `unpricedCount` computed
     * on the line above it and pushed a literal 0 in its place. Four surfaces then told the user
     * their imported history did not exist, and the chart annotated the date it supposedly began.
     *
     * No rupee figure was wrong. The reason was, and the reason is what the reader acts on.
     */
    const data = ready(freshInstallRows())
    const earlier = data.months.slice(0, -1)
    expect(earlier).toHaveLength(11)

    for (const month of earlier) {
      // Held, and not priced — not "nothing here". `[]` rather than `null` is what says so: the
      // priced value of that month is zero, which is a measurement, and the count says why.
      expect(month.segments).toEqual([])
      expect(month.unpricedCount).toBe(2)
    }

    // The last column is the one refresh that happened. It draws real segments, and it is still
    // marked incomplete — gold's price and the dollar rate are both older than that refresh.
    const last = data.months[data.months.length - 1]
    expect(last?.segments?.length).toBeGreaterThan(0)
    expect(last?.unpricedCount).toBe(2)

    // Nothing began in August. `historyBegins` is drawn as "HISTORY BEGINS <month> — EARLIER
    // MONTHS ARE NOT DRAWN" over a ledger starting 2024-09-07.
    expect(data.historyBegins).toBeUndefined()
  })

  it('still draws a genuine gap as a gap, with nothing to count', () => {
    // Nine months before the first transaction: no holdings, no prices, nothing folded. `null` is
    // reserved for exactly this, and the distinction is the whole point of the change above.
    const firstTxnOnly = portfolioRows({
      transactions: TRANSACTIONS.filter((txn) => txn.occurredAt >= '2026-06-01'),
      positions: [],
      unresolved: [],
    })
    const data = ready(firstTxnOnly)
    const gaps = data.months.filter((month) => month.segments === null)
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every((month) => (month.unpricedCount ?? 0) === 0)).toBe(true)
    expect(data.historyBegins).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Coverage that reads as complete over a portfolio it could not price.
// ---------------------------------------------------------------------------

describe('unpriced holdings and the coverage figures', () => {
  it('carries the unpriced count to the screen rather than leaving it in the engine', () => {
    const data = ready()
    // Caterpillar is quoted in dollars with no stored rate: priced by nothing, and therefore in
    // neither side of the calibration split.
    expect(data.unpricedCount).toBe(1)
    expect(data.accounts.find((account) => account.label.startsWith('E*TRADE'))?.unpriced).toBe(1)
  })

  it('exposes the count on the reproduction where the split comes out clean', () => {
    const data = ready(unpricedSnapshotRows())
    // Nothing to hatch, nothing to bracket, and a 100/0 split — over a portfolio missing an
    // account. The count is the only thing that can say so.
    expect(data.snapshotOnlyMinor).toBe('0')
    expect(data.ledgerBackedMinor).toBe(data.netWorthMinor)
    expect(data.unpricedCount).toBe(1)
  })

  it('refuses to promise 100% coverage while something is unpriced', () => {
    expect(ready().coverageOpportunity).not.toMatch(/raise coverage to 100\.0%/u)
    expect(ready().coverageOpportunity).toMatch(/no stored price/u)
    // Priced end to end, so the promise is one the import can actually keep.
    expect(ready(nearlyFullCoverageRows()).coverageOpportunity).toMatch(/coverage to 100\.0%/u)
  })
})

// ---------------------------------------------------------------------------
// Totals that sum an unpriced holding as a zero, and publish the result as measured.
//
// The count above was the previous round's fix, and it reached the calibration bar and the
// accounts foot. What it did not reach is the arithmetic: `buildPosition` writes `ZERO_MINOR` into
// `valueMinor` for a holding it could not price — correct in itself, since the sibling `value`
// takes the false branch — and both aggregates then summed those zeros and wrapped the result in
// `fullCoverage`. The honesty suite cannot see it: H3 inspects `[data-not-measured]` nodes, and
// marking the sum measured is precisely what removes the node.
// ---------------------------------------------------------------------------

describe('totals over a holding that could not be priced', () => {
  it('withholds an instrument total rather than publishing a sum of zeros as measured', () => {
    const data = ready()
    const cat = data.instruments.find((instrument) => instrument.id === 'i-cat')
    expect(cat?.totalValue.measured).toBe(false)
    if (cat?.totalValue.measured === false) {
      // The row beneath the tile says "Not converted — no exchange rate for this date"; the tile
      // now says the same thing rather than "₹0" under a stamp reading "quantity multiplied by
      // the latest stored price".
      expect(cat.totalValue.reason).toBe('no_fx_rate')
      expect(cat.totalValue.excluded).toBe('0')
    }
    // The quantity is not in doubt and is not withheld: 34 units are held, worth an unknown
    // amount. That pairing — a real quantity beside a withheld value — is the whole statement.
    expect(cat?.totalQuantity.measured).toBe(true)
    expect(cat?.positions.every((position) => !position.priced)).toBe(true)
  })

  it('does not deny a price it is printing on the same tile', () => {
    const data = ready()
    const cat = data.instruments.find((instrument) => instrument.id === 'i-cat')
    // A stored close exists — the tile prints 376.20 from it — but the engine dates only a price
    // it could use, so the note read "No price has been fetched for this instrument."
    expect(cat?.lastPrice.measured).toBe(true)
    expect(cat?.lastPriceNote).not.toMatch(/No price has been fetched/u)
    expect(cat?.lastPriceNote).toMatch(/USD · as of 11 Aug 2026/u)
    expect(cat?.lastPriceNote).toMatch(/not converted to rupees/u)
  })

  it('withholds the account total on the reproduction the count was added for', () => {
    const data = ready(unpricedSnapshotRows())
    const etrade = data.accounts.find((account) => account.id === 'a-etrade')
    expect(etrade?.unpriced).toBe(1)
    // The badge said "1 not priced" one column away from a measured ₹0, which is the same row
    // asserting two different things about the same holding.
    expect(etrade?.value.measured).toBe(false)
    if (etrade?.value.measured === false) expect(etrade.value.reason).toBe('no_fx_rate')
  })

  it('withholds a partly priced account total — the sum that looks entirely plausible', () => {
    /*
     * The dangerous shape, and the one no fixture could reach: an account holding ₹1,11,737 of
     * priced gold beside a dollar holding with no rate. Summing the second as zero gives a
     * confident rupee figure that silently omits a holding, and `fullCoverage` stamps it 100.0%.
     */
    const data = ready(partlyPricedAccountRows())
    const etrade = data.accounts.find((account) => account.id === 'a-etrade')
    expect(etrade?.holdings).toBe(2)
    expect(etrade?.unpriced).toBe(1)
    // The priced part is real and is kept — the weights, the sort and the export all read it, and
    // the export asks `priced` per row before writing a rupee figure.
    expect(etrade?.valueMinor).toBe('11173650')
    // It is not the account's value, and no coverage can say by how much it falls short: an
    // unpriced holding contributes a rupee amount to neither side of that fraction.
    expect(etrade?.value.measured).toBe(false)
    if (etrade?.value.measured === false) expect(etrade.value.excluded).toBe('11173650')

    // Pricing is decided per instrument, so the gold held in two accounts is priced in both and
    // its own total stays measured. Withholding is per aggregate, not contagious.
    const gold = data.instruments.find((instrument) => instrument.id === 'i-gold')
    expect(gold?.positions).toHaveLength(2)
    expect(gold?.totalValue.measured).toBe(true)
  })

  it('withholds every account and every instrument total on a fresh install', () => {
    // An import, and no refresh yet: not one price row exists. Every tile on the instruments
    // screen and every row on the accounts screen printed a measured ₹0.
    const data = ready(noPricesRows())
    expect(data.netWorthMinor).toBe('0')
    expect(data.unpricedCount).toBe(4)
    expect(data.instruments).toHaveLength(4)
    expect(data.instruments.every((instrument) => !instrument.totalValue.measured)).toBe(true)
    expect(data.accounts.every((account) => !account.value.measured)).toBe(true)
    // The units are known throughout, which is what makes the withheld values readable.
    expect(data.instruments.every((instrument) => instrument.totalQuantity.measured)).toBe(true)
  })

  it('keeps a genuine zero measured: sold out is not the same as unpriced', () => {
    // The bound on the fix. This holding has a price and no units, so ₹0 is a measurement rather
    // than a stand-in, and withholding it would make "not measured" the new way of saying nothing.
    const data = ready(zeroQuantityRows())
    const gold = data.instruments.find((instrument) => instrument.id === 'i-gold')
    expect(gold?.totalValue.measured).toBe(true)
    if (gold?.totalValue.measured === true) expect(formatFigure(gold.totalValue.value)).toBe('0')
    const account = data.accounts.find((entry) => entry.id === 'a-gold')
    expect(account?.holdings).toBe(1)
    expect(account?.unpriced).toBe(0)
    expect(account?.value.measured).toBe(true)
  })

  /*
   * The invariant rather than the instances, and it lives here rather than in `assertHonest`
   * because the DOM cannot tell the two zeros apart: a measured ₹0 over an unpriced holding and a
   * measured ₹0 over a sold-out one render identically, down to `data-coverage-pct="0.0"`. What
   * separates them is which positions went into the sum, and that is only knowable where the sum
   * is taken.
   *
   * Split across two cases rather than looped over nine fixtures in one: every `ready()` values
   * the portfolio at twelve month ends as well as today, and one test doing that nine times is a
   * test that fails on a busy machine for a reason that has nothing to do with the invariant.
   */
  function expectTotalsMatchPricing(name: string, rows: PortfolioRows): void {
    const data = ready(rows)
    for (const account of data.accounts) {
      const own = data.positions.filter((position) => position.accountId === account.id)
      expect([name, account.id, account.value.measured]).toEqual([
        name,
        account.id,
        own.every((position) => position.priced),
      ])
    }
    for (const instrument of data.instruments) {
      expect([name, instrument.id, instrument.totalValue.measured]).toEqual([
        name,
        instrument.id,
        instrument.positions.every((position) => position.priced),
      ])
    }
  }

  it('holds for every fixture that carries an unpriced holding', () => {
    expectTotalsMatchPricing('default', portfolioRows())
    expectTotalsMatchPricing('partly priced', partlyPricedAccountRows())
    expectTotalsMatchPricing('no prices', noPricesRows())
    expectTotalsMatchPricing('unpriced snapshot', unpricedSnapshotRows())
  })

  it('holds for every fixture that carries none, so nothing is withheld for sport', () => {
    expectTotalsMatchPricing('zero quantity', zeroQuantityRows())
    expectTotalsMatchPricing('usd ledger', usdLedgerRows())
    expectTotalsMatchPricing('all ledger', allLedgerRows())
    expectTotalsMatchPricing('all snapshot', allSnapshotRows())
  })
})

// ---------------------------------------------------------------------------
// An average cost in rupees, in a row that says it is in dollars.
// ---------------------------------------------------------------------------

describe('the unit an average cost is in', () => {
  it('states rupees on a converted average cost, beside a native last price', () => {
    const data = ready(usdLedgerRows())
    const cat = data.positions.find((position) => position.instrumentId === 'i-cat')
    expect(cat?.currency).toBe('USD')

    // `pair.costMinor` is already through `costInInr`, so this quotient is rupees per unit — and
    // read as dollars, beside a $376.20 last price, it states a 98.7% loss on a holding whose
    // unrealised percentage on the same row is +14.67. The true dollar figure is $336.47.
    expect(cat?.avgCost.measured).toBe(true)
    if (cat?.avgCost.measured === true) {
      expect(formatFigure(cat.avgCost.value)).toBe('28,705.82 INR')
    }
    expect(cat?.lastPrice.measured).toBe(true)
    if (cat?.lastPrice.measured === true) {
      expect(formatFigure(cat.lastPrice.value)).toBe('376.20')
    }
  })

  it('names the unit on a rupee holding too, rather than only where it would be wrong', () => {
    // A unit stated only on the rows that need it is a unit a reader has to notice the absence
    // of. Reliance is quoted in rupees and its average cost says so.
    const data = ready()
    const rel = data.positions.find((position) => position.instrumentId === 'i-rel')
    expect(rel?.avgCost.measured).toBe(true)
    if (rel?.avgCost.measured === true) {
      expect(formatFigure(rel.avgCost.value)).toBe('2,559.87 INR')
    }
  })
})

// ---------------------------------------------------------------------------
// A price smaller than the convention can show.
// ---------------------------------------------------------------------------

describe('prices smaller than a paisa', () => {
  it('shows a sub-paisa price rather than rounding it to zero', () => {
    const data = ready(subPaisaRows())
    const shib = data.instruments.find((instrument) => instrument.name === 'Shiba Inu')
    expect(shib?.lastPrice.measured).toBe(true)
    if (shib?.lastPrice.measured === true) {
      // The stored close at the precision it was stored with — the same reading NavHistoryChart
      // takes of the same rows. Two fixed decimals printed '0.00'.
      expect(formatFigure(shib.lastPrice.value)).toBe('0.00092400')
      expect(formatFigure(shib.lastPrice.value)).not.toBe('0.00')
    }

    const position = data.positions.find((entry) => entry.instrumentId === 'i-shib')
    expect(position?.avgCost.measured).toBe(true)
    if (position?.avgCost.measured === true) {
      expect(formatFigure(position.avgCost.value)).not.toBe('0.00')
      expect(formatFigure(position.avgCost.value)).toMatch(/^0\.000\d/u)
    }
    // The value beside them is unaffected and non-zero, which is what made the two zeros a visible
    // contradiction rather than a plausible reading.
    expect(position?.valueMinor).toBe('11088000')
  })

  it('leaves every price the convention can show exactly as it was', () => {
    const data = ready()
    const rel = data.instruments.find((instrument) => instrument.name === 'Reliance Industries')
    if (rel?.lastPrice.measured === true) expect(formatFigure(rel.lastPrice.value)).toBe('2,908.60')
    const ppfc = data.instruments.find((instrument) => instrument.name === 'Parag Parikh Flexi Cap')
    if (ppfc?.lastPrice.measured === true) expect(formatFigure(ppfc.lastPrice.value)).toBe('69.7670')
  })
})
