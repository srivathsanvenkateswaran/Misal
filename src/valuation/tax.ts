/**
 * Realised gains: classification of each FIFO disposal into a reporting bucket.
 *
 * Three rules here are structural rather than cosmetic:
 *
 *  - Where the regime, the FMV or the cost is unknown, the disposal's gain is *not measured*. It is
 *    not zero and it is not the ungrandfathered figure dressed up as an answer; it is withheld and
 *    it subtracts from realised-P&L coverage.
 *  - Virtual digital assets are never netted. Section 115BBH allows no set-off of losses, whether
 *    against other VDA gains or anything else, so a single netted "crypto P&L" number would
 *    understate the taxable base, sometimes to zero. Gains and losses are reported as two figures.
 *  - **Every money figure this module emits is INR minor units.** A `LotConsumption` is denominated
 *    in the disposal's own currency, so each one is converted here, at the disposal-date rate, at
 *    the point the gain is computed — the way `costInInr` converts at the acquisition-date rate and
 *    `xirr.ts` converts every cashflow. Without it a $1,000 gain on a US holding entered the
 *    portfolio's rupee total as 100,000 *cents* and was rendered as ₹1,000: understated eighty-
 *    sevenfold, netted against genuine rupee gains, and flagged `measured` with full coverage. A
 *    disposal whose rate is missing is withheld rather than reported in an unstated currency.
 */

import {
  type CurrencyCode,
  type Dec,
  type Minor,
  ZERO_MINOR,
  addMinor,
  dec,
  decToMinor,
  divDec,
  isNegativeMinor,
  minorToDec,
  mulDec,
  negMinor,
  subMinor,
  valueOf,
} from '@domain/numeric'
import { type Measured, fullCoverage, measured, notMeasured } from '@domain/measured'
import { daysBetween, financialYear, isLongTerm } from './calendar'
import type { LotConsumption } from './fold'
import type { FxService } from './fx'
import { grandfatheredUnitCost } from './grandfather'
import { regimeOf, ruleFor } from './tax-rules'
import type { InstrumentRef, IsoDate, TaxRegime, WarningCode } from './types'

const ONE = dec('1')

/** The INR rate for a disposal's own currency on its own date. `1` for an INR disposal. */
function disposalRate(fx: FxService, currency: CurrencyCode, disposedOn: IsoDate): Dec | null {
  if (currency === 'INR') return ONE
  const read = fx.on(currency, 'INR', disposedOn)
  return read.ok ? read.value.rate : null
}

function toInr(value: Minor, currency: CurrencyCode, rate: Dec): Minor {
  if (currency === 'INR') return value
  return decToMinor(mulDec(minorToDec(value, currency), rate), 'INR')
}

export type GainBucket =
  | { readonly kind: 'stcg'; readonly regime: TaxRegime }
  | { readonly kind: 'ltcg'; readonly regime: TaxRegime }
  /** Section 115BBH — no short/long distinction exists for VDAs. */
  | { readonly kind: 'vda' }
  | { readonly kind: 'unavailable'; readonly reason: WarningCode }

/**
 * One classified disposal.
 *
 * Every money field is INR minor units — stated, not implied, because these figures are summed into
 * portfolio totals and rendered with a rupee sign. `fxRate` is the rate that made it so.
 */
export interface Disposal {
  readonly disposalTxnId: string
  readonly lotId: string
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: Dec
  readonly acquiredOn: IsoDate
  readonly disposedOn: IsoDate
  readonly holdingDays: number
  readonly currency: 'INR'
  /** Disposal-date INR rate for the transaction's currency. `1` for INR; null when withheld. */
  readonly fxRate: Dec | null
  readonly grossConsiderationMinor: Minor
  readonly transferExpensesMinor: Minor
  /** Actual cost, before grandfathering. */
  readonly costMinor: Minor
  /** After grandfathering; equals `costMinor` when it did not apply. */
  readonly deemedCost: Measured<Minor>
  readonly gain: Measured<Minor>
  readonly grandfathered: boolean
  readonly bucket: GainBucket
  readonly financialYear: string
}

export interface DisposalRef {
  readonly disposalTxnId: string
  readonly lotId: string
  readonly instrumentId: string
  readonly accountId: string
  readonly reason: WarningCode
}

/** INR minor units throughout, like everything else here. */
export interface RegimeSummary {
  /** Net of losses *within* the regime, which is what the ITR schedules do. */
  readonly stcgMinor: Minor
  readonly ltcgMinor: Minor
  /** Informational only: a per-assessee annual figure Misal cannot see the whole of. */
  readonly exemptionAppliedMinor: Minor
}

export interface VdaSummary {
  readonly grossGainMinor: Minor
  /** Reported, NEVER netted against gains. */
  readonly grossLossMinor: Minor
  readonly disposalCount: number
}

export interface RealisedGains {
  readonly financialYear: string
  /** Every figure below is INR minor units. */
  readonly currency: 'INR'
  readonly byRegime: ReadonlyMap<TaxRegime, RegimeSummary>
  readonly vda: VdaSummary
  /**
   * Income accumulates across pairs, so a foreign-currency row would land in a rupee total exactly
   * as a foreign disposal's gain did. These arrive already converted, and are `Measured` so that a
   * missing rate withholds the figure instead of contributing a number in an unstated currency.
   */
  readonly dividendIncomeMinor: Measured<Minor>
  readonly interestIncomeMinor: Measured<Minor>
  /** Section 194S TDS: a prepayment of tax, accumulated for display, never deducted from a gain. */
  readonly tdsCreditMinor: Measured<Minor>
  readonly unavailableDisposals: readonly DisposalRef[]
}

/** The INR figures a disposal reports. Zero throughout when no rate could convert them. */
interface InrFigures {
  readonly rate: Dec | null
  readonly gross: Minor
  readonly expenses: Minor
  readonly cost: Minor
}

function unavailable(
  consumption: LotConsumption,
  reason: WarningCode,
  inr: InrFigures,
): Disposal {
  const excluded = inr.gross
  return {
    disposalTxnId: consumption.disposalTxnId,
    lotId: consumption.lotId,
    instrumentId: consumption.instrumentId,
    accountId: consumption.accountId,
    quantity: consumption.quantity,
    acquiredOn: consumption.acquiredOn,
    disposedOn: consumption.disposedOn,
    holdingDays: daysBetween(consumption.acquiredOn, consumption.disposedOn),
    currency: 'INR',
    fxRate: inr.rate,
    grossConsiderationMinor: inr.gross,
    transferExpensesMinor: inr.expenses,
    costMinor: inr.cost,
    deemedCost: notMeasured(reasonFor(reason), excluded),
    gain: notMeasured(reasonFor(reason), excluded),
    grandfathered: false,
    bucket: { kind: 'unavailable', reason },
    financialYear: financialYear(consumption.disposedOn),
  }
}

/**
 * The user-facing reason for a withheld disposal.
 *
 * A blocked grandfathering FMV has its own member rather than borrowing `unknown_tax_regime`. The
 * two send the user to different places: one asks them to classify the scheme, the other to supply
 * the 31-January-2018 price. Reporting the second as the first names a problem they do not have and
 * hides the one fixable input that would restore the figure.
 */
function reasonFor(code: WarningCode) {
  if (code === 'MISSING_ACQUISITION_COST') return 'no_transaction_history' as const
  if (code === 'NO_PRICE') return 'no_price' as const
  if (code === 'GRANDFATHER_FMV_UNAVAILABLE') return 'no_grandfathering_fmv' as const
  if (code === 'NO_FX_RATE' || code === 'NO_FX_SOURCE') return 'no_fx_rate' as const
  return 'unknown_tax_regime' as const
}

/**
 * Classify one lot's contribution to one sale.
 *
 * `transfer_out` consumptions are not disposals: moving units between demat accounts is not a
 * transfer for capital-gains purposes, and treating it as one would invent a taxable event. They
 * consume inventory in the fold and are ignored here.
 *
 * `fx` is not optional. The consumption is denominated in the disposal's currency and everything
 * returned is INR, so the rate is the first thing this function needs — before the regime, before
 * the cost, before anything else it might report — because without it no figure here can be stated
 * at all, not even the gross consideration a withheld disposal carries for coverage.
 *
 * The comparisons that grandfathering makes stay in the native currency, where the 31-January-2018
 * FMV lives; only the resulting deemed cost is converted.
 */
export function classifyDisposal(
  consumption: LotConsumption,
  instrument: InstrumentRef,
  fx: FxService,
): Disposal | null {
  if (consumption.kind !== 'sell') return null

  const rate = disposalRate(fx, consumption.currency, consumption.disposedOn)
  if (rate === null) {
    return unavailable(consumption, 'NO_FX_RATE', {
      rate: null,
      gross: ZERO_MINOR,
      expenses: ZERO_MINOR,
      cost: ZERO_MINOR,
    })
  }
  const inr = (value: Minor): Minor => toInr(value, consumption.currency, rate)
  const expenses = inr(consumption.transferExpensesMinor)
  const cost = inr(consumption.costMinor)

  const nativeGross = consumption.grossConsiderationMinor
  if (nativeGross === null) {
    return unavailable(consumption, 'NO_PRICE', { rate, gross: ZERO_MINOR, expenses, cost })
  }
  const gross = inr(nativeGross)
  const figures: InrFigures = { rate, gross, expenses, cost }
  if (!consumption.costKnown) return unavailable(consumption, 'MISSING_ACQUISITION_COST', figures)

  const regime = regimeOf(instrument)
  if (regime === null) return unavailable(consumption, 'UNKNOWN_TAX_REGIME', figures)
  const rule = ruleFor(regime, consumption.disposedOn)
  if (rule === null) return unavailable(consumption, 'UNKNOWN_TAX_REGIME', figures)

  const unitConsideration =
    consumption.unitConsideration ??
    divDec(minorToDec(nativeGross, consumption.currency), consumption.quantity)
  const actualUnitCost = divDec(minorToDec(consumption.costMinor, consumption.currency), consumption.quantity)

  const outcome = grandfatheredUnitCost({
    regime,
    lotAcquiredOn: consumption.acquiredOn,
    actualUnitCost,
    fmv31Jan2018: instrument.fmv31Jan2018,
    grossUnitConsideration: unitConsideration,
    disposedOn: consumption.disposedOn,
  })
  if (outcome.applied === 'blocked') {
    return unavailable(consumption, 'GRANDFATHER_FMV_UNAVAILABLE', figures)
  }

  const deemedCostMinor =
    outcome.applied === true
      ? inr(valueOf(consumption.quantity, outcome.deemedUnitCost, consumption.currency))
      : cost

  // Subtracted after conversion, so the three figures the UI shows and the gain it shows are the
  // same arithmetic: gain === gross − expenses − deemed cost holds exactly in the units reported.
  const gainMinor = subMinor(subMinor(gross, expenses), deemedCostMinor)

  const bucket: GainBucket =
    regime === 's115bbh_vda'
      ? { kind: 'vda' }
      : rule.longTermThresholdMonths === null
        ? { kind: 'stcg', regime }
        : isLongTerm(consumption.acquiredOn, consumption.disposedOn, rule.longTermThresholdMonths)
          ? { kind: 'ltcg', regime }
          : { kind: 'stcg', regime }

  return {
    disposalTxnId: consumption.disposalTxnId,
    lotId: consumption.lotId,
    instrumentId: consumption.instrumentId,
    accountId: consumption.accountId,
    quantity: consumption.quantity,
    acquiredOn: consumption.acquiredOn,
    disposedOn: consumption.disposedOn,
    holdingDays: daysBetween(consumption.acquiredOn, consumption.disposedOn),
    currency: 'INR',
    fxRate: rate,
    grossConsiderationMinor: gross,
    transferExpensesMinor: expenses,
    costMinor: cost,
    deemedCost: measured(deemedCostMinor, fullCoverage(gross)),
    gain: measured(gainMinor, fullCoverage(gross)),
    grandfathered: outcome.applied === true,
    bucket,
    financialYear: financialYear(consumption.disposedOn),
  }
}

/** INR, converted by the caller at each income row's own date. See `RealisedGains`. */
export interface IncomeInput {
  readonly dividendIncomeMinor: Measured<Minor>
  readonly interestIncomeMinor: Measured<Minor>
  readonly tdsCreditMinor: Measured<Minor>
}

/**
 * Aggregate classified disposals for one financial year.
 *
 * Losses are netted within a regime, which is how the ITR schedules present them, and never across
 * regimes or into the VDA bucket.
 */
export function summariseRealised(
  disposals: readonly Disposal[],
  income: IncomeInput,
  fy: string,
): RealisedGains {
  const byRegime = new Map<TaxRegime, RegimeSummary>()
  let vdaGain = ZERO_MINOR
  let vdaLoss = ZERO_MINOR
  let vdaCount = 0
  const unavailableDisposals: DisposalRef[] = []

  for (const disposal of disposals) {
    if (disposal.financialYear !== fy) continue
    if (disposal.bucket.kind === 'unavailable') {
      unavailableDisposals.push({
        disposalTxnId: disposal.disposalTxnId,
        lotId: disposal.lotId,
        instrumentId: disposal.instrumentId,
        accountId: disposal.accountId,
        reason: disposal.bucket.reason,
      })
      continue
    }
    if (!disposal.gain.measured) continue
    const gain = disposal.gain.value

    if (disposal.bucket.kind === 'vda') {
      vdaCount += 1
      if (isNegativeMinor(gain)) vdaLoss = addMinor(vdaLoss, negMinor(gain))
      else vdaGain = addMinor(vdaGain, gain)
      continue
    }

    const regime = disposal.bucket.regime
    const current = byRegime.get(regime) ?? {
      stcgMinor: ZERO_MINOR,
      ltcgMinor: ZERO_MINOR,
      exemptionAppliedMinor: ZERO_MINOR,
    }
    byRegime.set(
      regime,
      disposal.bucket.kind === 'stcg'
        ? { ...current, stcgMinor: addMinor(current.stcgMinor, gain) }
        : { ...current, ltcgMinor: addMinor(current.ltcgMinor, gain) },
    )
  }

  // The section 112A exemption is reported as what the year's long-term gains would consume of it,
  // labelled informational: it is a per-assessee figure that also covers gains realised outside
  // Misal, so presenting it as actually consumed would be wrong for anyone with other holdings.
  for (const [regime, summary] of byRegime) {
    const rule = disposalsRuleFor(regime, disposals, fy)
    if (rule?.annualExemptionMinor === undefined || rule.annualExemptionMinor === null) continue
    if (isNegativeMinor(summary.ltcgMinor)) continue
    const applied =
      BigInt(summary.ltcgMinor) < BigInt(rule.annualExemptionMinor)
        ? summary.ltcgMinor
        : rule.annualExemptionMinor
    byRegime.set(regime, { ...summary, exemptionAppliedMinor: applied })
  }

  return {
    financialYear: fy,
    currency: 'INR',
    byRegime,
    vda: { grossGainMinor: vdaGain, grossLossMinor: vdaLoss, disposalCount: vdaCount },
    dividendIncomeMinor: income.dividendIncomeMinor,
    interestIncomeMinor: income.interestIncomeMinor,
    tdsCreditMinor: income.tdsCreditMinor,
    unavailableDisposals,
  }
}

/** The rule that governed this regime's disposals in the year, taken from the year's own rows. */
function disposalsRuleFor(regime: TaxRegime, disposals: readonly Disposal[], fy: string) {
  for (const disposal of disposals) {
    if (disposal.financialYear !== fy) continue
    if (disposal.bucket.kind !== 'ltcg' && disposal.bucket.kind !== 'stcg') continue
    if (disposal.bucket.regime !== regime) continue
    const rule = ruleFor(regime, disposal.disposedOn)
    if (rule !== null) return rule
  }
  return null
}
