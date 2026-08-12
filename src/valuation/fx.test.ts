/**
 * FX direction and backfill. A silent inversion turns a ₹50 lakh US holding into ₹6,500, so the
 * direction is asserted rather than inferred.
 */

import { describe, expect, it } from 'vitest'
import { dec } from '@domain/numeric'
import { FxTable } from './fx'

const rows = [
  { base: 'USD', quote: 'INR', asOf: '2026-08-07', rate: dec('87.4210'), source: 'twelvedata' },
  { base: 'USD', quote: 'INR', asOf: '2026-08-11', rate: dec('88.0000'), source: 'twelvedata' },
]

describe('FxTable', () => {
  it('rejects a row whose quote is not INR instead of inverting it on a guess', () => {
    const table = new FxTable([
      ...rows,
      { base: 'INR', quote: 'USD', asOf: '2026-08-11', rate: dec('0.0114'), source: 'somewhere' },
    ])
    expect(table.invalidDirectionRows).toHaveLength(1)
    const rate = table.latest('USD', 'INR')
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
    const result = empty.latest('USD', 'INR')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The position is excluded from net worth, not valued at an assumed rate.
    expect(result.error.code).toBe('NO_FX_SOURCE')
  })

  it('is the identity for INR', () => {
    const result = new FxTable([]).latest('INR', 'INR')
    if (!result.ok) throw new Error('expected a rate')
    expect(result.value.rate).toBe('1')
  })
})
