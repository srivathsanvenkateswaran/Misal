/**
 * The integration layer: positions, prices and FX in, a valuation snapshot out.
 *
 * Everything here is assembly of parts that are individually correct. The one judgement it makes is
 * *what to withhold*, and it makes it in one place so the rules cannot drift apart:
 *
 *  - Market value is computed for every position with a resolved instrument, a usable price and a
 *    usable rate, regardless of whether its history is measured. A snapshot holding is still worth
 *    what it is worth.
 *  - Cost basis, unrealised P&L, realised P&L and XIRR are computed only for measured pairs, and
 *    every pair excluded from a metric is named, with its rupee value, in that metric's coverage.
 */

import {
  type CurrencyCode,
  type Dec,
  type Minor,
  ZERO_MINOR,
  addMinor,
  compareMinor,
  dec,
  decToMinor,
  divDec,
  isZeroMinor,
  minorToDec,
  mulDec,
  subMinor,
} from '@domain/numeric'
import { type Measured, fullCoverage, measured, notMeasured } from '@domain/measured'
import { instantToDate } from './calendar'
import {
  type CoverageReport,
  type ExcludedPair,
  type MetricCoverage,
  type MetricName,
  type ValueBreakdown,
  coverageReport,
  metricCoverage,
} from './coverage'
import type { FoldInput } from './fold'
import type { FxService } from './fx'
import { type DerivedPosition, derivePortfolioPositions } from './positions'
import { priceAge } from './price/staleness'
import type { PriceAge, PricePoint } from './price/types'
import type { PriceService } from './price/service'
import { type Disposal, type RealisedGains, classifyDisposal, summariseRealised } from './tax'
import { financialYear } from './calendar'
import {
  type InstrumentRef,
  type IsoDate,
  type IsoInstant,
  type MeasurementReason,
  type Result,
  type TxnRow,
  type UnresolvedInstrumentRow,
  type Warning,
  ok,
} from './types'

export interface UnrealisedPnL {
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: Dec
  /** INR, at each lot's own historical FX rate. */
  readonly costMinor: Minor
  /** INR, at the current FX rate. */
  readonly marketValueMinor: Minor
  readonly pnlMinor: Minor
  /** Null, never 0, when cost is zero: a bonus-only holding's return is not "flat". */
  readonly pnlPct: Dec | null
  readonly priceAge: PriceAge
}

export interface PairValue {
  readonly accountId: string
  readonly instrumentId: string
  readonly quantity: Dec
  readonly currency: CurrencyCode
  readonly measurement: DerivedPosition['measurement']
  readonly reason: MeasurementReason | null
  /** INR. Not measured when the price or the rate is missing. */
  readonly marketValue: Measured<Minor>
  readonly priceAge: PriceAge | null
  readonly costMinor: Measured<Minor>
  readonly unrealised: Measured<UnrealisedPnL>
  readonly hasPrice: boolean
  readonly hasPriorClose: boolean
  readonly fxUsable: boolean
  readonly disposalsClassified: boolean
}

export interface PortfolioInput {
  readonly accounts: readonly FoldInput[]
  readonly instruments: ReadonlyMap<string, InstrumentRef>
  readonly prices: PriceService
  readonly fx: FxService
  readonly unresolved: readonly UnresolvedInstrumentRow[]
  readonly asOf: IsoInstant
  /** Prior close from the same source, for day change. Absent means day change is unavailable. */
  readonly priorClose?: (instrumentId: string) => PricePoint | null
}

export interface ValuationSnapshot {
  readonly asOf: IsoInstant
  readonly positions: readonly DerivedPosition[]
  readonly pairs: readonly PairValue[]
  readonly disposals: readonly Disposal[]
  readonly realised: RealisedGains
  readonly realisedCoverage: MetricCoverage
  readonly coverage: CoverageReport
  /** `valuedMinor`. Withheld value is never inside it. */
  readonly netWorthMinor: Minor
}

const NO_HISTORY = 'no_transaction_history' as const

function reasonFor(position: DerivedPosition) {
  if (position.reason?.code === 'NO_FX_RATE') return 'no_fx_rate' as const
  return NO_HISTORY
}

function priceReason(code: 'NO_PRICE' | 'NO_PRICE_SOURCE' | 'NO_FX_RATE' | 'NO_FX_SOURCE'): MeasurementReason {
  const message =
    code === 'NO_PRICE'
      ? 'No price has been fetched for this instrument yet.'
      : code === 'NO_PRICE_SOURCE'
        ? 'No price provider covers this instrument. Set a manual price to value it.'
        : 'No exchange rate is available, so this holding cannot be converted to INR.'
  return { status: 'not_measured', code, message, userFixable: true }
}

function pnlPercent(costMinor: Minor, pnlMinor: Minor): Dec | null {
  if (isZeroMinor(costMinor)) return null
  return mulDec(divDec(dec(pnlMinor), dec(costMinor)), dec('100'))
}

/**
 * Cost converted at each lot's *acquisition-date* rate, not today's.
 *
 * The difference between historical-rate cost and current-rate market value is a real economic gain
 * or loss on a foreign holding. Converting both at the same rate nets it out and reports a US
 * position as flat when the rupee has moved 30% underneath it.
 */
function costInInr(position: DerivedPosition, fx: FxService): Measured<Minor> {
  let total = ZERO_MINOR
  for (const lot of position.lots) {
    if (!lot.costKnown) {
      return notMeasured(NO_HISTORY, ZERO_MINOR)
    }
    if (lot.currency === 'INR') {
      total = addMinor(total, lot.costMinor)
      continue
    }
    const rate = lot.fxRate ?? fxRateOn(fx, lot.currency, lot.acquiredOn)
    if (rate === null) return notMeasured('no_fx_rate', ZERO_MINOR)
    total = addMinor(total, decToMinor(mulDec(minorToDec(lot.costMinor, lot.currency), rate), 'INR'))
  }
  return measured(total, fullCoverage(total))
}

function fxRateOn(fx: FxService, currency: CurrencyCode, date: string): Dec | null {
  const result = fx.on(currency, 'INR', date)
  return result.ok ? result.value.rate : null
}

function pairFxUsable(txns: readonly TxnRow[], fx: FxService, currency: CurrencyCode): boolean {
  if (currency === 'INR') return true
  return txns.every(
    (txn) =>
      txn.currency === 'INR' ||
      txn.fxRate !== null ||
      fxRateOn(fx, txn.currency, instantToDate(txn.occurredAt, txn.occurredTz)) !== null,
  )
}

/**
 * Value the whole portfolio.
 *
 * Returns `Ok` with warnings for every data defect. The only `Err` is a malformed input, because
 * one unmeasurable holding must never blank the net-worth figure.
 */
export function valuePortfolio(input: PortfolioInput): Result<ValuationSnapshot> {
  const derived = derivePortfolioPositions(input.accounts)
  if (!derived.ok) return derived
  const warnings: Warning[] = [...derived.warnings]

  const txnsByPair = new Map<string, TxnRow[]>()
  for (const account of input.accounts) {
    for (const txn of account.txns) {
      const key = `${txn.accountId}|${txn.instrumentId}`
      const bucket = txnsByPair.get(key)
      if (bucket === undefined) txnsByPair.set(key, [txn])
      else bucket.push(txn)
    }
  }

  const valuationDate = instantToDate(input.asOf)
  const pairs: PairValue[] = []
  const disposals: Disposal[] = []
  const unpricedInstrumentIds = new Set<string>()
  let valuedMinor = ZERO_MINOR
  let measuredMinor = ZERO_MINOR
  let stalePriceCount = 0
  let stalestPriceAgeDays: number | null = null

  let dividendIncomeMinor = ZERO_MINOR
  let interestIncomeMinor = ZERO_MINOR
  let tdsCreditMinor = ZERO_MINOR

  for (const position of derived.value) {
    const instrument = input.instruments.get(position.instrumentId)
    if (instrument === undefined) {
      return { ok: false, error: { code: 'UNKNOWN_INSTRUMENT', message: `No metadata for ${position.instrumentId}.` }, warnings }
    }

    const priceRead = input.prices.priceAt(position.instrumentId, 'latest')
    const fxRead = input.fx.latest(instrument.currency, 'INR', valuationDate)

    let marketValue: Measured<Minor> = notMeasured('no_price', ZERO_MINOR)
    let age: PriceAge | null = null
    let hasPrice = false

    if (!priceRead.ok) {
      unpricedInstrumentIds.add(position.instrumentId)
      warnings.push({
        code: priceRead.error.code === 'NO_PRICE_SOURCE' ? 'NO_PRICE_SOURCE' : 'NO_PRICE',
        message: `No usable price for ${instrument.displayName}.`,
        ref: { instrumentId: position.instrumentId, accountId: position.accountId },
      })
    } else if (!fxRead.ok) {
      unpricedInstrumentIds.add(position.instrumentId)
      marketValue = notMeasured('no_fx_rate', ZERO_MINOR)
      warnings.push({
        code: fxRead.error.code === 'NO_FX_SOURCE' ? 'NO_FX_SOURCE' : 'NO_FX_RATE',
        // A frozen rate is named as frozen, with its age. "No rate" and "a rate from five weeks
        // ago" are different problems with different fixes, and the second one is the one a user
        // would otherwise never learn about.
        message:
          fxRead.error.code === 'FX_RATE_STALE'
            ? `The newest ${instrument.currency}/INR rate is from ${fxRead.error.asOf}, ${fxRead.error.ageDays.toString()} days before this valuation, so ${instrument.displayName} is excluded from net worth rather than converted at a frozen rate. Refresh prices to store a current rate.`
            : `No INR rate for ${instrument.currency}, so ${instrument.displayName} is excluded from net worth.`,
        ref: { instrumentId: position.instrumentId, accountId: position.accountId },
      })
    } else {
      hasPrice = true
      const staleness = priceAge({
        point: priceRead.value,
        assetClass: instrument.assetClass,
        valuationDate,
      })
      age = staleness.age
      warnings.push(...staleness.warnings)
      if (staleness.age.staleness !== 'fresh') stalePriceCount += 1
      if (stalestPriceAgeDays === null || staleness.age.ageDays > stalestPriceAgeDays) {
        stalestPriceAgeDays = staleness.age.ageDays
      }
      const nativeValue = mulDec(position.quantity, priceRead.value.close)
      const inr = decToMinor(mulDec(nativeValue, fxRead.value.rate), 'INR')
      marketValue = measured(inr, fullCoverage(inr))
      valuedMinor = addMinor(valuedMinor, inr)
      if (position.measurement === 'measured') measuredMinor = addMinor(measuredMinor, inr)
    }

    const cost =
      position.measurement === 'measured'
        ? costInInr(position, input.fx)
        : notMeasured<Minor>(reasonFor(position), marketValue.measured ? marketValue.value : ZERO_MINOR)

    let unrealised: Measured<UnrealisedPnL> = notMeasured(
      position.measurement === 'measured' ? 'no_price' : reasonFor(position),
      marketValue.measured ? marketValue.value : ZERO_MINOR,
    )
    if (marketValue.measured && cost.measured && age !== null && position.measurement === 'measured') {
      const pnlMinor = subMinor(marketValue.value, cost.value)
      unrealised = measured(
        {
          instrumentId: position.instrumentId,
          accountId: position.accountId,
          quantity: position.quantity,
          costMinor: cost.value,
          marketValueMinor: marketValue.value,
          pnlMinor,
          pnlPct: pnlPercent(cost.value, pnlMinor),
          priceAge: age,
        },
        fullCoverage(marketValue.value),
      )
    }

    const ledger = position.ledger
    let disposalsClassified = true
    if (ledger !== null) {
      dividendIncomeMinor = addMinor(dividendIncomeMinor, ledger.income.dividendMinor)
      interestIncomeMinor = addMinor(interestIncomeMinor, ledger.income.interestMinor)
      tdsCreditMinor = addMinor(tdsCreditMinor, ledger.income.tdsMinor)
      if (position.measurement === 'measured') {
        for (const consumption of ledger.consumptions) {
          const disposal = classifyDisposal(consumption, instrument)
          if (disposal === null) continue
          disposals.push(disposal)
          if (disposal.bucket.kind === 'unavailable') disposalsClassified = false
        }
      } else {
        disposalsClassified = false
      }
    } else {
      disposalsClassified = false
    }

    const pairTxns = txnsByPair.get(`${position.accountId}|${position.instrumentId}`) ?? []
    pairs.push({
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      quantity: position.quantity,
      currency: instrument.currency,
      measurement: position.measurement,
      reason: position.reason,
      marketValue,
      priceAge: age,
      costMinor: cost,
      unrealised,
      hasPrice,
      hasPriorClose: hasPrice && (input.priorClose?.(position.instrumentId) ?? null) !== null,
      fxUsable: pairFxUsable(pairTxns, input.fx, instrument.currency),
      disposalsClassified,
    })
  }

  const withheldMinor = addMinor(
    ...input.unresolved
      .filter((row) => row.resolvedAt === null && row.observedValueMinor !== null)
      .map((row) => convertWithheld(row, input.fx, valuationDate)),
  )

  const breakdown: ValueBreakdown = {
    valuedMinor,
    withheldMinor,
    unpricedCount: unpricedInstrumentIds.size,
    unpricedInstrumentIds: [...unpricedInstrumentIds].sort(),
  }

  const perMetric = buildMetrics(pairs, valuedMinor)
  const realisedCoverage =
    perMetric.find((m) => m.metric === 'realised_pnl') ??
    metricCoverage({ metric: 'realised_pnl', included: [], excluded: [], totalMinor: valuedMinor })

  const realised = summariseRealised(
    disposals,
    { dividendIncomeMinor, interestIncomeMinor, tdsCreditMinor },
    financialYear(valuationDate),
  )

  return ok(
    {
      asOf: input.asOf,
      positions: derived.value,
      pairs,
      disposals,
      realised,
      realisedCoverage,
      coverage: coverageReport({
        asOf: input.asOf,
        breakdown,
        measuredMinor,
        perMetric,
        stalePriceCount,
        stalestPriceAgeDays,
        unresolvedInstrumentCount: input.unresolved.filter((row) => row.resolvedAt === null).length,
      }),
      netWorthMinor: valuedMinor,
    },
    warnings,
  )
}

function convertWithheld(row: UnresolvedInstrumentRow, fx: FxService, asOf: IsoDate): Minor {
  const value = row.observedValueMinor ?? ZERO_MINOR
  const currency = row.currency ?? 'INR'
  if (currency === 'INR') return value
  const rate = fx.latest(currency, 'INR', asOf)
  // An unresolved holding in a currency with no rate — or with none current enough to be called
  // today's — contributes nothing rather than an assumed conversion; it is still counted in
  // `unresolvedInstrumentCount`.
  if (!rate.ok) return ZERO_MINOR
  return decToMinor(mulDec(minorToDec(value, currency), rate.value.rate), 'INR')
}

function valueOfPair(pair: PairValue): Minor {
  return pair.marketValue.measured ? pair.marketValue.value : ZERO_MINOR
}

function excluded(pair: PairValue, fallback: MeasurementReason): ExcludedPair {
  return {
    accountId: pair.accountId,
    instrumentId: pair.instrumentId,
    valueMinor: valueOfPair(pair),
    reason: pair.reason ?? fallback,
  }
}

/**
 * Inclusion rules per metric, from the spec's table. Different metrics need different things, so
 * one coverage number cannot serve them all.
 */
function buildMetrics(pairs: readonly PairValue[], totalMinor: Minor): readonly MetricCoverage[] {
  const rules: { metric: MetricName; included: (p: PairValue) => boolean; fallback: MeasurementReason }[] = [
    {
      metric: 'cost_basis',
      included: (p) => p.measurement === 'measured' && p.costMinor.measured,
      fallback: priceReason('NO_PRICE'),
    },
    {
      metric: 'unrealised_pnl',
      included: (p) => p.measurement === 'measured' && p.unrealised.measured,
      fallback: priceReason('NO_PRICE'),
    },
    {
      metric: 'realised_pnl',
      included: (p) => p.measurement === 'measured' && p.disposalsClassified,
      fallback: {
        status: 'not_measured',
        code: 'UNKNOWN_TAX_REGIME',
        message: 'A disposal in this holding could not be classified for tax reporting.',
        userFixable: true,
      },
    },
    {
      metric: 'xirr',
      included: (p) => p.measurement === 'measured' && p.fxUsable && p.hasPrice,
      fallback: priceReason('NO_PRICE'),
    },
    {
      metric: 'day_change',
      included: (p) => p.hasPrice && p.hasPriorClose,
      fallback: priceReason('NO_PRICE'),
    },
  ]

  return rules.map((rule) =>
    metricCoverage({
      metric: rule.metric,
      included: pairs.filter(rule.included).map((p) => ({ valueMinor: valueOfPair(p) })),
      excluded: pairs.filter((p) => !rule.included(p)).map((p) => excluded(p, rule.fallback)),
      totalMinor,
    }),
  )
}

/** Net worth minus every pair's value, for the assertion that the segments reconcile. */
export function reconcilesToTotal(snapshot: ValuationSnapshot): boolean {
  const summed = addMinor(...snapshot.pairs.map(valueOfPair))
  return compareMinor(summed, snapshot.netWorthMinor) === 0
}
