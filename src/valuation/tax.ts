/**
 * Realised gains: classification of each FIFO disposal into a reporting bucket.
 *
 * Two rules here are structural rather than cosmetic:
 *
 *  - Where the regime, the FMV or the cost is unknown, the disposal's gain is *not measured*. It is
 *    not zero and it is not the ungrandfathered figure dressed up as an answer; it is withheld and
 *    it subtracts from realised-P&L coverage.
 *  - Virtual digital assets are never netted. Section 115BBH allows no set-off of losses, whether
 *    against other VDA gains or anything else, so a single netted "crypto P&L" number would
 *    understate the taxable base, sometimes to zero. Gains and losses are reported as two figures.
 */

import {
  type Dec,
  type Minor,
  ZERO_MINOR,
  addMinor,
  divDec,
  isNegativeMinor,
  minorToDec,
  negMinor,
  subMinor,
  valueOf,
} from '@domain/numeric'
import { type Measured, fullCoverage, measured, notMeasured } from '@domain/measured'
import { daysBetween, financialYear, isLongTerm } from './calendar'
import type { LotConsumption } from './fold'
import { grandfatheredUnitCost } from './grandfather'
import { regimeOf, ruleFor } from './tax-rules'
import type { InstrumentRef, IsoDate, TaxRegime, WarningCode } from './types'

export type GainBucket =
  | { readonly kind: 'stcg'; readonly regime: TaxRegime }
  | { readonly kind: 'ltcg'; readonly regime: TaxRegime }
  /** Section 115BBH — no short/long distinction exists for VDAs. */
  | { readonly kind: 'vda' }
  | { readonly kind: 'unavailable'; readonly reason: WarningCode }

export interface Disposal {
  readonly disposalTxnId: string
  readonly lotId: string
  readonly instrumentId: string
  readonly accountId: string
  readonly quantity: Dec
  readonly acquiredOn: IsoDate
  readonly disposedOn: IsoDate
  readonly holdingDays: number
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
  readonly byRegime: ReadonlyMap<TaxRegime, RegimeSummary>
  readonly vda: VdaSummary
  readonly dividendIncomeMinor: Minor
  readonly interestIncomeMinor: Minor
  /** Section 194S TDS: a prepayment of tax, accumulated for display, never deducted from a gain. */
  readonly tdsCreditMinor: Minor
  readonly unavailableDisposals: readonly DisposalRef[]
}

function unavailable(
  consumption: LotConsumption,
  reason: WarningCode,
  gross: Minor,
): Disposal {
  const excluded = gross
  return {
    disposalTxnId: consumption.disposalTxnId,
    lotId: consumption.lotId,
    instrumentId: consumption.instrumentId,
    accountId: consumption.accountId,
    quantity: consumption.quantity,
    acquiredOn: consumption.acquiredOn,
    disposedOn: consumption.disposedOn,
    holdingDays: daysBetween(consumption.acquiredOn, consumption.disposedOn),
    grossConsiderationMinor: gross,
    transferExpensesMinor: consumption.transferExpensesMinor,
    costMinor: consumption.costMinor,
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
  return 'unknown_tax_regime' as const
}

/**
 * Classify one lot's contribution to one sale.
 *
 * `transfer_out` consumptions are not disposals: moving units between demat accounts is not a
 * transfer for capital-gains purposes, and treating it as one would invent a taxable event. They
 * consume inventory in the fold and are ignored here.
 */
export function classifyDisposal(
  consumption: LotConsumption,
  instrument: InstrumentRef,
): Disposal | null {
  if (consumption.kind !== 'sell') return null

  const gross = consumption.grossConsiderationMinor
  if (gross === null) return unavailable(consumption, 'NO_PRICE', ZERO_MINOR)
  if (!consumption.costKnown) return unavailable(consumption, 'MISSING_ACQUISITION_COST', gross)

  const regime = regimeOf(instrument)
  if (regime === null) return unavailable(consumption, 'UNKNOWN_TAX_REGIME', gross)
  const rule = ruleFor(regime, consumption.disposedOn)
  if (rule === null) return unavailable(consumption, 'UNKNOWN_TAX_REGIME', gross)

  const unitConsideration =
    consumption.unitConsideration ??
    divDec(minorToDec(gross, consumption.currency), consumption.quantity)
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
    return unavailable(consumption, 'GRANDFATHER_FMV_UNAVAILABLE', gross)
  }

  const deemedCostMinor =
    outcome.applied === true
      ? valueOf(consumption.quantity, outcome.deemedUnitCost, consumption.currency)
      : consumption.costMinor

  const gainMinor = subMinor(subMinor(gross, consumption.transferExpensesMinor), deemedCostMinor)

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
    grossConsiderationMinor: gross,
    transferExpensesMinor: consumption.transferExpensesMinor,
    costMinor: consumption.costMinor,
    deemedCost: measured(deemedCostMinor, fullCoverage(gross)),
    gain: measured(gainMinor, fullCoverage(gross)),
    grandfathered: outcome.applied === true,
    bucket,
    financialYear: financialYear(consumption.disposedOn),
  }
}

export interface IncomeInput {
  readonly dividendIncomeMinor: Minor
  readonly interestIncomeMinor: Minor
  readonly tdsCreditMinor: Minor
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
