/**
 * Section 55(2)(ac) grandfathering for assets covered by section 112A.
 *
 *   cost of acquisition = max( actual cost , min( FMV on 31-Jan-2018 , full value of consideration ) )
 *
 * Four things this rule requires that are easy to get wrong, all of them load-bearing here:
 *
 *  - FMV is the *highest* price quoted on any recognised Indian exchange that day, not the close.
 *  - The comparison is per unit and applied per lot, so a sale spanning a pre-2018 and a post-2018
 *    lot grandfathers only the first.
 *  - "Full value of consideration" is gross, before transfer expenses; those are deducted
 *    afterwards under section 48. Using net consideration inside the `min()` understates the deemed
 *    cost and overstates the gain.
 *  - The rule can only reduce a gain to zero, never create a loss — and that is a consequence of
 *    the `min()`, not a separate clamp. An implementation producing a negative grandfathered gain
 *    has a bug in the `min()`, and adding a clamp would hide it.
 */

import { type Dec, maxDec, minDec } from '@domain/numeric'
import type { IsoDate, TaxRegime } from './types'
import { ruleFor } from './tax-rules'

/** Assets acquired *before* this date are eligible. */
export const GRANDFATHER_CUTOFF: IsoDate = '2018-02-01'

export interface GrandfatherInput {
  readonly regime: TaxRegime
  readonly lotAcquiredOn: IsoDate
  readonly actualUnitCost: Dec
  /** Null means "not available", which blocks rather than falls back. */
  readonly fmv31Jan2018: Dec | null
  readonly grossUnitConsideration: Dec
  readonly disposedOn: IsoDate
}

export type GrandfatherOutcome =
  | { readonly applied: false; readonly reason: 'not_112a' | 'acquired_after_cutoff' }
  | { readonly applied: true; readonly deemedUnitCost: Dec; readonly fmvUsed: Dec }
  | { readonly applied: 'blocked'; readonly reason: 'fmv_unavailable' }

/**
 * `'blocked'` is a refusal, not a failure to compute.
 *
 * Falling back to actual cost when the FMV is missing overstates the taxable gain by the entire
 * 2001–2018 appreciation, which for a long-held Indian equity is routinely 5–10x. The disposal is
 * reported as unavailable and the user is asked for the 31-January-2018 price instead.
 */
export function grandfatheredUnitCost(input: GrandfatherInput): GrandfatherOutcome {
  const rule = ruleFor(input.regime, input.disposedOn)
  if (rule === null || !rule.grandfatherEligible) {
    return { applied: false, reason: 'not_112a' }
  }
  if (input.lotAcquiredOn >= GRANDFATHER_CUTOFF) {
    return { applied: false, reason: 'acquired_after_cutoff' }
  }
  if (input.fmv31Jan2018 === null) {
    return { applied: 'blocked', reason: 'fmv_unavailable' }
  }
  const capped = minDec(input.fmv31Jan2018, input.grossUnitConsideration)
  return {
    applied: true,
    deemedUnitCost: maxDec(input.actualUnitCost, capped),
    fmvUsed: input.fmv31Jan2018,
  }
}
