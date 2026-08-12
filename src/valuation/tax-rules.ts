/**
 * Tax classification rules as data, keyed by effective date.
 *
 * They are data rather than branches because they change every February, and they carry effective
 * dates because the pivots matter: the Finance (No. 2) Act 2024 changed rates and holding periods
 * for transfers on or after 23 July 2024. A disposal is classified by the rule in force on its
 * *transfer* date, not by today's rule.
 *
 * These are classification rules for reporting, never a tax computation. Nothing here computes a
 * liability, applies a slab, or nets across heads — see the spec's "Out of scope".
 *
 * Researched as of 2026-08-12. Re-verify each February.
 */

import { type Dec, type Minor, dec, minor } from '@domain/numeric'
import type { AssetClass, InstrumentRef, IsoDate, TaxRegime } from './types'

export type RateSpec =
  | { readonly kind: 'flat'; readonly pct: Dec }
  /** Depends on the user's slab, which is outside the database. Never guessed. */
  | { readonly kind: 'slab' }
  | { readonly kind: 'not_applicable' }

export interface TaxRule {
  readonly regime: TaxRegime
  readonly effectiveFrom: IsoDate
  readonly effectiveTo: IsoDate | null
  /** Null means no long-term bucket exists for this regime. */
  readonly longTermThresholdMonths: number | null
  readonly shortTermRate: RateSpec
  readonly longTermRate: RateSpec
  /** Section 112A only, and informational — it is a per-assessee figure Misal cannot fully see. */
  readonly annualExemptionMinor: Minor | null
  readonly grandfatherEligible: boolean
  readonly note: string
}

const FINANCE_ACT_2024: IsoDate = '2024-07-23'

export const TAX_RULES: readonly TaxRule[] = [
  {
    regime: 's112a_listed_equity',
    effectiveFrom: '2018-04-01',
    effectiveTo: '2024-07-22',
    longTermThresholdMonths: 12,
    shortTermRate: { kind: 'flat', pct: dec('15') },
    longTermRate: { kind: 'flat', pct: dec('10') },
    annualExemptionMinor: minor('10000000'),
    grandfatherEligible: true,
    note: 'Listed equity and equity-oriented MF units, STT paid. 10% above ₹1,00,000 per FY. No indexation.',
  },
  {
    regime: 's112a_listed_equity',
    effectiveFrom: FINANCE_ACT_2024,
    effectiveTo: null,
    longTermThresholdMonths: 12,
    shortTermRate: { kind: 'flat', pct: dec('20') },
    longTermRate: { kind: 'flat', pct: dec('12.5') },
    annualExemptionMinor: minor('12500000'),
    grandfatherEligible: true,
    note: 'Finance (No. 2) Act 2024: 20% short-term, 12.5% long-term above ₹1,25,000 per FY.',
  },
  {
    regime: 's50aa_specified_mf',
    effectiveFrom: '2023-04-01',
    effectiveTo: null,
    longTermThresholdMonths: null,
    shortTermRate: { kind: 'slab' },
    longTermRate: { kind: 'not_applicable' },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'Units acquired on or after 1-Apr-2023 in funds investing over 65% in debt: deemed short-term regardless of holding period.',
  },
  {
    regime: 'other_mf_listed',
    effectiveFrom: FINANCE_ACT_2024,
    effectiveTo: null,
    longTermThresholdMonths: 12,
    shortTermRate: { kind: 'slab' },
    longTermRate: { kind: 'flat', pct: dec('12.5') },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'Listed non-equity units, such as gold ETFs.',
  },
  {
    regime: 'other_mf_unlisted',
    effectiveFrom: FINANCE_ACT_2024,
    effectiveTo: null,
    longTermThresholdMonths: 24,
    shortTermRate: { kind: 'slab' },
    longTermRate: { kind: 'flat', pct: dec('12.5') },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'Unlisted non-equity units, such as gold and international fund-of-funds.',
  },
  {
    regime: 'foreign_equity',
    effectiveFrom: FINANCE_ACT_2024,
    effectiveTo: null,
    longTermThresholdMonths: 24,
    shortTermRate: { kind: 'slab' },
    longTermRate: { kind: 'flat', pct: dec('12.5') },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'US shares, RSUs and ESPP are unlisted assets for Indian tax purposes.',
  },
  {
    regime: 's115bbh_vda',
    effectiveFrom: '2022-04-01',
    effectiveTo: null,
    longTermThresholdMonths: null,
    shortTermRate: { kind: 'flat', pct: dec('30') },
    longTermRate: { kind: 'not_applicable' },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'Section 115BBH: flat 30%, only cost of acquisition deductible, no set-off of losses and no carry-forward.',
  },
  {
    regime: 'other_asset',
    effectiveFrom: FINANCE_ACT_2024,
    effectiveTo: null,
    longTermThresholdMonths: 24,
    shortTermRate: { kind: 'slab' },
    longTermRate: { kind: 'flat', pct: dec('12.5') },
    annualExemptionMinor: null,
    grandfatherEligible: false,
    note: 'Physical gold, bonds, and everything else.',
  },
]

/** The rule in force for `regime` on the transfer date, or null when none covers it. */
export function ruleFor(regime: TaxRegime, transferDate: IsoDate): TaxRule | null {
  for (const rule of TAX_RULES) {
    if (rule.regime !== regime) continue
    if (transferDate < rule.effectiveFrom) continue
    if (rule.effectiveTo !== null && transferDate > rule.effectiveTo) continue
    return rule
  }
  return null
}

/**
 * The regime for an instrument, or `null` when it genuinely cannot be determined.
 *
 * `asset_class` is a single bucket for mutual funds, but the regime depends on whether the scheme
 * is equity-oriented (112A), a specified mutual fund (50AA) or another non-equity fund, and the
 * core schema has nowhere to record that (open question 1). Rather than pick the most common case
 * and be silently wrong for the rest, an unclassified mutual fund returns `null`, which withholds
 * its realised gains until the user classifies the scheme. This is the largest accuracy gap in the
 * subsystem and it is deliberately visible.
 */
export function regimeOf(instrument: InstrumentRef): TaxRegime | null {
  if (instrument.taxRegime !== null) return instrument.taxRegime
  return DEFAULT_REGIME_BY_CLASS[instrument.assetClass]
}

const DEFAULT_REGIME_BY_CLASS: Record<AssetClass, TaxRegime | null> = {
  indian_equity: 's112a_listed_equity',
  us_equity: 'foreign_equity',
  crypto: 's115bbh_vda',
  gold: 'other_asset',
  bond: 'other_asset',
  cash: 'other_asset',
  // Deliberately unknown. See regimeOf.
  mutual_fund: null,
}
