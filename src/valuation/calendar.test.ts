/**
 * Instant ordering across mixed UTC offsets.
 *
 * `IsoInstant` keeps the offset of the source that wrote it, so any ordering that reads these
 * values as strings is wrong the moment two sources disagree — and it fails silently, producing a
 * plausible number from the wrong row. Every case below is chosen so that lexicographic order and
 * chronological order give *different* answers; a test where they agree proves nothing.
 */

import { describe, expect, it } from 'vitest'
import { compareInstants, instantToMillis } from './calendar'
import type { IsoInstant } from './types'
import { ValuationAssertionError } from './types'

// 17:30Z, as an Indian statement writes it.
const IST_EVENING: IsoInstant = '2026-08-12T23:00:00+05:30'
// 22:00Z, as a US broker export writes it: four and a half hours *later* on the clock, but
// lexicographically earlier, because '18' sorts before '23'.
const EASTERN_AFTERNOON: IsoInstant = '2026-08-12T18:00:00-04:00'

describe('compareInstants', () => {
  it('orders by the instant when text order is the opposite of clock order', () => {
    // What string comparison claims...
    expect(EASTERN_AFTERNOON < IST_EVENING).toBe(true)
    // ...and what actually happened. This inversion is the whole defect.
    expect(compareInstants(EASTERN_AFTERNOON, IST_EVENING)).toBe(1)
    expect(compareInstants(IST_EVENING, EASTERN_AFTERNOON)).toBe(-1)
  })

  it('calls one instant written at two offsets equal', () => {
    const ist: IsoInstant = '2026-08-12T23:00:00+05:30'
    const utc: IsoInstant = '2026-08-12T17:30:00Z'
    expect(instantToMillis(ist)).toBe(instantToMillis(utc))
    expect(compareInstants(ist, utc)).toBe(0)
    // String comparison disagrees, and would pick a winner between two identical moments.
    expect(ist === utc).toBe(false)
    expect(ist > utc).toBe(true)
  })

  it('orders correctly across a date boundary the offsets straddle', () => {
    // 2026-08-12T19:00Z, written in a zone that has already rolled into the 13th.
    const nextDayLocal: IsoInstant = '2026-08-13T00:30:00+05:30'
    // Two hours later, still dated the 12th in UTC.
    const sameDayUtc: IsoInstant = '2026-08-12T21:00:00Z'
    expect(nextDayLocal > sameDayUtc).toBe(true)
    expect(compareInstants(nextDayLocal, sameDayUtc)).toBe(-1)
  })

  it('refuses a value that is not an instant rather than ordering it arbitrarily', () => {
    expect(() => compareInstants('not-an-instant', IST_EVENING)).toThrow(ValuationAssertionError)
    expect(() => instantToMillis('2026-13-45T99:00:00Z')).toThrow(ValuationAssertionError)
  })
})
