/**
 * A snapshot's age travels with it.
 *
 * `latestSnapshots` takes the newest row at or before the valuation instant and applies no age
 * bound whatsoever. So a balance read two years ago counted at full value today, priced at today's
 * price, with nothing on any screen saying how old the claim was.
 *
 * That is out of step with everything around it: a price carries a staleness threshold, an
 * exchange rate is refused past seven days. A quantity — the input those prices multiply — carried
 * nothing.
 *
 * The fix is deliberately not to drop the holding. The user very likely still owns it, and a
 * disconnected exchange account keeps its history on purpose; inventing a zero would be the worse
 * error. What was missing was the age, so a screen can say how old the statement behind a number
 * is. Found while fixing the reconnect bug, where a "disconnected" account's last snapshot was
 * still contributing to net worth indefinitely.
 */

import { describe, expect, it } from 'vitest'
import { derivePositions } from './positions'
import type { FoldInput } from './fold'
import type { InstrumentRef, PositionRow } from './types'
import { dec } from '@domain/numeric'

const AS_OF = '2026-08-13T10:00:00.000Z' as FoldInput['asOf']

const BTC: InstrumentRef = {
  id: 'i-btc',
  assetClass: 'crypto',
  displayName: 'Bitcoin',
  isin: null,
  currency: 'INR',
  precision: 8,
  aliases: [],
  taxRegime: 's115bbh_vda',
  fmv31Jan2018: null,
}

function snapshotAt(asOf: string): PositionRow {
  return {
    id: 'p1',
    accountId: 'a-binance',
    instrumentId: 'i-btc',
    quantity: dec('0.50000000'),
    asOf: asOf,
    sourceDocumentId: 'd1',
  }
}

function input(asOf: string): FoldInput {
  return {
    accountId: 'a-binance',
    capability: 'snapshot',
    txns: [],
    snapshots: [snapshotAt(asOf)],
    instruments: new Map([['i-btc', BTC]]),
    asOf: AS_OF,
  }
}

describe('a snapshot position carries its age', () => {
  it('reports a two-year-old balance as two years old, not as current', () => {
    // The reported case: an exchange account whose key was removed two years ago. The quantity is
    // still counted - the user probably still holds it - but the claim's age is now visible.
    const result = derivePositions(input('2024-08-13T10:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const position = result.value[0]
    expect(position?.basis).toBe('snapshot')
    expect(position?.snapshotAgeDays).toBe(730)
    // Not dropped, and not zeroed.
    expect(position?.quantity).toBe('0.50000000')
  })

  it('reports a same-day snapshot as zero days old', () => {
    const result = derivePositions(input('2026-08-13T02:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.snapshotAgeDays).toBe(0)
  })

  it('measures age in Indian calendar days, not raw hours', () => {
    // 22:00 UTC on the 12th is 03:30 IST on the 13th — the same Indian day as the valuation, so
    // this is zero days old despite being twelve hours earlier. The engine dates everything in
    // IST on purpose, so a trade late on an Indian evening is not pushed into the previous day.
    const sameIndianDay = derivePositions(input('2026-08-12T22:00:00.000Z'))
    expect(sameIndianDay.ok).toBe(true)
    if (!sameIndianDay.ok) return
    expect(sameIndianDay.value[0]?.snapshotAgeDays).toBe(0)

    // The previous Indian day really is one.
    const previousIndianDay = derivePositions(input('2026-08-11T22:00:00.000Z'))
    expect(previousIndianDay.ok).toBe(true)
    if (!previousIndianDay.ok) return
    expect(previousIndianDay.value[0]?.snapshotAgeDays).toBe(1)
  })

  it('leaves a folded position with no age at all', () => {
    // A quantity derived from transactions does not go stale the way a photograph does, so an age
    // would be a meaningless number that a screen might render.
    const folded: FoldInput = {
      accountId: 'a-coin',
      capability: 'ledger',
      txns: [],
      snapshots: [],
      instruments: new Map([['i-btc', BTC]]),
      asOf: AS_OF,
    }
    const result = derivePositions(folded)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const position of result.value) {
      if (position.basis === 'folded') expect(position.snapshotAgeDays).toBeNull()
    }
  })
})
