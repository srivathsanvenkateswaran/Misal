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
  currencyCode,
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
  type NotMeasuredReason,
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
  type XirrError,
  type FxRateAge,
  FxTable,
  fxRateAge,
  xirrForScope,
} from '@valuation/index'
import type { Figure } from '@ui/figure'
import { moneyFigure, pctFigure, qtyFigure } from '@ui/figure'
import { formatMoney, money, roundDec } from '@ui/format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '@ui/metrics'
import type { SeriesToken } from '@ui/metrics'
import type { SourceStampProps } from '@ui/provenance/SourceStamp'
import type { CalibrationSegment } from '@ui/charts/CalibrationBar'
import type { ConcentrationRow } from '@ui/charts/ConcentrationChart'
import type { NavPoint } from '@ui/charts/NavHistoryChart'
import type { StackMonth } from '@ui/charts/NetWorthStackChart'
import type { AccountRow, PortfolioRows, TxnRow, UnresolvedRow } from '../data/client'
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
  /**
   * Cost basis per unit, **in rupees**, and the figure carries `INR` as its unit because of it.
   *
   * It divides `pair.costMinor`, which is already through `costInInr`, so it is not in the same
   * unit as `lastPrice` beside it for any foreign holding. See `buildPosition`.
   */
  readonly avgCost: Measured<Figure>
  /** The stored close, in the instrument's own currency. Native, unlike `avgCost`. */
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
  /**
   * The same rupees `amount` prints, as an integer, so a caller writing the sentence "covers X of Y
   * (Z%)" takes all three from one object.
   *
   * It exists because the Holdings foot did not: it took the rupees from the ledger/snapshot
   * *capability* split and the percentage from this metric, which are different populations. A
   * ledger pair whose cost cannot be converted is in the first and not the second, and the foot
   * then stated ₹19.13 lakh at 36.8% of ₹21.53 lakh — a fraction that is 88.85%.
   */
  readonly coveredMinor: Minor
  readonly pct: Dec
  readonly exact: boolean
}

export interface DataQualityView {
  readonly stalePrices: number
  readonly staleNote: string
  readonly unresolvedCount: number
  /**
   * The rupee total of the unresolved rows that *stated* a value.
   *
   * Not the amount withheld: rows whose source stated no value are withholding an unknown amount,
   * and they are counted in `withheldNote` rather than folded in here as zeros. Read this figure
   * only beside that note.
   */
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
  /**
   * The lot's cost **in the currency it was acquired in**, never converted.
   *
   * `OpenLot.costMinor` is native — a dollar vest is dollars — while the "Invested — FIFO cost"
   * tile above the same table comes from `pair.costMinor`, which the engine has already put through
   * `costInInr`. The two are different quantities and this one says which it is: the figure carries
   * its own symbol, and `currency` is on the row for anything that needs to name it.
   */
  readonly cost: Measured<Figure>
  readonly currency: CurrencyCode
  readonly origin: OpenLot['origin']
  readonly stamp: SourceStampProps
}

export interface TxnView {
  readonly id: string
  readonly occurredOn: IsoDate
  readonly type: string
  readonly accountLabel: string
  readonly quantity: Dec
  /** The stored per-unit price, in `currency`. A USDT-quoted fill's price is USDT, not rupees. */
  readonly price: Dec | null
  /**
   * The stored amount, in `currency` — the row's own, never converted to rupees by this layer.
   *
   * Withheld rather than printed when the stored code is one this build has no formatting rule
   * for: a `BTCUSDT` fill carries no `amount_minor` at all, and an amount whose unit cannot be
   * named is not a figure the interface is allowed to show.
   */
  readonly amount: Measured<Figure>
  /** The stored code as a reader sees it — 'INR', 'USD', 'USDT'. Displayed with every amount. */
  readonly currency: string
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
  /**
   * Every stored `price` row for this instrument, in its own currency, oldest first.
   *
   * Passed to the chart untouched: no filling of missing dates, no month-ending, no resampling.
   * A period with no row is a period Misal has no price for, and the chart draws it as one.
   */
  readonly priceHistory: readonly NavPoint[]
}

export interface PortfolioData {
  readonly asOf: IsoInstant
  readonly asOfDate: IsoDate
  readonly accounts: readonly AccountView[]
  readonly netWorthMinor: Minor
  readonly ledgerBackedMinor: Minor
  readonly snapshotOnlyMinor: Minor
  readonly ledgerAccounts: number
  /**
   * Holdings the engine could price at all — zero of them, not merely some.
   *
   * It travels with the calibration figures because it is the thing that stops them being read as
   * completeness. An unpriced position contributes to neither `ledgerBackedMinor` nor
   * `snapshotOnlyMinor` — there is no value to add — so a portfolio whose *only* snapshot account
   * is entirely unpriced reports a perfectly clean 100% split over the part it can see, and the
   * indicator improves precisely as the data gets worse. `coverage.ts` states the rule in its own
   * header: unpriced positions cap priced coverage below 100%. This is what carries it to a screen.
   */
  readonly unpricedCount: number
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

/**
 * Digits past the point in a canonical decimal string. `'0.00001234'` → 8.
 *
 * The same reading `NavHistoryChart` takes of its own points, and for the same reason: the stored
 * string is the only statement of how precise the number is.
 */
function fractionDigits(value: Dec): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

/** True when `decimals` places would print this value as a row of zeros. */
function roundsToZero(value: Dec, decimals: number): boolean {
  const { intDigits, fracDigits } = roundDec(value, decimals)
  return BigInt(intDigits + fracDigits) === 0n
}

/**
 * Past this the tail of a division is being read as stored precision. It is also the chart's cap,
 * so the two never disagree about how many digits a price has.
 */
const MAX_PRICE_DECIMALS = 8

/**
 * How many decimals a per-unit figure needs.
 *
 * Four for a NAV, two for a quote — until the convention would print the price as `0.00`. SHIB is
 * in the shipped seed catalogue and trades near $0.00001, so "Last price" and "Avg cost" read
 * `0.00` beside a correct non-zero Value, three lines under a chart drawing the real digits because
 * it derives its precision from the data rather than from the asset class. This derives it from the
 * data too: a value that survives rounding keeps the convention exactly as before, and one that
 * does not gets the digits its stored string actually carries, capped so a `divDec` tail is not
 * mistaken for precision anyone stored.
 *
 * A genuine zero still prints `0.00`. Zero is a measurement here, not a rounding artefact.
 */
function priceDecimals(assetClass: AssetClass, value: Dec): number {
  const base = assetClass === 'mutual_fund' ? 4 : 2
  if (!roundsToZero(value, base)) return base
  const stored = fractionDigits(value)
  if (stored <= base) return base
  return stored > MAX_PRICE_DECIMALS ? MAX_PRICE_DECIMALS : stored
}

/**
 * The stored currency code as a reader sees it: `X:USDT` is a namespace plus a unit, and the unit
 * is what belongs beside a number. Migration 0002 reserves `X:` for anything with no minor unit and
 * no rupee rate — a `BTCUSDT` fill is quoted in USDT and is not money this build can total.
 */
function displayCurrency(raw: string): string {
  return raw.startsWith('X:') ? raw.slice(2) : raw
}

/**
 * The stored code as a currency this build can *format*, or null when it is not one.
 *
 * Null is not a failure to handle: it is the answer for every crypto-quoted amount, and the caller
 * withholds the figure rather than printing it under whatever unit happens to be nearest.
 */
function formattableCurrency(raw: string): CurrencyCode | null {
  try {
    return currencyCode(raw)
  } catch {
    return null
  }
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
 * backwards, because there is no code path here that could carry anything — and the only way to
 * keep that sentence true is for *every* row this engine reads to be filtered, not most of them.
 *
 * `fxRates` is the one that was missed, and it was the one that mattered most. `FxTable.latest`
 * returns the newest row it holds and its age bound is deliberately one-sided — a rate dated after
 * the valuation date is not stale, because a provider quoting ahead of IST puts one there routinely
 * — so an unfiltered table answered every past month with *today's* rate. Every foreign holding in
 * every historical column then converted at today's rate while the prices beside it were that
 * month's closes: the currency leg of a year of history drawn flat by construction, and drawn
 * without a mark, because nothing in the column knew. Crypto is inside this too — those pairs carry
 * `X:USDT`.
 *
 * Filtering it hands `latest` the same seven-day bound it applies live. A month whose stored rates
 * are older than that drops its foreign holdings out of the column rather than dating them from the
 * future, which is the product's stated preference everywhere else: not measured, and said so.
 */
function rowsAsAt(rows: PortfolioRows, monthEnd: IsoDate): PortfolioRows {
  return {
    ...rows,
    transactions: rows.transactions.filter((txn) => txn.occurredAt.slice(0, 10) <= monthEnd),
    positions: rows.positions.filter((position) => position.asOf.slice(0, 10) <= monthEnd),
    prices: rows.prices.filter((price) => price.asOf.slice(0, 10) <= monthEnd),
    fxRates: rows.fxRates.filter((rate) => rate.asOf.slice(0, 10) <= monthEnd),
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

/**
 * Twelve month-end columns, each one the engine's own answer over that month's rows.
 *
 * Two things can be wrong with a month and only one of them used to be said. A month with nothing
 * to fold produces no value and is gapped. A month that folds holdings but cannot price all of them
 * produces a *partial* value — `aggregateByClass` skips a pair whose `marketValue` is not measured
 * — and that used to be pushed as an ordinary column: full height, exact rupee total in the
 * accessible table, no mark. There is no historical price backfill in this product, so price rows
 * begin the day an instrument is first refreshed while the fold produces holdings for every month
 * the transactions cover; the months before that quietly omit whole asset classes, and the month
 * pricing begins draws a step that is an artefact of the price table rather than a movement in net
 * worth.
 *
 * The engine already counts them. `coverage.breakdown.unpricedCount` was computed at this very call
 * site and never read; it now travels onto the column, which is what lets the chart refuse to draw
 * a partial month as a complete one.
 *
 * There is a third state, and it was the one being told as the first. A month can price *nothing*
 * it holds — every price row dated after that month end — and its net worth is then zero, which
 * sent it down the gap branch with the real `unpricedCount` thrown away and a literal `0` pushed in
 * its place. "No history" and "held, and not one holding could be priced" are opposite statements
 * about the same rows, and this is the default state of any install younger than twelve months of
 * refreshes: nothing calls `fetchHistory`, so after one refresh every stored price is dated today
 * and every earlier column prices nothing. Eleven columns then read as an empty portfolio, and the
 * chart annotated "HISTORY BEGINS <this month>" over an imported ledger going back years.
 *
 * So the count is carried into that branch too, and a month that held something carries `segments:
 * []` rather than `null` — priced value of zero, which is what was actually measured — so the
 * chart's floor treatment applies: an open cap, "at least ₹0", and the instrument count that says
 * why. `null` is kept for its original and only meaning, a month with nothing in it at all.
 *
 * `!bundle.snapshot.ok` has no breakdown to read, so it states no count: `unpricedCount` is
 * optional precisely so a caller with nothing to say can leave it out, and a zero there would be a
 * claim this branch cannot support.
 */
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
    if (!bundle.snapshot.ok) {
      months.push({ key: monthEnd, label, year, segments: null })
      continue
    }
    if (isZeroMinor(bundle.snapshot.value.netWorthMinor)) {
      const unpricedCount = bundle.snapshot.value.coverage.breakdown.unpricedCount
      months.push({
        key: monthEnd,
        label,
        year,
        segments: unpricedCount === 0 ? null : [],
        unpricedCount,
      })
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
      unpricedCount: bundle.snapshot.value.coverage.breakdown.unpricedCount,
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
  fxAges: ReadonlyMap<CurrencyCode, FxRateAge>,
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
    /*
     * Rupees per unit, and it says so.
     *
     * `pair.costMinor` has already been through `costInInr`, so this quotient is INR per unit
     * whatever the instrument is quoted in — while `lastPrice`, in the very next column of the
     * same row, is the stored close in the instrument's own currency. For Caterpillar the two read
     * "28,705.82" and "376.20" under headers that named no unit at all: a 98.7% loss stated two
     * columns from an unrealised percentage of +14.67.
     *
     * Converted is the right choice rather than native. The cost basis this divides is the one the
     * engine computes, the one `cost_inr`, `unrealised_inr` and the FIFO tile all show, and the one
     * Indian tax is assessed in; a native average would be a second cost basis that disagreed with
     * every rupee figure beside it. So the unit travels *with the figure* rather than being
     * asserted by a header — the same repair the lot table's native cost took, in the other
     * direction — because the header over this column also carries a portfolio total on the
     * Holdings screen and cannot name one unit for both.
     */
    const perUnit = divDec(minorToDec(pair.costMinor.value, 'INR'), pair.quantity)
    avgCost = measured(
      qtyFigure(perUnit, {
        precision: priceDecimals(instrument.assetClass, perUnit),
        unit: 'INR',
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
  const lastPrice: Measured<Figure> = read.ok
    ? measured(
        qtyFigure(read.value.close, {
          precision: priceDecimals(instrument.assetClass, read.value.close),
        }),
        fullCoverage(valueMinor),
      )
    : notMeasured('no_price', valueMinor)

  /*
   * A foreign holding's rupee value is a price times a rate, and both factors can be old. Until
   * this line existed only the price could say so: a holding converted at a week-old rate showed
   * no stale marker at all, while a week-old *price* was counted, hatched and named — so the
   * quieter of the two errors was the one with no indicator, and the coverage panel's stale count
   * agreed with it.
   *
   * The staler of the two governs, because the figure on screen is no fresher than its oldest
   * input. A rupee holding has no rate and is unaffected.
   */
  const fxAge = fxAges.get(instrument.currency) ?? null
  const priceStale = age !== null && age.staleness !== 'fresh'
  const fxStale = fxAge !== null && fxAge.staleness !== 'fresh'
  const staleDays = !priceStale && !fxStale
    ? undefined
    : fxStale && (age === null || fxAge.ageDays > age.ageDays)
      ? fxAge.ageDays
      : (age?.ageDays ?? fxAge?.ageDays)

  const priceNote =
    age === null
      ? fxAge === null
        ? undefined
        : `${instrument.currency} · rate ${fxAge.ageDays.toString()} d old`
      : fxStale
        ? `${instrument.currency} · ${age.ageDays.toString()} d old · rate ${fxAge.ageDays.toString()} d old`
        : `${instrument.currency} · ${age.ageDays.toString()} d old`

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

/**
 * Σ cost over every pair whose cost is measured — the Invested tile, and a **larger** set than the
 * P&L tile beside it.
 *
 * `costInInr` converts each lot at its own acquisition-date rate and needs no current price at all,
 * so a holding that drops out of net worth — no price row, no current rate — keeps a measured cost
 * and loses its P&L. Nothing else in this file may divide one of these figures by the other; see
 * `sumPnlCost`.
 */
function sumMeasuredCost(pairs: readonly PairValue[]): Minor {
  return addMinor(...pairs.map((pair) => (pair.costMinor.measured ? pair.costMinor.value : ZERO_MINOR)))
}

function sumMeasuredPnl(pairs: readonly PairValue[]): Minor {
  return addMinor(
    ...pairs.map((pair) => (pair.unrealised.measured ? pair.unrealised.value.pnlMinor : ZERO_MINOR)),
  )
}

/**
 * Σ cost over the pairs the P&L figure is summed over — its own denominator, not the tile's.
 *
 * `UnrealisedPnL.costMinor` is the same rupee cost `sumMeasuredCost` counts, carried on the pair
 * that produced the P&L, so this is the cost of exactly the holdings in the numerator and the two
 * cannot drift. Dividing by `sumMeasuredCost` instead understated the return of a portfolio holding
 * one unpriced position by 2.4× on the fixture corpus, with no indicator moving: the coverage badge
 * beside each figure is weighted by market value, which is zero for precisely the pairs that
 * diverge, so both cells showed the same percentage of the same total.
 */
function sumPnlCost(pairs: readonly PairValue[]): Minor {
  return addMinor(
    ...pairs.map((pair) => (pair.unrealised.measured ? pair.unrealised.value.costMinor : ZERO_MINOR)),
  )
}

/**
 * What the Invested tile counts, what it leaves out, and what it counts that no P&L figure does.
 *
 * Three separate statements, because they have three separate remedies. Snapshot value is excluded
 * for want of a transaction history, which an import fixes. Ledger value excluded from the cost
 * metric is a *ledger* account whose cost could not be converted — an acquisition-date exchange
 * rate the backfill has not reached — and naming it "snapshot holdings" sent the user to import a
 * statement they already have. And the unpriced cost inside the tile is the gap between this
 * figure's population and the P&L figure's, which nothing on the screen otherwise discloses.
 */
function costNoteFor(
  costMetric: MetricCoverage,
  snapshotAccountIds: readonly string[],
  unpricedCostMinor: Minor,
): string {
  const snapshotIds = new Set(snapshotAccountIds)
  const excludedSnapshotMinor = addMinor(
    ...costMetric.excludedPairs
      .filter((pair) => snapshotIds.has(pair.accountId))
      .map((pair) => pair.valueMinor),
  )
  const excludedLedgerMinor = subMinor(costMetric.excludedValueMinor, excludedSnapshotMinor)

  const parts = ['Ledger accounts only']
  if (!isZeroMinor(excludedSnapshotMinor)) {
    parts.push(`excludes ${rupees(excludedSnapshotMinor)} of snapshot holdings`)
  }
  if (!isZeroMinor(excludedLedgerMinor)) {
    parts.push(
      `excludes ${rupees(excludedLedgerMinor)} of ledger holdings whose cost could not be measured`,
    )
  }
  if (!isZeroMinor(unpricedCostMinor)) {
    parts.push(
      `includes ${rupees(unpricedCostMinor)} of cost for holdings with no current value, which no P&L figure counts`,
    )
  }
  return parts.join(' · ')
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
  // The P&L figure's own cost, over the P&L figure's own holdings. The difference between the two
  // is cost the tile states and no return can be computed against.
  const pnlCostMinor = sumPnlCost(snapshot.pairs)
  const unpricedCostMinor = subMinor(costMinor, pnlCostMinor)
  const anyCost = !isZeroMinor(costMetric.coveredMinor)
  const anyPnl = !isZeroMinor(unrealisedMetric.coveredMinor)

  const costBasis: Measured<Figure> = anyCost
    ? measured(moneyFigure(costMinor), coverageFrom(costMetric, snapshotAccountIds))
    : notMeasured('no_transaction_history', netWorth)

  const unrealised: Measured<Figure> = anyPnl
    ? measured(moneyFigure(pnlMinor, { signed: true }), coverageFrom(unrealisedMetric, snapshotAccountIds))
    : notMeasured('no_transaction_history', netWorth)

  const unrealisedPct: Measured<Figure> =
    anyPnl && !isZeroMinor(pnlCostMinor)
      ? measured(
          pctFigure(shareOf(pnlMinor, pnlCostMinor), { signed: true }),
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
      ? costNoteFor(costMetric, snapshotAccountIds, unpricedCostMinor)
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
 * The stored daily FX table, seeded from the same rows the valuation itself uses.
 *
 * An empty table is not a neutral default here any more than it is in `valueFromRows`, which
 * carries the same warning. `buildCashflows` refuses to impute a rate rather than fall back to
 * today's, so a single foreign transaction with no per-row `fx_rate` returns `MISSING_FX` — and
 * because XIRR is computed over the whole scope at once, that one row withholds the figure for
 * every rupee-denominated holding beside it. Worse, the engine's own coverage rule (`pairFxUsable`)
 * counts a pair as XIRR-eligible whenever this table can price its transactions, so an empty table
 * here puts a coverage percentage on screen beside a figure that was never attempted.
 *
 * This recovers the flows the stored table can date. It is not everything: `refresh.ts` fetches
 * only `latest` and `FxTable.on` backfills three days, so a vest older than the stored rates still
 * returns `MISSING_FX` — now named as such rather than blamed on absent history.
 */
function fxTableFrom(rows: PortfolioRows): FxTable {
  return new FxTable(
    rows.fxRates.map((row) => ({
      base: row.base,
      quote: row.quote,
      asOf: row.asOf,
      rate: dec(row.rate),
      source: row.source,
    })),
  )
}

/**
 * How old the rate each foreign holding was converted at is, by currency.
 *
 * Only currencies actually held are asked about, and only rates the engine would actually have
 * used: `FxTable.latest` is the same read `valueFromRows` converts through, so what this reports
 * is the age of the number in the total rather than the age of the newest row in the table.
 *
 * A currency whose rate `latest` refuses — older than `MAX_FX_LATEST_AGE_DAYS`, or never stored —
 * yields no entry. That is not an omission: those holdings are out of net worth entirely and the
 * engine already raises a warning naming them, which is a louder signal than an age. This map is
 * for the band below that bound, where the conversion happens and nothing said how old it was.
 */
function fxAgesFrom(
  fx: FxTable,
  instruments: ReadonlyMap<string, InstrumentRef>,
  pairs: readonly PairValue[],
  valuationDate: IsoDate,
): ReadonlyMap<CurrencyCode, FxRateAge> {
  const ages = new Map<CurrencyCode, FxRateAge>()
  for (const pair of pairs) {
    const currency = instruments.get(pair.instrumentId)?.currency
    if (currency === undefined || currency === 'INR' || ages.has(currency)) continue
    const rate = fx.latest(currency, 'INR', valuationDate)
    if (!rate.ok) continue
    ages.set(
      currency,
      fxRateAge({ pair: `${currency}/INR`, asOf: rate.value.asOf, valuationDate }),
    )
  }
  return ages
}

/**
 * Why an XIRR could not be produced, in the fixed vocabulary the user actually reads.
 *
 * Exhaustive over `XirrError` on purpose: the previous mapping sent everything that was not
 * `MISSING_PRICE` to `no_transaction_history`, which printed "no transaction history" above the
 * very lot table listing that history. A rate we do not hold and a series that will not converge
 * are different failures with different remedies, and the type already has a member for each.
 */
function xirrReason(code: XirrError['code']): NotMeasuredReason {
  switch (code) {
    case 'MISSING_PRICE':
      return 'no_price'
    case 'MISSING_FX':
      return 'no_fx_rate'
    case 'NO_SIGN_CHANGE':
    case 'NO_BRACKET':
    case 'NOT_CONVERGED':
      // The cash flows are all present; no rate solves them. Saying "no transaction history" of a
      // series built *from* that history is the denial this mapping exists to stop.
      return 'no_convergence'
    case 'INSUFFICIENT_CASHFLOWS':
    case 'MISSING_ACQUISITION_COST':
    case 'SCOPE_NOT_MEASURED':
      return 'no_transaction_history'
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
    fx: fxTableFrom(rows),
    prices,
    asOf,
  })

  if (!outcome.ok) {
    return {
      xirr: notMeasured(xirrReason(outcome.error.code), netWorth),
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
 * What the unresolved rows are holding out of every total, counted the way the review queue counts
 * it.
 *
 * H8 requires the unresolved count to be accompanied by the exact amount excluded from totals.
 * `ValuationSnapshot.coverage.withheldMinor` is the natural source, but the data layer maps
 * `unresolved_instrument` rows without a `resolvedAt` field, and the engine filters on
 * `resolvedAt === null` — so every unresolved row is dropped before it is counted and the engine
 * reports zero withheld however many rows exist. Reading the rows here is not a second valuation:
 * it is a count and a sum of a column the core already stores.
 *
 * **A row with no stated value is not a row worth zero.** This is `summariseWithheld` and
 * `withheldCaveat` from `src/screens/settings/review.ts`, ported rather than imported because that
 * module counts `ReviewQueueEntry` and this one counts `UnresolvedRow`; the rule is the same rule
 * and its header states it: "a zero reads as 'worth nothing' for a holding whose value is merely
 * unknown, which is the exact lie the queue exists to prevent."
 *
 * It was the *default* case that was wrong, which is why it survived. `record_unresolved` inserts
 * neither `observed_value_minor` nor `currency`, so every coin an exchange sync cannot name is
 * NULL/NULL, and a tradebook with no valuation column reaches the same place. Both were bucketed as
 * INR and mapped to `ZERO_MINOR`, so two such rows printed "Unresolved instruments: 2" directly
 * above "₹0 withheld from every total" — and the mixed case was sharper still, because three rows
 * of which one carried a value printed one exact-looking figure that silently omitted the other
 * two. `valuation/portfolio.ts`, `settings/review.ts` and `UnresolvedQueue.tsx` all already refused
 * that; only the dashboard did not, and it disagreed with all three about the same rows.
 */
interface WithheldSummary {
  /** Σ of the rows that stated a rupee value. Never a stand-in for the rows that stated none. */
  readonly minor: Minor
  /** Rows that stated a rupee value, and so are inside `minor`. */
  readonly stated: number
  /** Rows whose source stated no value at all. Counted, never coerced. */
  readonly unstated: number
  /** Rows stating a value in a currency this total cannot absorb. Counted, never converted. */
  readonly foreign: number
  readonly count: number
}

function summariseWithheld(unresolved: readonly UnresolvedRow[]): WithheldSummary {
  let total: Minor = ZERO_MINOR
  let stated = 0
  let unstated = 0
  let foreign = 0

  for (const row of unresolved) {
    const raw = row.observedValueMinor
    // The value is tested before the currency, exactly as `review.ts` tests it: a row with neither
    // is a row whose amount is unknown, not a row in an unknown currency.
    if (raw === null || raw === '') {
      unstated += 1
      continue
    }
    if (row.currency !== null && row.currency !== 'INR') {
      foreign += 1
      continue
    }
    let parsed: Minor
    try {
      parsed = minor(raw)
    } catch {
      // A half-parsed figure is the one thing that must not become a plausible total.
      unstated += 1
      continue
    }
    total = addMinor(total, parsed)
    stated += 1
  }

  return { minor: total, stated, unstated, foreign, count: unresolved.length }
}

/** The clauses that must travel beside the figure, so a total is never read as covering more. */
function withheldCaveats(summary: WithheldSummary): readonly string[] {
  const parts: string[] = []
  if (summary.unstated > 0) {
    parts.push(`plus ${summary.unstated.toString()} whose amount the source did not state`)
  }
  if (summary.foreign > 0) {
    parts.push(`plus ${summary.foreign.toString()} in a currency this total cannot absorb`)
  }
  return parts
}

function withheldFrom(rows: PortfolioRows): {
  readonly count: number
  readonly minor: Minor
  readonly note: string
} {
  const summary = summariseWithheld(rows.unresolved)
  if (summary.count === 0) {
    return { count: 0, minor: ZERO_MINOR, note: 'Every identifier in every document is mapped' }
  }
  const caveats = withheldCaveats(summary)
  // Nothing quantifiable at all: there is no figure, and the sentence says so rather than printing
  // the zero that the arithmetic would otherwise hand over.
  if (summary.stated === 0) {
    const reason =
      summary.unstated === 0
        ? 'every value is in a currency this total cannot absorb'
        : summary.foreign === 0
          ? 'the source stated no value'
          : 'the source stated no value Misal can total'
    return {
      count: summary.count,
      minor: ZERO_MINOR,
      note: `Amount withheld is unknown, not zero — ${reason}`,
    }
  }
  return {
    count: summary.count,
    minor: summary.minor,
    note: [`${rupees(summary.minor)} withheld from every total`, ...caveats].join(' · '),
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Why an aggregate over these positions could not be totalled, in the words the rows themselves
 * use.
 *
 * Taken from the first unpriced member rather than fixed at `no_price`, so the instrument tile and
 * the account row say "Not converted — no exchange rate for this date" wherever the position row
 * beneath them says it. Two different sentences about one holding read as two different problems.
 */
function unpricedReasonOf(positions: readonly PositionView[]): NotMeasuredReason {
  for (const position of positions) {
    if (!position.value.measured) return position.value.reason
  }
  return 'no_price'
}

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
  // Built once, not once per instrument: the table is a read-through index over the same rows.
  const fx = fxTableFrom(rows)

  return ids
    .map((id): InstrumentView | null => {
      const instrument = instruments.get(id)
      if (instrument === undefined) return null
      const own = positions.filter((position) => position.instrumentId === id)
      const pairs = snapshot.pairs.filter((pair) => pair.instrumentId === id)

      const valueMinor = addMinor(...own.map((position) => position.valueMinor))
      // The sum above is the *priced* value: `buildPosition` writes `ZERO_MINOR` into `valueMinor`
      // for a holding it could not price, because the sibling `value` field takes the false branch
      // and there is no rupee figure to carry. Summing those zeros and publishing the result as
      // measured re-asserts, one level up, exactly what the position row declined to say.
      const allPriced = own.length > 0 && own.every((position) => position.priced)
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
          fx,
          prices,
          asOf,
        })
        if (!outcome.ok) {
          xirr = notMeasured(xirrReason(outcome.error.code), valueMinor)
        } else if (outcome.value.unstable) {
          xirr = notMeasured('no_convergence', valueMinor)
        } else {
          xirr = measured(
            pctFigure(mulDec(outcome.value.rate, dec('100'))),
            partialCoverage(measuredValue, valueMinor, []),
          )
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
              // Native, and stated as native. `symbol: false` would hand this to a column whose
              // header says rupees; the lot's own currency and its own symbol travel with it.
              cost: lot.costKnown
                ? measured<Figure>(
                    moneyFigure(lot.costMinor, {}, lot.currency),
                    fullCoverage(lot.costMinor),
                  )
                : notMeasured<Figure>('no_transaction_history', ZERO_MINOR),
              currency: lot.currency,
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
          const txnCurrency = formattableCurrency(txn.currency)
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
                : txnCurrency === null
                  ? // An amount in a unit this build cannot format is counted by nothing and
                    // printed by nothing. Rendering it bare would put a crypto quantity under a
                    // rupee heading, which is the failure this branch exists to refuse.
                    notMeasured<Figure>('no_fx_rate', ZERO_MINOR)
                  : measured<Figure>(
                      moneyFigure(amountMinor, {}, txnCurrency),
                      fullCoverage(amountMinor),
                    ),
            currency: displayCurrency(txn.currency),
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
              qtyFigure(read.value.close, {
                precision: priceDecimals(instrument.assetClass, read.value.close),
              }),
              fullCoverage(valueMinor),
            )
          : notMeasured<Figure>('no_price', valueMinor),
        /*
         * `age` comes from the pairs, and the engine only dates a price it could actually use: a
         * holding that priced but would not convert has a stored close and no `priceAge`. Saying
         * "no price has been fetched" there contradicted the figure printed directly above it —
         * Caterpillar's tile read 376.20 under that sentence — and pointed the user at a refresh
         * that would fetch a price they already have, instead of at the missing rate.
         */
        lastPriceNote:
          age !== null
            ? `${instrument.currency} · as of ${formatDate(age.asOf)} · ${age.ageDays.toString()} d old · ${age.source}`
            : read.ok
              ? `${instrument.currency} · as of ${formatDate(read.value.asOf)} · ${read.value.source} · not converted to rupees, so this instrument is in no rupee total`
              : 'No price has been fetched for this instrument.',
        positions: own,
        totalQuantity: measured<Figure>(
          qtyFigure(own.length === 0 ? ZERO_DEC : addDec(...own.map((position) => position.quantity)), {
            precision: instrument.precision,
          }),
          fullCoverage(valueMinor),
        ),
        /*
         * Measured only when every holding of this instrument is priced.
         *
         * There is no third branch, and the reason is worth stating: `Coverage` is a pair of rupee
         * amounts, and an unpriced holding contributes a rupee amount to neither side of it — that
         * is what "unpriced" means. So a partly-priced total cannot be qualified by a coverage the
         * way a partly-known cost basis can: `partialCoverage(priced, priced)` reads 100.0%, and
         * 100% is the one value this product documents as meaning complete (see
         * `pricedCoveragePct`). Withholding says the true thing — the total is not known — and the
         * priced subtotal stays on `valueMinor` for the weights, the sort and the export, each of
         * which already asks `priced` per row.
         */
        totalValue: allPriced
          ? measured(moneyFigure(valueMinor, { symbol: false }), fullCoverage(valueMinor))
          : notMeasured<Figure>(unpricedReasonOf(own), valueMinor),
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
        // Rows in the instrument's own currency only. A dollar close and a rupee close on one
        // axis would be a chart of two different things drawn as though it were one.
        priceHistory: rows.prices
          .filter((price) => price.instrumentId === id && price.currency === instrument.currency)
          .map((price) => ({ asOf: price.asOf.slice(0, 10), close: dec(price.close) }))
          .sort((a, b) => (a.asOf < b.asOf ? -1 : 1)),
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

  const fxAges = fxAgesFrom(fxTableFrom(rows), instruments, snapshot.pairs, asOfDate)

  const positions = snapshot.pairs
    .map((pair) =>
      buildPosition(pair, rows, accounts, instruments, bundle.prices, netWorth, fxAges),
    )
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
            // Derived from the members, exactly as `aggregateByClass` downgrades a class: one
            // snapshot holding in the tail makes the whole bucket snapshot-backed. Asserting
            // 'ledger' here drew a solid bar over holdings with no transaction history, and it did
            // so invisibly — H5 counts hatches against `[data-basis="snapshot"]`, so a mislabelled
            // row makes both counts zero and the check passes on a picture that is wrong.
            basis: rest.some((position) => position.capability === 'snapshot')
              ? ('snapshot' as const)
              : ('ledger' as const),
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
      /*
       * The same seam as `totalValue`, and the `unpriced` count on the line above is the proof it
       * was known: the loop computed how many of this account's holdings could not be priced and
       * then published their zeros as a measured rupee total anyway. The Accounts screen badged
       * "1 not priced" beside a value of ₹0; the Dashboard's per-account table carried no
       * qualifier at all.
       *
       * An account with no holdings is a different statement and keeps its measured zero: nothing
       * is missing from that total, and the row's own "No rows imported for this account yet"
       * already says why it is empty.
       */
      value:
        unpriced === 0
          ? measured(moneyFigure(valueMinor, { symbol: false }), fullCoverage(valueMinor))
          : notMeasured<Figure>(unpricedReasonOf(own), valueMinor),
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
  /*
   * Stale rates are counted beside stale prices, in the same indicator, because they are the same
   * defect in the other factor. `coverage.stalePriceCount` comes from the engine and counts price
   * age alone — the residual the FX bound entry in `docs/known-issues.md` left open — so the rates
   * are added here, one per currency rather than one per holding, which is how many rates there
   * actually are and how many separate things can be wrong.
   */
  const staleFxRates = [...fxAges.values()].filter((age) => age.staleness !== 'fresh')
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
      coveredMinor: netWorth,
      pct: isZeroMinor(netWorth) ? ZERO_DEC : dec('100.00'),
      exact: true,
    },
    {
      key: 'day-change',
      label: 'Day change',
      amount: notMeasured('no_price', netWorth),
      coveredMinor: ZERO_MINOR,
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
      coveredMinor: costMetric.coveredMinor,
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
      coveredMinor: xirrMetric.coveredMinor,
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
      coveredMinor: snapshot.realisedCoverage.coveredMinor,
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
    unpricedCount: coverage.breakdown.unpricedCount,
    segments,
    classes,
    positions,
    concentration,
    months,
    historyBegins,
    coverageByMetric,
    dataQuality: {
      stalePrices: coverage.stalePriceCount + staleFxRates.length,
      staleNote:
        stalePositions.length === 0 && staleFxRates.length === 0
          ? 'Every price and exchange rate is within its tolerance'
          : [
              ...stalePositions.map(
                (position) => `${position.name} ${(position.staleDays ?? 0).toString()} d`,
              ),
              ...staleFxRates.map((age) => `${age.pair} rate ${age.ageDays.toString()} d`),
            ].join(' · '),
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
        : // "100.0%" is only true of a portfolio that is priced end to end. With an unpriced
          // holding in it, moving the snapshot value across the line leaves the unpriced part
          // outside every figure on the screen, so the sentence names what it would actually
          // reach instead of promising completeness.
          `Importing a transaction history for the snapshot accounts would move ${rupees(snapshotOnly)} across the calibration line and raise coverage to ${
            coverage.breakdown.unpricedCount === 0
              ? '100.0%'
              : `the whole of the value Misal can price — ${coverage.breakdown.unpricedCount.toString()} ${coverage.breakdown.unpricedCount === 1 ? 'holding has' : 'holdings have'} no stored price and ${coverage.breakdown.unpricedCount === 1 ? 'is' : 'are'} in no figure on this screen`
          }.`,
  }
}
