import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AllowlistViolation,
  assertAllowlistIsReadOnly,
  authorise,
  classifyPath,
  isAllowed,
} from './allowlist'
import type { AllowedRequest } from './contract'

interface PathTable {
  mutating: string[]
  readOnly: string[]
  wildcard: { pattern: string; refused: string; allowed: string }
}

const table = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/adapters/mutating-paths.json'), 'utf8'),
) as PathTable

describe('path classification', () => {
  // The same table drives the Rust transport's tests, so the two implementations cannot drift
  // apart without one of them failing.
  it.each(table.mutating)('refuses %s', (path) => {
    expect(classifyPath(path).mutating).toBe(true)
  })

  it.each(table.readOnly)('permits %s', (path) => {
    expect(classifyPath(path)).toEqual({ mutating: false, reason: '' })
  })

  it('distinguishes reading withdrawals from performing one by the last segment alone', () => {
    expect(classifyPath('/sapi/v1/capital/withdraw/history').mutating).toBe(false)
    expect(classifyPath('/sapi/v1/capital/withdraw/apply').mutating).toBe(true)
  })
})

describe('the wildcard hole', () => {
  const allowlist: readonly AllowedRequest[] = [
    { method: 'GET', pathPattern: table.wildcard.pattern, host: 'primary' },
  ]

  it('matches the pattern, which is exactly why the pattern is not the only check', () => {
    expect(
      isAllowed(allowlist, { method: 'GET', path: table.wildcard.refused, host: 'primary' }),
    ).toBe(true)
  })

  it('still refuses the concrete mutating path at send time', () => {
    expect(() =>
      authorise('test', allowlist, { method: 'GET', path: table.wildcard.refused, host: 'primary' }),
    ).toThrow(AllowlistViolation)
  })

  it('allows a concrete read under the same wildcard', () => {
    expect(() =>
      authorise('test', allowlist, { method: 'GET', path: table.wildcard.allowed, host: 'primary' }),
    ).not.toThrow()
  })
})

describe('authorise', () => {
  const allowlist: readonly AllowedRequest[] = [
    { method: 'GET', pathPattern: '/api/v3/myTrades', host: 'primary' },
  ]

  it('refuses a path that is not listed', () => {
    expect(() =>
      authorise('test', allowlist, { method: 'GET', path: '/api/v3/account', host: 'primary' }),
    ).toThrow(/not on the request allowlist/)
  })

  it('refuses the right path on the wrong host', () => {
    expect(() =>
      authorise('test', allowlist, { method: 'GET', path: '/api/v3/myTrades', host: 'public' }),
    ).toThrow(AllowlistViolation)
  })

  it('refuses the right path with the wrong method', () => {
    expect(() =>
      authorise('test', allowlist, { method: 'POST', path: '/api/v3/myTrades', host: 'primary' }),
    ).toThrow(AllowlistViolation)
  })

  it('refuses a traversal that would resolve to a mutating endpoint at the server', () => {
    // '/api/v3/myTrades/../order' is on no allowlist, but a server would resolve it to the order
    // endpoint. Path shape is checked before anything else for exactly this reason.
    expect(() =>
      authorise('test', allowlist, {
        method: 'GET',
        path: '/api/v3/myTrades/../order',
        host: 'primary',
      }),
    ).toThrow(/malformed path/)
  })

  it('refuses a path smuggling a query string or fragment', () => {
    for (const path of ['/api/v3/myTrades?symbol=X', '/api/v3/myTrades#/order', '//api/v3/order']) {
      expect(() => authorise('test', allowlist, { method: 'GET', path, host: 'primary' })).toThrow(
        AllowlistViolation,
      )
    }
  })
})

describe('allowlist validation at registration', () => {
  it('rejects a mutating entry', () => {
    expect(() =>
      assertAllowlistIsReadOnly('rogue', [
        { method: 'POST', pathPattern: '/api/v3/order', host: 'primary' },
      ]),
    ).toThrow(/is mutating/)
  })

  it('rejects a wildcard that is not a single trailing segment', () => {
    expect(() =>
      assertAllowlistIsReadOnly('rogue', [
        { method: 'GET', pathPattern: '/api/*/myTrades', host: 'primary' },
      ]),
    ).toThrow(AllowlistViolation)
  })
})
