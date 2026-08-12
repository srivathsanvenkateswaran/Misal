/**
 * Pins every value in the tax rule table.
 *
 * Written after mutation testing showed the existing suite could not detect changes to these
 * tables: altering all nine tax rates failed exactly one test, and altering all six holding-period
 * thresholds failed only three.
 *
 * That is a dangerous shape of gap. These figures are transcribed from legislation, they change
 * every February, and a wrong one produces a plausible number rather than a crash - the user
 * would simply be told the wrong tax treatment. The rest of the engine is guarded by golden
 * arithmetic examples; this table needs guarding by exhaustive assertion instead.
 *
 * A failure here means either the law changed and the table was updated correctly - in which case
 * update this test in the same commit and cite the amendment - or a value drifted by accident.
 * Never relax an assertion to make it pass.
 */

import { describe, expect, it } from 'vitest'
import { TAX_RULES, ruleFor } from './tax-rules'
import type { RateSpec, TaxRule } from './tax-rules'
import type { TaxRegime } from './types'

function rateOf(spec: RateSpec): string {
  switch (spec.kind) {
    case 'flat':
      return `flat:${spec.pct}`
    case 'slab':
      return 'slab'
    case 'not_applicable':
      return 'n/a'
  }
}

/** One row per rule, in the exact order the table declares them. */
const EXPECTED: ReadonlyArray<{
  regime: TaxRegime
  from: string
  to: string | null
  ltMonths: number | null
  short: string
  long: string
  grandfather: boolean
}> = [
  // Section 112A, transfers before the Finance (No. 2) Act 2024 took effect.
  {
    regime: 's112a_listed_equity',
    from: '2018-04-01',
    to: '2024-07-22',
    ltMonths: 12,
    short: 'flat:15',
    long: 'flat:10',
    grandfather: true,
  },
  // Section 112A as amended: STCG 15 -> 20, LTCG 10 -> 12.5.
  {
    regime: 's112a_listed_equity',
    from: '2024-07-23',
    to: null,
    ltMonths: 12,
    short: 'flat:20',
    long: 'flat:12.5',
    grandfather: true,
  },
  // Section 50AA specified funds: no long-term bucket exists at all, taxed at slab.
  {
    regime: 's50aa_specified_mf',
    from: '2023-04-01',
    to: null,
    ltMonths: null,
    short: 'slab',
    long: 'n/a',
    grandfather: false,
  },
  {
    regime: 'other_mf_listed',
    from: '2024-07-23',
    to: null,
    ltMonths: 12,
    short: 'slab',
    long: 'flat:12.5',
    grandfather: false,
  },
  // Unlisted funds carry the 24-month threshold, unlike their listed counterparts.
  {
    regime: 'other_mf_unlisted',
    from: '2024-07-23',
    to: null,
    ltMonths: 24,
    short: 'slab',
    long: 'flat:12.5',
    grandfather: false,
  },
  // US employer equity lands here: 24 months, and no grandfathering.
  {
    regime: 'foreign_equity',
    from: '2024-07-23',
    to: null,
    ltMonths: 24,
    short: 'slab',
    long: 'flat:12.5',
    grandfather: false,
  },
  // Section 115BBH: flat 30%, no long-term bucket, and no set-off permitted.
  {
    regime: 's115bbh_vda',
    from: '2022-04-01',
    to: null,
    ltMonths: null,
    short: 'flat:30',
    long: 'n/a',
    grandfather: false,
  },
  {
    regime: 'other_asset',
    from: '2024-07-23',
    to: null,
    ltMonths: 24,
    short: 'slab',
    long: 'flat:12.5',
    grandfather: false,
  },
]

describe('tax rule table', () => {
  it('has exactly the expected number of rules', () => {
    // Catches a rule being added without a corresponding assertion here.
    expect(TAX_RULES.length).toBe(EXPECTED.length)
  })

  it.each(EXPECTED.map((e, i) => [i, e.regime, e.from, e] as const))(
    'rule %i (%s from %s) matches the legislated values',
    (index, _regime, _from, expected) => {
      const rule = TAX_RULES[index] as TaxRule
      expect(rule.regime).toBe(expected.regime)
      expect(rule.effectiveFrom).toBe(expected.from)
      expect(rule.effectiveTo).toBe(expected.to)
      expect(rule.longTermThresholdMonths).toBe(expected.ltMonths)
      expect(rateOf(rule.shortTermRate)).toBe(expected.short)
      expect(rateOf(rule.longTermRate)).toBe(expected.long)
      expect(rule.grandfatherEligible).toBe(expected.grandfather)
    },
  )
})

describe('ruleFor selects by transfer date, not by today', () => {
  it('picks the pre-amendment rule for a transfer on 22 July 2024', () => {
    const rule = ruleFor('s112a_listed_equity', '2024-07-22')
    expect(rule).not.toBeNull()
    expect(rateOf(rule!.longTermRate)).toBe('flat:10')
    expect(rateOf(rule!.shortTermRate)).toBe('flat:15')
  })

  it('picks the amended rule for a transfer on 23 July 2024', () => {
    // The pivot is inclusive of the effective date; off-by-one here changes a real tax figure.
    const rule = ruleFor('s112a_listed_equity', '2024-07-23')
    expect(rule).not.toBeNull()
    expect(rateOf(rule!.longTermRate)).toBe('flat:12.5')
    expect(rateOf(rule!.shortTermRate)).toBe('flat:20')
  })

  it('returns null before a regime existed rather than falling back to a later rule', () => {
    // Silently applying a rule that did not yet exist would be worse than reporting unknown.
    expect(ruleFor('s115bbh_vda', '2021-04-01')).toBeNull()
    expect(ruleFor('s112a_listed_equity', '2017-01-01')).toBeNull()
  })

  it('keeps the 12 vs 24 month distinction between listed and unlisted funds', () => {
    // Mutation testing showed these thresholds were only partially covered before.
    expect(ruleFor('other_mf_listed', '2025-01-01')?.longTermThresholdMonths).toBe(12)
    expect(ruleFor('other_mf_unlisted', '2025-01-01')?.longTermThresholdMonths).toBe(24)
    expect(ruleFor('foreign_equity', '2025-01-01')?.longTermThresholdMonths).toBe(24)
  })

  it('gives regimes with no long-term bucket a null threshold', () => {
    expect(ruleFor('s115bbh_vda', '2025-01-01')?.longTermThresholdMonths).toBeNull()
    expect(ruleFor('s50aa_specified_mf', '2025-01-01')?.longTermThresholdMonths).toBeNull()
  })
})
