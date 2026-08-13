/**
 * The withheld total, which is the one number the review queue exists to state.
 *
 * These are the cases where a plausible-looking total would be a lie: an entry the source printed no
 * value for, an entry in a currency this build cannot format, a figure past 2^53, and two currencies
 * that must never be added together.
 */

import { describe, expect, it } from 'vitest'
import type { ReviewQueueEntry } from '../../data/settings'
import {
  entriesInState,
  entryWithheld,
  formatWithheld,
  identifierLabel,
  identifierValue,
  summariseWithheld,
  withheldCaveat,
} from './review'

function entry(over: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    id: 'u1',
    accountId: 'a1',
    accountLabel: 'HDFC folio',
    providerShortCode: 'CAS',
    rawIdentifier: 'isin:INF179K01YV8',
    rawName: 'A fund',
    assetClassHint: 'mutual_fund',
    observedQuantity: '10',
    observedValueMinor: '11864000',
    currency: 'INR',
    firstSeenAt: '2026-07-01T00:00:00Z',
    lastSeenAt: null,
    ignoredAt: null,
    mappedAt: null,
    mappedInstrumentId: null,
    mappedInstrumentName: null,
    state: 'open',
    ...over,
  }
}

describe('withheld totals', () => {
  it('counts a dismissed entry exactly as it counts an open one', () => {
    const summary = summariseWithheld([
      entry({ id: 'a', state: 'open', observedValueMinor: '100' }),
      entry({ id: 'b', state: 'dismissed', ignoredAt: 'x', observedValueMinor: '200' }),
      entry({ id: 'c', state: 'mapped', mappedAt: 'x', observedValueMinor: '300' }),
    ])
    expect(summary.totals).toEqual([{ currency: 'INR', minor: '600', entries: 3 }])
    expect(withheldCaveat(summary)).toBeNull()
  })

  /**
   * A paise value past 2^53 must survive. Through a float the last digit is lost, and the withheld
   * figure is the one number in the product meant to be believed literally.
   */
  it('adds beyond the range of a float without losing a digit', () => {
    const summary = summariseWithheld([
      entry({ id: 'a', observedValueMinor: '9007199254740993' }),
      entry({ id: 'b', observedValueMinor: '1' }),
    ])
    expect(summary.totals[0]?.minor).toBe('9007199254740994')
  })

  it('keeps two currencies apart rather than adding numbers that are not the same money', () => {
    const summary = summariseWithheld([
      entry({ id: 'a', observedValueMinor: '500000', currency: 'INR' }),
      entry({ id: 'b', observedValueMinor: '20000', currency: 'USD' }),
    ])
    expect(summary.totals).toEqual([
      { currency: 'INR', minor: '500000', entries: 1 },
      { currency: 'USD', minor: '20000', entries: 1 },
    ])
    expect(formatWithheld(summary)).toBe('₹5,000 + $200')
  })

  it('counts an entry with no stated value instead of folding it in as zero', () => {
    const summary = summariseWithheld([
      entry({ id: 'a', observedValueMinor: '500000' }),
      entry({ id: 'b', observedValueMinor: null, currency: null }),
    ])
    expect(summary.unstated).toBe(1)
    expect(summary.totals).toEqual([{ currency: 'INR', minor: '500000', entries: 1 }])
    expect(withheldCaveat(summary)).toBe(
      'Excludes 1 entry whose source stated no value; the amount those withhold is unknown, not zero.',
    )
  })

  it('counts a currency it cannot format rather than pretending the figure is rupees', () => {
    const summary = summariseWithheld([entry({ observedValueMinor: '4200', currency: 'X:USDT' })])
    expect(summary.unquantifiable).toBe(1)
    expect(summary.totals).toEqual([])
    expect(formatWithheld(summary)).toBe(
      'amount unknown — the values are in a currency Misal cannot total',
    )
    expect(entryWithheld(entry({ observedValueMinor: '4200', currency: 'X:USDT' }))).toBeNull()
  })

  it('counts a malformed figure rather than letting it become a plausible total', () => {
    const summary = summariseWithheld([entry({ observedValueMinor: '1,186.40' })])
    expect(summary.unquantifiable).toBe(1)
    expect(summary.totals).toEqual([])
  })

  it('says nothing is withheld only when nothing is', () => {
    expect(formatWithheld(summariseWithheld([]))).toBe('nothing withheld')
    expect(formatWithheld(summariseWithheld([entry({ observedValueMinor: null })]))).toBe(
      'amount unknown — the source stated no value',
    )
  })
})

describe('queue grouping and identifiers', () => {
  it('splits the three states', () => {
    const entries = [
      entry({ id: 'a', state: 'open' }),
      entry({ id: 'b', state: 'dismissed' }),
      entry({ id: 'c', state: 'mapped' }),
      entry({ id: 'd', state: 'dismissed' }),
    ]
    expect(entriesInState(entries, 'dismissed').map((e) => e.id)).toEqual(['b', 'd'])
    expect(entriesInState(entries, 'open').map((e) => e.id)).toEqual(['a'])
    expect(entriesInState(entries, 'mapped').map((e) => e.id)).toEqual(['c'])
  })

  it('names what the parser could read, rather than showing a raw scheme prefix', () => {
    expect(identifierLabel('isin:INF179K01YV8')).toBe('Unrecognised ISIN')
    expect(identifierLabel('amfi:120503')).toBe('Unrecognised AMFI scheme code')
    expect(identifierLabel('provider-local:XYZ')).toBe('Unrecognised broker or exchange code')
    expect(identifierLabel('name:Some Fund')).toBe(
      'Unrecognised name — the source printed no identifier',
    )
    expect(identifierLabel('weird')).toBe('Unrecognised identifier')
    expect(identifierValue('isin:INF179K01YV8')).toBe('INF179K01YV8')
    expect(identifierValue('weird')).toBe('weird')
  })
})
