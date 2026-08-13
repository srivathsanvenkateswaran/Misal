/**
 * The warning vocabulary is a promise to the user, so it is asserted rather than assumed.
 *
 * Every code in it is a sentence the interface may print about their money. A code that no code
 * path can emit is a check that was never performed, described as one that was — which is the one
 * failure mode worse than showing nothing, because the user reads the absence of the warning as
 * the check having passed.
 */

import { describe, expect, it } from 'vitest'
import { WARNING_CODES } from './types'
import type { WarningCode } from './types'

describe('warning vocabulary', () => {
  it('claims no bonus-ratio cross-check, because nothing stores a bonus ratio', () => {
    // A `bonus` txn row carries the units credited and nothing else: no ratio, no entitlement, no
    // record-date holding to derive one from. `BONUS_UNITS_MISMATCH` compared credited units
    // against an expected figure that does not exist anywhere in the schema, so it could never
    // fire. It stays deleted until a ratio is actually stored — see docs/known-issues.md.
    expect(WARNING_CODES).not.toContain('BONUS_UNITS_MISMATCH')
  })

  it('is free of duplicates, so a code means one thing', () => {
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length)
  })

  it('is the sole source of the type, so the two cannot drift apart', () => {
    const codes: readonly WarningCode[] = WARNING_CODES
    expect(codes).toContain('CORPORATE_ACTION_MISSING_IN_ACCOUNT')
    expect(codes).toContain('GRANDFATHER_FMV_UNAVAILABLE')
  })
})
