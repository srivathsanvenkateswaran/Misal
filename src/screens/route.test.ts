/**
 * The router.
 *
 * View state lives in the hash, so these are also the tests for "can a user come back to this".
 */

import { describe, expect, it } from 'vitest'
import { hrefFor, parseRoute } from './route'

describe('parseRoute', () => {
  it('reads the four screens', () => {
    expect(parseRoute('#/')).toEqual({ kind: 'dashboard' })
    expect(parseRoute('#/accounts')).toEqual({ kind: 'accounts' })
    expect(parseRoute('#/instruments')).toEqual({ kind: 'instruments' })
    expect(parseRoute('#/holdings')).toEqual({ kind: 'holdings', group: 'asset_class' })
  })

  it('carries the holdings grouping in the query string, so it can be returned to', () => {
    expect(parseRoute('#/holdings?group=account')).toEqual({ kind: 'holdings', group: 'account' })
    expect(parseRoute('#/holdings?group=none')).toEqual({ kind: 'holdings', group: 'none' })
  })

  it('falls back to the default grouping rather than trusting an unknown value', () => {
    expect(parseRoute('#/holdings?group=whatever')).toEqual({
      kind: 'holdings',
      group: 'asset_class',
    })
  })

  it('reads an instrument id, decoded', () => {
    expect(parseRoute('#/instruments/i-ppfc')).toEqual({
      kind: 'instrument',
      instrumentId: 'i-ppfc',
    })
    expect(parseRoute('#/instruments/a%2Fb')).toEqual({ kind: 'instrument', instrumentId: 'a/b' })
  })

  it('treats an unknown path as the dashboard rather than as a blank screen', () => {
    expect(parseRoute('#/nowhere')).toEqual({ kind: 'dashboard' })
    expect(parseRoute('')).toEqual({ kind: 'dashboard' })
  })
})

describe('hrefFor', () => {
  it('round-trips every route', () => {
    for (const route of [
      { kind: 'dashboard' } as const,
      { kind: 'accounts' } as const,
      { kind: 'instruments' } as const,
      { kind: 'holdings', group: 'asset_class' } as const,
      { kind: 'holdings', group: 'account' } as const,
      { kind: 'instrument', instrumentId: 'i-ppfc' } as const,
    ]) {
      expect(parseRoute(hrefFor(route))).toEqual(route)
    }
  })
})
