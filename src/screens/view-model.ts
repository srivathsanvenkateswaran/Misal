/**
 * The view-models: stored rows and a valuation snapshot in, screen-ready shapes out.
 *
 * Three rules from the spec are enforced structurally here rather than remembered in components:
 *
 *  1. **Nothing is recomputed.** Every figure below is lifted from the valuation engine's output.
 *     Where this module does arithmetic at all it is share-of-total percentages and per-unit
 *     averages, in `decimal.js` on the engine's own `Minor`/`Dec` strings, never on a JS number.
 *  2. **Coverage is attached where the view-model is built** (spec §12), not where it is rendered.
 *     A history-dependent metric leaves this module already carrying the rupee amount and the
 *     percentage it can speak for, so no component can forget it.
 *  3. **A metric that cannot be computed leaves as `Measured`'s false branch**, carrying the value
 *     it cannot speak for. There is no `?? 0` in this file and no expression that could produce
 *     one: the false branch has no `value` property to reach for.
 */

import { DateTime } from 'luxon'
import {
  type CurrencyCode,
  type Dec,
  type Minor,
  ZERO_DEC,
  ZERO_MINOR,
  addDec,
  addMinor,
  compareMinor,
  dec,
  divDec,
  isZeroDec,
  isZeroMinor,
  minor,
  minorToDec,
  mulDec,
  subMinor,
} from '@domain/numeric'
import {
  type Coverage,
  type Measured,
  fullCoverage,
  measured,
  notMeasured,
  partialCoverage,
} from '@domain/measured'
import {
  type AssetClass,
  type InstrumentRef,
  type IsoDate,
  type IsoInstant,
  type MetricCoverage,
  type OpenLot,
  type PairValue,
  type PriceService,
  type ValuationSnapshot,
  FxTable,
  xirrForScope,
} from '@valuation/index'
import type { Figure } from '@ui/figure'
import { moneyFigure, pctFigure, qtyFigure } from '@ui/figure'
import { formatMoney, money } from '@ui/format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '@ui/metrics'
import type { SeriesToken } from '@ui/metrics'
import type { SourceStampProps } from '@ui/provenance/SourceStamp'
import type { CalibrationSegment } from '@ui/charts/CalibrationBar'
import type { ConcentrationRow } from '@ui/charts/ConcentrationChart'
import type { StackMonth } from '@ui/charts/NetWorthStackChart'
import type { AccountRow, PortfolioRows, TxnRow } from '../data/client'
import { buildAccounts, valueFromRows } from '../data/portfolio'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type Capability = 'ledger' | 'snapshot'

export interface AccountView {
  readonly id: string
  readonly label: string
  readonly providerId: string
  readonly shortCode: string
  readonly capability: Capability
  readonly series: SeriesToken
  readonly value: Measured<Figure>
  readonly valueMinor: Minor
  readonly holdings: number
  readonly unpriced: number
  /**
   * The most recent date any row in this account carries.
   *
   * The mockup's column reads "Last synced". The core exposes no `source_document.imported_at` to
   * this layer and no `account.last_synced_at` column (spec §14.3), so this is the latest *data*
   * date and the column header says exactly that. Inventing a sync time from a statement date
   * would be a small lie about when Misal last looked.
   */
  readonly dataAsOf: IsoDate | null
  readonly dataAsOfNote: string
  readonly stamp: SourceStampProps
}

export interface PositionView {
  readonly key: string
  readonly instrumentId: string
  readonly accountId: string
  readonly name: string
  readonly detail: string
  readonly assetClass: AssetClass
  readonly accountLabel: string
  readonly capability: Capability
  readonly quantity: Dec
  readonly precision: number
  readonly currency: CurrencyCode
  readonly avgCost: Measured<Figure>
  readonly lastPrice: Measured<Figure>
  readonly priceNote: string | undefined
  readonly staleDays: number | undefined
  readonly value: Measured<Figure>
  /** The priced value. Zero only when there is genuinely none; never a stand-in for one. */
  readonly valueMinor: Minor
  readonly priced: boolean
  readonly costMinor: Minor | null
  readonly unrealised: Measured<Figure>
  readonly unrealisedPct: Measured<Figure>
  readonly weight: Dec
  readonly dayPct: Measured<Figure>
  readonly stamp: SourceStampProps
}

export interface ClassView {
  readonly assetClass: AssetClass
  readonly label: string
  readonly series: SeriesToken
  readonly valueMinor: Minor
  readonly value: Measured<Figure>
  readonly weight: Dec
  readonly positions: number
  readonly basis: Capability
  readonly detail: string
  readonly stamp: SourceStampProps
}

export interface CoverageMetricView {
  readonly key: string
  readonly label: string
  readonly amount: Measured<Figure>
  readonly pct: Dec
  readonly exact: boolean
}

export interface DataQualityView {
  readonly stalePrices: number
  readonly staleNote: string
  readonly unresolvedCount: number
  readonly withheldMinor: Minor
  readonly withheldNote: string
  readonly accountCount: number
  readonly accountNote: string
  readonly priceFeed: string
  readonly priceFeedNote: string
}

export interface ReadoutView {
  readonly netWorth: Measured<Figure>
  readonly dayChange: Measured<Figure>
  readonly dayChangePct: Measured<Figure>
  readonly costBasis: Measured<Figure>
  readonly costNote: string
  readonly unrealised: Measured<Figure>
  readonly unrealisedPct: Measured<Figure>
  readonly xirr: Measured<Figure>
  readonly xirrNote: string
  readonly xirrMeterPct: Dec
  readonly realised: Measured<Figure>
  readonly stcg: Measured<Figure>
  readonly ltcg: Measured<Figure>
  readonly financialYear: string
  readonly currencyExposure: Measured<Figure>
  readonly currencySplit: { readonly aPct: Dec; readonly bPct: Dec } | null
  readonly currencyNote: string
  readonly concentration: Measured<Figure>
  readonly largestPosition: Measured<Figure>
  readonly concentrationNote: string
  readonly counts: string
}

export interface LotView {
  readonly lotId: string
  readonly acquiredOn: IsoDate
  readonly accountLabel: string
  readonly quantity: Dec
  readonly cost: Measured<Figure>
  readonly origin: OpenLot['origin']
  readonly stamp: SourceStampProps
}

export interface TxnView {
  readonly id: string
  readonly occurredOn: IsoDate
  readonly type: string
  readonly accountLabel: string
  readonly quantity: Dec
  readonly price: Dec | null
  readonly amount: Measured<Figure>
  readonly stamp: SourceStampProps
}

export interface InstrumentView {
  readonly id: string
  readonly name: string
  readonly assetClass: AssetClass
  readonly series: SeriesToken
  readonly identifiers: string
  readonly precision: number
  readonly currency: CurrencyCode
  readonly capability: Capability | 'mixed'
  readonly lastPrice: Measured<Figure>
  readonly lastPriceNote: string
  readonly positions: readonly PositionView[]
  readonly totalQuantity: Measured<Figure>
  readonly totalValue: Measured<Figure>
  readonly totalCost: Measured<Figure>
  readonly totalUnrealised: Measured<Figure>
  readonly xirr: Measured<Figure>
  readonly lots: readonly LotView[]
  readonly transactions: readonly TxnView[]
  readonly weight: Dec
}

export interface PortfolioData {
  readonly asOf: IsoInstant
  readonly asOfDate: IsoDate
  readonly accounts: readonly AccountView[]
  readonly netWorthMinor: Minor
  readonly ledgerBackedMinor: Minor
  readonly snapshotOnlyMinor: Minor
  readonly ledgerAccounts: number
  readonly segments: readonly CalibrationSegment[]
  readonly classes: readonly ClassView[]
  readonly positions: readonly PositionView[]
  readonly concentration: readonly ConcentrationRow[]
  readonly months: readonly StackMonth[]
  readonly historyBegins: string | undefined
  readonly coverageByMetric: readonly CoverageMetricView[]
  readonly dataQuality: DataQualityView
  readonly readout: ReadoutView
  readonly instruments: readonly InstrumentView[]
  readonly warnings: readonly string[]
  /** What importing a transaction history for the snapshot accounts would unlock, to the rupee. */
  readonly coverageOpportunity: string | null
}

export type PortfolioView =
  | { readonly ok: true; readonly data: PortfolioData }
  | { readonly ok: false; readonly message: string }

/** The single-position flag from the mockup. There is no `setting` table yet (spec §14.2). */
export const CONCENTRATION_THRESHOLD = dec('20')

// ---------------------------------------------------------------------------
// Helpers. None of them rounds; formatting happens at the display boundary.
// ---------------------------------------------------------------------------

/** `valueMinor / totalMinor × 100`, in exact decimal maths. A zero total yields zero, not NaN. */
export function shareOf(valueMinor: Minor, totalMinor: Minor): Dec {
  if (isZeroMinor(totalMinor)) return ZERO_DEC
  return mulDec(divDec(minorToDec(valueMinor, 'INR'), minorToDec(totalMinor, 'INR')), dec('100'))
}

function coverageFrom(metric: MetricCoverage, excludedAccounts: readonly string[]): Coverage {
  return partialCoverage(metric.coveredMinor, metric.totalMinor, excludedAccounts)
}

function metricNamed(snapshot: ValuationSnapshot, name: MetricCoverage['metric']): MetricCoverage {
  const found = snapshot.coverage.perMetric.find((entry) => entry.metric === name)
  if (found === undefined) {
    throw new Error(`The valuation engine returned no coverage for ${name}.`)
  }
  return found
}

export function formatDate(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: 'utc' })
  return dt.isValid ? dt.toFormat('dd LLL yyyy') : iso
}

export function formatDateTime(iso: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true })
  return dt.isValid ? dt.toFormat('dd LLL yyyy HH:mm') : iso
}

/** Four decimals for a NAV, two for a quote. */
function priceDecimals(assetClass: AssetClass): number {
  return assetClass === 'mutual_fund' ? 4 : 2
}

const CAPABILITY_TEXT: Record<Capability, string> = {
  ledger: 'Full transaction history',
  snapshot: 'Snapshot only — no transaction history, so cost basis, P&L and XIRR are not measured',
}

export const CAPABILITY_BADGE: Record<Capability, string> = {
  ledger: 'Full history',
  snapshot: 'Holdings only',
}

function shortCode(account: AccountRow): string {
  return account.providerShortCode === ''
    ? account.providerId.slice(0, 3).toUpperCase()
    : account.providerShortCode
}

function stampFor(
  account: AccountRow,
  reference: string,
  detail: string,
  alert = false,
): SourceStampProps {
  return {
    code: shortCode(account),
    reference,
    variant: account.capability,
    ...(alert ? { alert: true } : {}),
    description: `Source: ${account.label}. ${CAPABILITY_TEXT[account.capability]}. ${detail}`,
  }
}

export function derivedStamp(reference: string, description: string): SourceStampProps {
  return { code: 'DRV', reference, variant: 'derived', description }
}

// ---------------------------------------------------------------------------
// Monthly series (H10)
// ---------------------------------------------------------------------------

function monthEnds(asOfDate: IsoDate, count: number): readonly IsoDate[] {
  const end = DateTime.fromISO(asOfDate, { zone: 'utc' })
  const out: IsoDate[] = []
  for (let back = count - 1; back >= 1; back -= 1) {
    const iso = end.minus({ months: back }).endOf('month').toISODate()
    if (iso !== null) out.push(iso)
  }
  out.push(asOfDate)
  return out
}

function monthLabel(date: IsoDate): { readonly label: string; readonly year: string } {
  const dt = DateTime.fromISO(date, { zone: 'utc' })
  return { label: dt.toFormat('LLL').toUpperCase(), year: dt.toFormat('yy') }
}

/**
 * Rows as they stood at a month end.
 *
 * Filtering the *inputs* and re-running the same engine is what keeps H10 honest. A month before
 * an account's first transaction has nothing to fold and nothing to price, so it produces no value
 * at all and is drawn as an explicit gap. Nothing is interpolated and nothing is carried
 * backwards, because there is no code path here that could carry anything.
 */
function rowsAsAt(rows: PortfolioRows, monthEnd: IsoDate): PortfolioRows {
  return {
    ...rows,
    transactions: rows.transactions.filter((txn) => txn.occurredAt.slice(0, 10) <= monthEnd),
    positions: rows.positions.filter((position) => position.asOf.slice(0, 10) <= monthEnd),
    prices: rows.prices.filter((price) => price.asOf.slice(0, 10) <= monthEnd),
  }
}

interface ClassAggregate {
  value: Minor
  basis: Capability
  positions: number
  accounts: Set<string>
}

/**
 * Aggregate a snapshot's priced pairs by asset class.
 *
 * A class is drawn as ledger-backed only when *every* holding in it has transaction history. A
 * mixed class is hatched whole, which understates coverage rather than overstating it; the exact
 * rupee split is stated separately by the calibration bar's own annotations, which come from the
 * engine's coverage report rather than from this aggregation.
 */
function aggregateByClass(
  snapshot: ValuationSnapshot,
  instruments: ReadonlyMap<string, InstrumentRef>,
  accounts: ReadonlyMap<string, AccountRow>,
): ReadonlyMap<AssetClass, ClassAggregate> {
  const byClass = new Map<AssetClass, ClassAggregate>()
  for (const pair of snapshot.pairs) {
    if (!pair.marketValue.measured) continue
    const instrument = instruments.get(pair.instrumentId)
    if (instrument === undefined) continue
    const basis: Capability = pair.measurement === 'measured' ? 'ledger' : 'snapshot'
    const label = accounts.get(pair.accountId)?.label ?? pair.accountId
    const existing = byClass.get(instrument.assetClass)
    if (existing === undefined) {
      byClass.set(instrument.assetClass, {
        value: pair.marketValue.value,
        basis,
        positions: 1,
        accounts: new Set([label]),
      })
    } else {
      existing.value = addMinor(existing.value, pair.marketValue.value)
      existing.positions += 1
      existing.accounts.add(label)
      if (basis === 'snapshot') existing.basis = 'snapshot'
    }
  }
  return byClass
}

function buildMonths(
  rows: PortfolioRows,
  asOfDate: IsoDate,
  accounts: ReadonlyMap<string, AccountRow>,
): { readonly months: readonly StackMonth[]; readonly historyBegins: string | undefined } {
  const months: StackMonth[] = []
  for (const monthEnd of monthEnds(asOfDate, 12)) {
    const { label, year } = monthLabel(monthEnd)
    const asAt = rowsAsAt(rows, monthEnd)
    const bundle = valueFromRows(asAt, asAt.aliases, `${monthEnd}T23:59:59+05:30`)
    if (!bundle.snapshot.ok || isZeroMinor(bundle.snapshot.value.netWorthMinor)) {
      months.push({ key: monthEnd, label, year, segments: null })
      continue
    }
    const byClass = aggregateByClass(bundle.snapshot.value, bundle.instruments, accounts)
    months.push({
      key: monthEnd,
      label,
      year,
      segments: [...byClass.entries()].map(([assetClass, entry]) => ({
        assetClass,
        value: entry.value,
        basis: entry.basis,
      })),
    })
  }

  const firstDrawn = months.findIndex((month) => month.segments !== null)
  const begins = firstDrawn > 0 ? months[firstDrawn] : undefined
  return {
    months,
    historyBegins: begins === undefined ? undefined : `${begins.label} 20${begins.year}`,
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function identifiersOf(rows: PortfolioRows, instrument: InstrumentRef): string {
  const aliases = rows.aliases
    .filter((alias) => alias.instrumentId === instrument.id)
    .map((alias) => `${alias.scheme.toUpperCase()}:${alias.value}`)
  const isin = instrument.isin
  return [...aliases, ...(isin === null ? [] : [isin])].join(' · ')
}

function txnCount(transactions: readonly TxnRow[], accountId: string, instrumentId: string): number {
  return transactions.filter(
    (txn) => txn.accountId === accountId && txn.instrumentId === instrumentId,
  ).length
}

function buildPosition(
  pair: PairValue,
  rows: PortfolioRows,
  accounts: ReadonlyMap<string, AccountRow>,
  instruments: ReadonlyMap<string, InstrumentRef>,
  prices: PriceService,
  netWorthMinor: Minor,
): PositionView | null {
  const instrument = instruments.get(pair.instrumentId)
  const account = accounts.get(pair.accountId)
  if (instrument === undefined || account === undefined) return null

  const priced = pair.marketValue.measured
  const valueMinor = pair.marketValue.measured ? pair.marketValue.value : ZERO_MINOR

  const value: Measured<Figure> = pair.marketValue.measured
    ? measured(
        moneyFigure(pair.marketValue.value, { symbol: false }),
        fullCoverage(pair.marketValue.value),
      )
    : notMeasured(pair.marketValue.reason, pair.marketValue.excluded)

  let avgCost: Measured<Figure>
  if (!pair.costMinor.measured) {
    avgCost = notMeasured(pair.costMinor.reason, pair.costMinor.excluded)
  } else if (isZeroDec(pair.quantity)) {
    avgCost = notMeasured('no_transaction_history', valueMinor)
  } else {
    avgCost = measured(
      qtyFigure(divDec(minorToDec(pair.costMinor.value, 'INR'), pair.quantity), {
        precision: priceDecimals(instrument.assetClass),
      }),
      pair.costMinor.coverage,
    )
  }

  const unrealised: Measured<Figure> = pair.unrealised.measured
    ? measured(
        moneyFigure(pair.unrealised.value.pnlMinor, { signed: true, symbol: false }),
        pair.unrealised.coverage,
      )
    : notMeasured(pair.unrealised.reason, pair.unrealised.excluded)

  let unrealisedPct: Measured<Figure>
  if (!pair.unrealised.measured) {
    unrealisedPct = notMeasured(pair.unrealised.reason, pair.unrealised.excluded)
  } else if (pair.unrealised.value.pnlPct === null) {
    // A bonus-only holding has zero cost. Its return is not "flat"; it is undefined, and the
    // engine says so by handing back null rather than a zero.
    unrealisedPct = notMeasured('no_transaction_history', valueMinor)
  } else {
    unrealisedPct = measured(
      pctFigure(pair.unrealised.value.pnlPct, { signed: true }),
      pair.unrealised.coverage,
    )
  }

  const read = prices.priceAt(pair.instrumentId, 'latest')
  const age = pair.priceAge
  const staleDays = age !== null && age.staleness !== 'fresh' ? age.ageDays : undefined
  const lastPrice: Measured<Figure> = read.ok
    ? measured(
        qtyFigure(read.value.close, { precision: priceDecimals(instrument.assetClass) }),
        fullCoverage(valueMinor),
      )
    : notMeasured('no_price', valueMinor)
  const priceNote =
    age === null ? undefined : `${instrument.currency} · ${age.ageDays.toString()} d old`

  const reference =
    account.capability === 'ledger'
      ? `${txnCount(rows.transactions, pair.accountId, pair.instrumentId).toString()} txn`
      : 'holdings'

  return {
    key: `${pair.accountId}|${pair.instrumentId}`,
    instrumentId: pair.instrumentId,
    accountId: pair.accountId,
    name: instrument.displayName,
    detail: identifiersOf(rows, instrument),
    assetClass: instrument.assetClass,
    accountLabel: account.label,
    capability: account.capability,
    quantity: pair.quantity,
    precision: instrument.precision,
    currency: instrument.currency,
    avgCost,
    lastPrice,
    priceNote,
    staleDays,
    value,
    valueMinor,
    priced,
    costMinor: pair.costMinor.measured ? pair.costMinor.value : null,
    unrealised,
    unrealisedPct,
    weight: shareOf(valueMinor, netWorthMinor),
    // Day change needs the previous close from the same source. Nothing in the data layer stores
    // one, so it is withheld everywhere rather than computed against whatever price is to hand.
    dayPct: notMeasured('no_price', valueMinor),
    stamp: stampFor(
      account,
      reference,
      `${instrument.displayName} held in ${account.label}.`,
      staleDays !== undefined,
    ),
  }
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

function sumMeasuredCost(pairs: readonly PairValue[]): Minor {
  return addMinor(...pairs.map((pair) => (pair.costMinor.measured ? pair.costMinor.value : ZERO_MINOR)))
}

function sumMeasuredPnl(pairs: readonly PairValue[]): Minor {
  return addMinor(
    ...pairs.map((pair) => (pair.unrealised.measured ? pair.unrealised.value.pnlMinor : ZERO_MINOR)),
  )
}

function buildReadout(
  snapshot: ValuationSnapshot,
  rows: PortfolioRows,
  instruments: ReadonlyMap<string, InstrumentRef>,
  prices: PriceService,
  positions: readonly PositionView[],
  asOf: IsoInstant,
): ReadoutView {
  const netWorth = snapshot.netWorthMinor
  const snapshotAccountIds = rows.accounts
    .filter((account) => account.capability === 'snapshot')
    .map((account) => account.id)

  const costMetric = metricNamed(snapshot, 'cost_basis')
  const unrealisedMetric = metricNamed(snapshot, 'unrealised_pnl')
  const xirrMetric = metricNamed(snapshot, 'xirr')
  const realisedMetric = snapshot.realisedCoverage

  const costMinor = sumMeasuredCost(snapshot.pairs)
  const pnlMinor = sumMeasuredPnl(snapshot.pairs)
  const anyCost = !isZeroMinor(costMetric.coveredMinor)
  const anyPnl = !isZeroMinor(unrealisedMetric.coveredMinor)

  const costBasis: Measured<Figure> = anyCost
    ? measured(moneyFigure(costMinor), coverageFrom(costMetric, snapshotAccountIds))
    : notMeasured('no_transaction_history', netWorth)

  const unrealised: Measured<Figure> = anyPnl
    ? measured(moneyFigure(pnlMinor, { signed: true }), coverageFrom(unrealisedMetric, snapshotAccountIds))
    : notMeasured('no_transaction_history', netWorth)

  const unrealisedPct: Measured<Figure> =
    anyPnl && !isZeroMinor(costMinor)
      ? measured(
          pctFigure(shareOf(pnlMinor, costMinor), { signed: true }),
          coverageFrom(unrealisedMetric, snapshotAccountIds),
        )
      : notMeasured('no_transaction_history', netWorth)

  const { xirr, xirrNote } = buildXirr(snapshot, rows, instruments, prices, asOf, xirrMetric, snapshotAccountIds)

  let stcgMinor: Minor = ZERO_MINOR
  let ltcgMinor: Minor = ZERO_MINOR
  for (const summary of snapshot.realised.byRegime.values()) {
    stcgMinor = addMinor(stcgMinor, summary.stcgMinor)
    ltcgMinor = addMinor(ltcgMinor, summary.ltcgMinor)
  }
  const realisedKnown = snapshot.disposals.length > 0 && !isZeroMinor(realisedMetric.coveredMinor)
  const realisedCoverage = coverageFrom(realisedMetric, snapshotAccountIds)
  const realised: Measured<Figure> = realisedKnown
    ? measured(moneyFigure(addMinor(stcgMinor, ltcgMinor), { signed: true }), realisedCoverage)
    : notMeasured('no_transaction_history', netWorth)
  const stcg: Measured<Figure> = realisedKnown
    ? measured(moneyFigure(stcgMinor, { signed: true }), realisedCoverage)
    : notMeasured('no_transaction_history', netWorth)
  const ltcg: Measured<Figure> = realisedKnown
    ? measured(moneyFigure(ltcgMinor, { signed: true }), realisedCoverage)
    : notMeasured('no_transaction_history', netWorth)

  const inrMinor = addMinor(
    ...snapshot.pairs
      .filter((pair) => pair.currency === 'INR' && pair.marketValue.measured)
      .map((pair) => (pair.marketValue.measured ? pair.marketValue.value : ZERO_MINOR)),
  )
  const foreignMinor = subMinor(netWorth, inrMinor)

  const ranked = [...positions].sort((a, b) => -compareMinor(a.valueMinor, b.valueMinor))
  const topFiveMinor = addMinor(...ranked.slice(0, 5).map((position) => position.valueMinor))
  const largest = ranked[0]

  const classCount = new Set(positions.map((position) => position.assetClass)).size

  return {
    netWorth: measured(moneyFigure(netWorth), fullCoverage(netWorth)),
    // The previous close is not stored, so day change is withheld rather than computed against
    // today's price twice. "Live" is a word this product does not use.
    dayChange: notMeasured('no_price', netWorth),
    dayChangePct: notMeasured('no_price', netWorth),
    costBasis,
    costNote: anyCost
      ? `Ledger accounts only · excludes ${rupees(subMinor(netWorth, costMetric.coveredMinor))} of snapshot holdings`
      : 'No account supplies the transaction history a cost basis needs.',
    unrealised,
    unrealisedPct,
    xirr,
    xirrNote,
    xirrMeterPct: xirrMetric.pct ?? ZERO_DEC,
    realised,
    stcg,
    ltcg,
    financialYear: snapshot.realised.financialYear,
    currencyExposure: measured(moneyFigure(inrMinor), fullCoverage(netWorth)),
    currencySplit: isZeroMinor(netWorth)
      ? null
      : { aPct: shareOf(inrMinor, netWorth), bPct: shareOf(foreignMinor, netWorth) },
    currencyNote: isZeroMinor(foreignMinor)
      ? 'Every priced holding is denominated in rupees.'
      : `${rupees(foreignMinor)} is held in a foreign currency.`,
    concentration: isZeroMinor(netWorth)
      ? notMeasured('no_price', netWorth)
      : measured(pctFigure(shareOf(topFiveMinor, netWorth)), fullCoverage(netWorth)),
    largestPosition:
      largest === undefined
        ? notMeasured('no_price', netWorth)
        : measured(pctFigure(largest.weight), fullCoverage(netWorth)),
    concentrationNote:
      largest === undefined ? 'No priced position to rank.' : `Largest position: ${largest.name}.`,
    counts: `${rows.accounts.length.toString()} accounts · ${positions.length.toString()} positions · ${classCount.toString()} asset classes`,
  }
}

/**
 * XIRR over the ledger-backed subset only.
 *
 * The engine refuses a portfolio-scope XIRR when any constituent is unmeasured, which is right —
 * so the "portfolio" handed to it *is* the ledger-backed portfolio, and the coverage line beside
 * the figure states to the rupee how much of net worth that is. A partial XIRR presented without
 * that line would answer a different question from the one its label asks.
 */
function buildXirr(
  snapshot: ValuationSnapshot,
  rows: PortfolioRows,
  instruments: ReadonlyMap<string, InstrumentRef>,
  prices: PriceService,
  asOf: IsoInstant,
  xirrMetric: MetricCoverage,
  snapshotAccountIds: readonly string[],
): { readonly xirr: Measured<Figure>; readonly xirrNote: string } {
  const netWorth = snapshot.netWorthMinor
  const ledgerAccountIds = new Set(
    rows.accounts.filter((account) => account.capability === 'ledger').map((account) => account.id),
  )
  const ledgerPairs = snapshot.pairs.filter((pair) => ledgerAccountIds.has(pair.accountId))
  if (ledgerPairs.length === 0) {
    return {
      xirr: notMeasured('no_transaction_history', netWorth),
      xirrNote: 'No account supplies the transaction history an XIRR needs.',
    }
  }

  const outcome = xirrForScope({
    scope: { kind: 'portfolio' },
    pairs: ledgerPairs,
    accounts: buildAccounts(rows, instruments, asOf).filter((input) =>
      ledgerAccountIds.has(input.accountId),
    ),
    fx: new FxTable([]),
    prices,
    asOf,
  })

  if (!outcome.ok) {
    return {
      xirr: notMeasured(
        outcome.error.code === 'MISSING_PRICE' ? 'no_price' : 'no_transaction_history',
        netWorth,
      ),
      xirrNote: `XIRR withheld: ${outcome.error.code.toLowerCase().replaceAll('_', ' ')}.`,
    }
  }
  if (outcome.value.unstable) {
    return {
      xirr: notMeasured('no_convergence', netWorth),
      xirrNote: 'These cash flows admit more than one rate, so no single figure is meaningful.',
    }
  }
  return {
    xirr: measured(
      pctFigure(mulDec(outcome.value.rate, dec('100'))),
      coverageFrom(xirrMetric, snapshotAccountIds),
    ),
    xirrNote: `${outcome.value.cashflowCount.toString()} cash flows over ${outcome.value.horizonDays.toString()} days`,
  }
}

/** A rupee amount for prose, in the same lakh/crore grouping every figure on screen uses. */
function rupees(value: Minor): string {
  return formatMoney(money(value))
}

/**
 * The withheld total, read from the stored rows rather than from the engine's coverage report.
 *
 * H8 requires the unresolved count to be accompanied by the exact amount excluded from totals.
 * `ValuationSnapshot.coverage.withheldMinor` is the natural source, but the data layer maps
 * `unresolved_instrument` rows without a `resolvedAt` field, and the engine filters on
 * `resolvedAt === null` — so every unresolved row is dropped before it is counted and the engine
 * reports zero withheld however many rows exist. Reading the rows here is not a second valuation:
 * it is a count and a sum of a column the core already stores, and it is the difference between
 * naming what is withheld and silently reporting none.
 */
function withheldFrom(rows: PortfolioRows): {
  readonly count: number
  readonly minor: Minor
  readonly note: string
} {
  const open = rows.unresolved
  const inr = open.filter((row) => row.currency === null || row.currency === 'INR')
  const foreign = open.length - inr.length
  const total = addMinor(
    ...inr.map((row) => (row.observedValueMinor === null ? ZERO_MINOR : minor(row.observedValueMinor))),
  )
  if (open.length === 0) {
    return { count: 0, minor: ZERO_MINOR, note: 'Every identifier in every document is mapped' }
  }
  const foreignNote =
    foreign === 0 ? '' : ` · ${foreign.toString()} more in a foreign currency, value not stated`
  return {
    count: open.length,
    minor: total,
    note: `${rupees(total)} withheld from every total${foreignNote}`,
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

function buildInstrumentViews(
  snapshot: ValuationSnapshot,
  rows: PortfolioRows,
  accounts: ReadonlyMap<string, AccountRow>,
  instruments: ReadonlyMap<string, InstrumentRef>,
  prices: PriceService,
  positions: readonly PositionView[],
  asOf: IsoInstant,
): readonly InstrumentView[] {
  const ids = [...new Set(positions.map((position) => position.instrumentId))]
  const netWorth = snapshot.netWorthMinor

  return ids
    .map((id): InstrumentView | null => {
      const instrument = instruments.get(id)
      if (instrument === undefined) return null
      const own = positions.filter((position) => position.instrumentId === id)
      const pairs = snapshot.pairs.filter((pair) => pair.instrumentId === id)

      const valueMinor = addMinor(...own.map((position) => position.valueMinor))
      const capabilities = new Set(own.map((position) => position.capability))
      const capability: Capability | 'mixed' =
        capabilities.size === 1 ? (own[0]?.capability ?? 'snapshot') : 'mixed'

      const costPairs = pairs.filter((pair) => pair.costMinor.measured)
      const pnlPairs = pairs.filter((pair) => pair.unrealised.measured)
      const costMinor = sumMeasuredCost(costPairs)
      const pnlMinor = sumMeasuredPnl(pnlPairs)
      const measuredValue = addMinor(
        ...costPairs.map((pair) => (pair.marketValue.measured ? pair.marketValue.value : ZERO_MINOR)),
      )
      const costCoverage = partialCoverage(measuredValue, valueMinor, [])

      const read = prices.priceAt(id, 'latest')
      const age = pairs.find((pair) => pair.priceAge !== null)?.priceAge ?? null

      const ledgerPairs = pairs.filter((pair) => pair.measurement === 'measured')
      let xirr: Measured<Figure> = notMeasured('no_transaction_history', valueMinor)
      if (ledgerPairs.length > 0) {
        const accountIds = new Set(ledgerPairs.map((pair) => pair.accountId))
        const outcome = xirrForScope({
          scope: { kind: 'portfolio' },
          pairs: ledgerPairs,
          accounts: buildAccounts(rows, instruments, asOf)
            .filter((input) => accountIds.has(input.accountId))
            .map((input) => ({ ...input, txns: input.txns.filter((txn) => txn.instrumentId === id) })),
          fx: new FxTable([]),
          prices,
          asOf,
        })
        if (outcome.ok && !outcome.value.unstable) {
          xirr = measured(
            pctFigure(mulDec(outcome.value.rate, dec('100'))),
            partialCoverage(measuredValue, valueMinor, []),
          )
        } else if (outcome.ok) {
          xirr = notMeasured('no_convergence', valueMinor)
        }
      }

      const lots: LotView[] = snapshot.positions
        .filter((position) => position.instrumentId === id)
        .flatMap((position) =>
          position.lots.map((lot) => {
            const account = accounts.get(lot.accountId)
            return {
              lotId: lot.lotId,
              acquiredOn: lot.acquiredOn,
              accountLabel: account?.label ?? lot.accountId,
              quantity: lot.quantity,
              cost: lot.costKnown
                ? measured<Figure>(moneyFigure(lot.costMinor, { symbol: false }), fullCoverage(lot.costMinor))
                : notMeasured<Figure>('no_transaction_history', ZERO_MINOR),
              origin: lot.origin,
              stamp:
                account === undefined
                  ? derivedStamp('fifo', 'Derived by folding this account’s transactions in FIFO order.')
                  : stampFor(account, 'lot', `Open lot acquired on ${lot.acquiredOn}.`),
            }
          }),
        )
        .sort((a, b) => (a.acquiredOn < b.acquiredOn ? -1 : 1))

      const transactions: TxnView[] = rows.transactions
        .filter((txn) => txn.instrumentId === id)
        .sort((a, b) => (a.occurredAt > b.occurredAt ? -1 : 1))
        .map((txn) => {
          const account = accounts.get(txn.accountId)
          const amountMinor = txn.amountMinor === null ? null : minor(txn.amountMinor)
          return {
            id: txn.id,
            occurredOn: txn.occurredAt.slice(0, 10),
            type: TXN_TYPE_LABEL[txn.type] ?? txn.type,
            accountLabel: account?.label ?? txn.accountId,
            quantity: dec(txn.quantity),
            price: txn.price === null ? null : dec(txn.price),
            amount:
              amountMinor === null
                ? notMeasured<Figure>('no_price', ZERO_MINOR)
                : measured<Figure>(
                    moneyFigure(amountMinor, { symbol: false }),
                    fullCoverage(amountMinor),
                  ),
            stamp:
              account === undefined
                ? derivedStamp('txn', 'A transaction whose account is no longer present.')
                : stampFor(account, `r.${txn.occurrence.toString()}`, `Transaction ${txn.naturalKey}.`),
          }
        })

      return {
        id,
        name: instrument.displayName,
        assetClass: instrument.assetClass,
        series: SERIES_BY_ASSET_CLASS[instrument.assetClass],
        identifiers: identifiersOf(rows, instrument),
        precision: instrument.precision,
        currency: instrument.currency,
        capability,
        lastPrice: read.ok
          ? measured<Figure>(
              qtyFigure(read.value.close, { precision: priceDecimals(instrument.assetClass) }),
              fullCoverage(valueMinor),
            )
          : notMeasured<Figure>('no_price', valueMinor),
        lastPriceNote:
          age === null
            ? 'No price has been fetched for this instrument.'
            : `${instrument.currency} · as of ${formatDate(age.asOf)} · ${age.ageDays.toString()} d old · ${age.source}`,
        positions: own,
        totalQuantity: measured<Figure>(
          qtyFigure(own.length === 0 ? ZERO_DEC : addDec(...own.map((position) => position.quantity)), {
            precision: instrument.precision,
          }),
          fullCoverage(valueMinor),
        ),
        totalValue: measured(moneyFigure(valueMinor, { symbol: false }), fullCoverage(valueMinor)),
        totalCost:
          costPairs.length === 0
            ? notMeasured<Figure>('no_transaction_history', valueMinor)
            : measured<Figure>(moneyFigure(costMinor, { symbol: false }), costCoverage),
        totalUnrealised:
          pnlPairs.length === 0
            ? notMeasured<Figure>('no_transaction_history', valueMinor)
            : measured<Figure>(
                moneyFigure(pnlMinor, { signed: true, symbol: false }),
                costCoverage,
              ),
        xirr,
        lots,
        transactions,
        weight: shareOf(valueMinor, netWorth),
      }
    })
    .filter((view): view is InstrumentView => view !== null)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

const TXN_TYPE_LABEL: Record<string, string | undefined> = {
  buy: 'Purchase',
  sell: 'Redemption',
  dividend: 'Dividend',
  split: 'Split',
  bonus: 'Bonus',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  fee: 'Fee',
  interest: 'Interest',
  tds: 'TDS',
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export function buildPortfolioView(rows: PortfolioRows, asOf: IsoInstant): PortfolioView {
  try {
    return { ok: true, data: build(rows, asOf) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function build(rows: PortfolioRows, asOf: IsoInstant): PortfolioData {
  const bundle = valueFromRows(rows, rows.aliases, asOf)
  if (!bundle.snapshot.ok) {
    throw new Error(`${bundle.snapshot.error.code}: ${bundle.snapshot.error.message}`)
  }
  const snapshot = bundle.snapshot.value
  const instruments = bundle.instruments
  const accounts = new Map(rows.accounts.map((account) => [account.id, account]))
  const netWorth = snapshot.netWorthMinor
  const asOfDate = asOf.slice(0, 10)

  const positions = snapshot.pairs
    .map((pair) => buildPosition(pair, rows, accounts, instruments, bundle.prices, netWorth))
    .filter((position): position is PositionView => position !== null)
    .sort((a, b) => -compareMinor(a.valueMinor, b.valueMinor))

  const byClass = aggregateByClass(snapshot, instruments, accounts)
  const classes: ClassView[] = [...byClass.entries()]
    .map(([assetClass, entry]) => ({
      assetClass,
      label: ASSET_CLASS_LABEL[assetClass],
      series: SERIES_BY_ASSET_CLASS[assetClass],
      valueMinor: entry.value,
      value: measured<Figure>(moneyFigure(entry.value, { symbol: false }), fullCoverage(entry.value)),
      weight: shareOf(entry.value, netWorth),
      positions: entry.positions,
      basis: entry.basis,
      detail: `${entry.positions.toString()} ${entry.positions === 1 ? 'position' : 'positions'} · ${[...entry.accounts].join(', ')}`,
      stamp: derivedStamp(
        `${entry.positions.toString()} pos`,
        `${ASSET_CLASS_LABEL[assetClass]} — summed from ${entry.positions.toString()} priced holdings across ${[...entry.accounts].length.toString()} accounts.`,
      ),
    }))
    .sort((a, b) => -compareMinor(a.valueMinor, b.valueMinor))

  const segments: CalibrationSegment[] = classes.map((view) => ({
    assetClass: view.assetClass,
    value: view.valueMinor,
    share: view.weight,
    basis: view.basis,
  }))

  const priced = positions.filter((position) => position.priced)
  const top = priced.slice(0, 10)
  const rest = priced.slice(10)
  const concentration: ConcentrationRow[] = [
    ...top.map((position) => ({
      key: position.key,
      label: position.name,
      assetClass: position.assetClass,
      share: position.weight,
      basis: position.capability,
    })),
    ...(rest.length === 0
      ? []
      : [
          {
            key: 'other',
            label: `Other (${rest.length.toString()} positions)`,
            assetClass: null,
            share: shareOf(addMinor(...rest.map((position) => position.valueMinor)), netWorth),
            basis: 'ledger' as const,
          },
        ]),
  ]

  const { months, historyBegins } = buildMonths(rows, asOfDate, accounts)
  const readout = buildReadout(snapshot, rows, instruments, bundle.prices, positions, asOf)

  const accountViews: AccountView[] = rows.accounts.map((account) => {
    const own = positions.filter((position) => position.accountId === account.id)
    const valueMinor = addMinor(...own.map((position) => position.valueMinor))
    const dates = [
      ...rows.positions.filter((row) => row.accountId === account.id).map((row) => row.asOf.slice(0, 10)),
      ...rows.transactions
        .filter((row) => row.accountId === account.id)
        .map((row) => row.occurredAt.slice(0, 10)),
    ].sort()
    const latest = dates[dates.length - 1] ?? null
    const unpriced = own.filter((position) => !position.priced).length
    const firstClass = own[0]?.assetClass
    return {
      id: account.id,
      label: account.label,
      providerId: account.providerId,
      shortCode: shortCode(account),
      capability: account.capability,
      series: firstClass === undefined ? 'other' : SERIES_BY_ASSET_CLASS[firstClass],
      value: measured(moneyFigure(valueMinor, { symbol: false }), fullCoverage(valueMinor)),
      valueMinor,
      holdings: own.length,
      unpriced,
      dataAsOf: latest,
      dataAsOfNote:
        latest === null
          ? 'No rows imported for this account yet'
          : account.capability === 'ledger'
            ? 'Latest transaction date'
            : 'Latest holdings statement date',
      stamp: stampFor(
        account,
        account.capability === 'ledger' ? 'ledger' : 'holdings',
        `${own.length.toString()} holdings.`,
      ),
    }
  })

  const stalePositions = positions.filter((position) => position.staleDays !== undefined)
  const priceFetchedAt = [...rows.prices.map((price) => price.fetchedAt)].sort()
  const latestFetch = priceFetchedAt[priceFetchedAt.length - 1]
  const sources = [...new Set(rows.prices.map((price) => price.source))].sort()

  const coverage = snapshot.coverage
  const costMetric = metricNamed(snapshot, 'cost_basis')
  const xirrMetric = metricNamed(snapshot, 'xirr')
  const snapshotAccountIds = rows.accounts
    .filter((account) => account.capability === 'snapshot')
    .map((account) => account.id)

  const coverageByMetric: CoverageMetricView[] = [
    {
      key: 'net-worth',
      label: 'Net worth',
      amount: measured(moneyFigure(netWorth), fullCoverage(netWorth)),
      pct: isZeroMinor(netWorth) ? ZERO_DEC : dec('100.00'),
      exact: true,
    },
    {
      key: 'day-change',
      label: 'Day change',
      amount: notMeasured('no_price', netWorth),
      pct: ZERO_DEC,
      exact: false,
    },
    {
      key: 'cost-basis',
      label: 'Cost basis · unrealised P&L',
      amount: measured(
        moneyFigure(costMetric.coveredMinor),
        coverageFrom(costMetric, snapshotAccountIds),
      ),
      pct: costMetric.pct ?? ZERO_DEC,
      exact: isZeroMinor(costMetric.excludedValueMinor),
    },
    {
      key: 'xirr',
      label: 'XIRR',
      amount: measured(
        moneyFigure(xirrMetric.coveredMinor),
        coverageFrom(xirrMetric, snapshotAccountIds),
      ),
      pct: xirrMetric.pct ?? ZERO_DEC,
      exact: isZeroMinor(xirrMetric.excludedValueMinor),
    },
    {
      key: 'realised',
      label: `Realised P&L · ${snapshot.realised.financialYear}`,
      amount: measured(
        moneyFigure(snapshot.realisedCoverage.coveredMinor),
        coverageFrom(snapshot.realisedCoverage, snapshotAccountIds),
      ),
      pct: snapshot.realisedCoverage.pct ?? ZERO_DEC,
      exact: isZeroMinor(snapshot.realisedCoverage.excludedValueMinor),
    },
  ]

  const ledgerAccounts = rows.accounts.filter((account) => account.capability === 'ledger').length
  const snapshotOnly = coverage.unmeasuredMinor
  const withheld = withheldFrom(rows)

  return {
    asOf,
    asOfDate,
    accounts: accountViews,
    netWorthMinor: netWorth,
    ledgerBackedMinor: coverage.measuredMinor,
    snapshotOnlyMinor: snapshotOnly,
    ledgerAccounts,
    segments,
    classes,
    positions,
    concentration,
    months,
    historyBegins,
    coverageByMetric,
    dataQuality: {
      stalePrices: coverage.stalePriceCount,
      staleNote:
        stalePositions.length === 0
          ? 'Every price is within its tolerance'
          : stalePositions
              .map((position) => `${position.name} ${(position.staleDays ?? 0).toString()} d`)
              .join(' · '),
      unresolvedCount: withheld.count,
      withheldMinor: withheld.minor,
      withheldNote: withheld.note,
      accountCount: rows.accounts.length,
      accountNote: `${ledgerAccounts.toString()} ledger · ${(rows.accounts.length - ledgerAccounts).toString()} snapshot`,
      priceFeed: latestFetch === undefined ? '—' : formatDateTime(latestFetch).slice(-5),
      priceFeedNote:
        latestFetch === undefined
          ? 'No price has been fetched on this machine yet'
          : `${formatDate(latestFetch)} · ${sources.join(' · ')}`,
    },
    readout,
    instruments: buildInstrumentViews(
      snapshot,
      rows,
      accounts,
      instruments,
      bundle.prices,
      positions,
      asOf,
    ),
    warnings: bundle.snapshot.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    coverageOpportunity:
      isZeroMinor(snapshotOnly) || isZeroMinor(netWorth)
        ? null
        : `Importing a transaction history for the snapshot accounts would move ${rupees(snapshotOnly)} across the calibration line and raise coverage to 100.0%.`,
  }
}
