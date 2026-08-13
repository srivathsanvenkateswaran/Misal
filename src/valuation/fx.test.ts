/**
 * FX direction, backfill, and the age bound on "the current rate". A silent inversion turns a
 * ₹50 lakh US holding into ₹6,500, so the direction is asserted rather than inferred; a silently
 * frozen rate is the same class of failure spread over weeks, so its bound is asserted too.
 */

import { describe, expect, it } from 'vitest'
import { dec } from '@domain/numeric'
import { FxTable, MAX_FX_LATEST_AGE_DAYS } from './fx'

const rows = [
  { base: 'USD', quote: 'INR', asOf: '2026-08-07', rate: dec('87.4210'), source: 'twelvedata' },
  { base: 'USD', quote: 'INR', asOf: '2026-08-11', rate: dec('88.0000'), source: 'twelvedata' },
]

const TODAY = '2026-08-12'

describe('FxTable', () => {
  it('rejects a row whose quote is not INR instead of inverting it on a guess', () => {
    const table = new FxTable([
      ...rows,
      { base: 'INR', quote: 'USD', asOf: '2026-08-11', rate: dec('0.0114'), source: 'somewhere' },
    ])
    expect(table.invalidDirectionRows).toHaveLength(1)
    const rate = table.latest('USD', 'INR', TODAY)
    if (!rate.ok) throw new Error('expected a rate')
    expect(rate.value.rate).toBe('88.0000')
  })

  it('resolves the nearest preceding rate within three days and reports the date it used', () => {
    const table = new FxTable(rows)
    const weekend = table.on('USD', 'INR', '2026-08-09')
    if (!weekend.ok) throw new Error('expected a rate')
    expect(weekend.value.rate).toBe('87.4210')
    expect(weekend.value.asOf).toBe('2026-08-07')
  })

  it('fails beyond three days rather than interpolating', () => {
    const table = new FxTable(rows)
    const stale = table.on('USD', 'INR', '2026-08-20')
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error.code).toBe('NO_FX_RATE')
  })

  it('reports NO_FX_SOURCE when there is no key and therefore no rate at all', () => {
    const empty = new FxTable([])
    const result = empty.latest('USD', 'INR', TODAY)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The position is excluded from net worth, not valued at an assumed rate.
    expect(result.error.code).toBe('NO_FX_SOURCE')
  })

  it('is the identity for INR', () => {
    const result = new FxTable([]).latest('INR', 'INR', TODAY)
    if (!result.ok) throw new Error('expected a rate')
    expect(result.value.rate).toBe('1')
  })

  // -- the age bound on `latest` -----------------------------------------------------------------

  it('still calls a rate current across a run of holidays inside the bound', () => {
    const table = new FxTable(rows)
    const week = table.latest('USD', 'INR', '2026-08-18')
    if (!week.ok) throw new Error('a rate seven days old is still the current one')
    expect(week.value.asOf).toBe('2026-08-11')
  })

  /**
   * The defect this guards: `latest` had no age bound at all. Prices refresh daily, so net worth
   * kept moving while the FX leg was pinned to the day the rate feed stopped — a total that changed
   * every day and was wrong every day, with nothing on screen to say so.
   */
  it('refuses a rate too old to be the current one rather than freezing net worth against it', () => {
    const table = new FxTable(rows)
    const frozen = table.latest('USD', 'INR', '2026-09-30')
    expect(frozen.ok).toBe(false)
    if (frozen.ok) return
    expect(frozen.error.code).toBe('FX_RATE_STALE')
    if (frozen.error.code !== 'FX_RATE_STALE') return
    // The rate's own date and age travel with the refusal, so the caller can say how stale rather
    // than only that something is missing.
    expect(frozen.error.asOf).toBe('2026-08-11')
    expect(frozen.error.ageDays).toBe(50)
    expect(frozen.error.pair).toBe('USD/INR')
  })

  it('bounds the day after the limit, not a fortnight after it', () => {
    const table = new FxTable(rows)
    const lastGoodDay = '2026-08-18'
    expect(table.latest('USD', 'INR', lastGoodDay).ok).toBe(true)
    expect(table.latest('USD', 'INR', '2026-08-19').ok).toBe(false)
    expect(MAX_FX_LATEST_AGE_DAYS).toBe(7)
  })

  it('does not call a rate dated after the valuation date stale', () => {
    // A provider quoting in a timezone ahead of IST puts one there routinely.
    const table = new FxTable(rows)
    expect(table.latest('USD', 'INR', '2026-08-01').ok).toBe(true)
  })
})
