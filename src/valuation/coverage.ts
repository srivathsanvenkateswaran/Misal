/**
 * Coverage metrics.
 *
 * This is a headline feature: the calibration bar and the "not measured" rows are the mechanism by
 * which Misal claims to be honest, so their arithmetic gets the same scrutiny as net worth itself.
 *
 * Three rupee quantities are kept strictly apart:
 *
 *  - `valuedMinor` is net worth. Withheld value is deliberately excluded, because attributing value
 *    to an instrument we cannot identify is the double-counting failure the design spec names as
 *    the worst outcome available.
 *  - `withheldMinor` is displayed beside net worth, never inside it.
 *  - Unpriced positions contribute nothing to any rupee figure and cannot: there is no value to
 *    add. They are a count and an instrument list, and they cap priced coverage below 100%.
 */

import { type Dec, type Minor, ZERO_MINOR, addMinor, dec, subMinor } from '@domain/numeric'
import type { IsoInstant, MeasurementReason, PairRef } from './types'

export interface ValueBreakdown {
  /** Σ market value of positions with a resolved instrument, a usable price and usable FX. */
  readonly valuedMinor: Minor
  /** Σ `unresolved_instrument.observed_value_minor`, converted to INR at the current rate. */
  readonly withheldMinor: Minor
  readonly unpricedCount: number
  readonly unpricedInstrumentIds: readonly string[]
}

export type MetricName = 'cost_basis' | 'unrealised_pnl' | 'realised_pnl' | 'xirr' | 'day_change'

export interface ExcludedPair extends PairRef {
  readonly valueMinor: Minor
  readonly reason: MeasurementReason
}

export interface MetricCoverage {
  readonly metric: MetricName
  readonly coveredMinor: Minor
  /** Always `valuedMinor`, so every metric's coverage is a fraction of the same total. */
  readonly totalMinor: Minor
  readonly pct: Dec | null
  readonly excludedPairs: readonly ExcludedPair[]
  readonly excludedValueMinor: Minor
}

export interface CoverageReport {
  readonly asOf: IsoInstant
  readonly breakdown: ValueBreakdown
  readonly historyCoveragePct: Dec | null
  readonly measuredMinor: Minor
  /** By subtraction from the same total the bar draws, so the two segments sum to the whole bar. */
  readonly unmeasuredMinor: Minor
  readonly perMetric: readonly MetricCoverage[]
  readonly stalePriceCount: number
  readonly stalestPriceAgeDays: number | null
  readonly unresolvedInstrumentCount: number
  readonly withheldMinor: Minor
}

function basisPointsToDec(basisPoints: bigint): Dec {
  const whole = basisPoints / 100n
  const fraction = basisPoints % 100n
  return dec(`${whole.toString()}.${fraction.toString().padStart(2, '0')}`)
}

/**
 * Coverage as a percentage with two decimal places, derived without floating point.
 *
 * Display clamping is part of the contract, not a cosmetic touch. A bar reading "100% covered" when
 * ₹400 of a ₹40 lakh portfolio is unmeasured is a lie by rounding, and it is the single most likely
 * way this feature loses the user's trust. `100.00` is reachable only when the two figures are
 * exactly equal, and `0.00` only when nothing at all is measured.
 */
export function historyCoveragePct(measuredMinor: Minor, valuedMinor: Minor): Dec | null {
  const measured = BigInt(measuredMinor)
  const valued = BigInt(valuedMinor)
  // Null, never 0%: "there is nothing to cover" and "nothing is covered" are different statements.
  if (valued === 0n) return null
  if (measured === valued) return dec('100.00')
  if (measured === 0n) return dec('0.00')
  let basisPoints = (measured * 10000n) / valued
  if (basisPoints >= 10000n) basisPoints = 9999n
  if (basisPoints <= 0n) basisPoints = 1n
  return basisPointsToDec(basisPoints)
}

export interface MetricInput {
  readonly metric: MetricName
  readonly included: readonly { readonly valueMinor: Minor }[]
  readonly excluded: readonly ExcludedPair[]
  readonly totalMinor: Minor
}

export function metricCoverage(input: MetricInput): MetricCoverage {
  const covered = addMinor(...input.included.map((p) => p.valueMinor))
  const excludedValue = addMinor(...input.excluded.map((p) => p.valueMinor))
  return {
    metric: input.metric,
    coveredMinor: covered,
    totalMinor: input.totalMinor,
    pct: historyCoveragePct(covered, input.totalMinor),
    excludedPairs: input.excluded,
    excludedValueMinor: excludedValue,
  }
}

export interface CoverageInput {
  readonly asOf: IsoInstant
  readonly breakdown: ValueBreakdown
  readonly measuredMinor: Minor
  readonly perMetric: readonly MetricCoverage[]
  readonly stalePriceCount: number
  readonly stalestPriceAgeDays: number | null
  readonly unresolvedInstrumentCount: number
}

export function coverageReport(input: CoverageInput): CoverageReport {
  return {
    asOf: input.asOf,
    breakdown: input.breakdown,
    historyCoveragePct: historyCoveragePct(input.measuredMinor, input.breakdown.valuedMinor),
    measuredMinor: input.measuredMinor,
    unmeasuredMinor: subMinor(input.breakdown.valuedMinor, input.measuredMinor),
    perMetric: input.perMetric,
    stalePriceCount: input.stalePriceCount,
    stalestPriceAgeDays: input.stalestPriceAgeDays,
    unresolvedInstrumentCount: input.unresolvedInstrumentCount,
    withheldMinor: input.breakdown.withheldMinor,
  }
}

export const NOTHING = ZERO_MINOR
