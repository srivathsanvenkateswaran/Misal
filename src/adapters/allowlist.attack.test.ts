/**
 * Adversarial tests against the request allowlist.
 *
 * This control is load-bearing in a way nothing else in Misal is. CoinDCX issues no read-only API
 * keys - every key can trade and withdraw - so the only thing standing between a user's funds and
 * a bug is this module refusing to emit a mutating request. It therefore gets attacked, not merely
 * exercised.
 *
 * Two entry points are attacked, because they have different threat models:
 *
 *   authorise()               - a request about to go out. The attacker is a bug in adapter code
 *                               constructing a path from data.
 *   assertAllowlistIsReadOnly - an adapter's declared allowlist. The attacker is a contributed
 *                               adapter whose disguised entry survives code review. Misal is open
 *                               source and expects outside adapters, so this is the realistic one.
 *
 * A failure here is not a style issue. Anything that gets through is a route to moving money.
 *
 * Note on layering: `isMutatingPath` alone does NOT enforce well-formedness, and classifies several
 * of the paths below as read-only. That is safe only because every caller goes through
 * `assertWellFormedPath` first. Calling the classifier directly is a footgun, which is why these
 * tests exercise the gates rather than the classifier.
 */

import { describe, expect, it } from 'vitest'
import { AllowlistViolation, assertAllowlistIsReadOnly, authorise } from './allowlist'
import type { AllowedRequest } from './contract'

// Adapters declare logical host keys, not hostnames; the concrete host is resolved
// from a map the adapter cannot widen. 'public' is the unauthenticated market-data host.
const HOST = 'primary' as const

/** A realistic read-only allowlist, as a well-behaved adapter would declare it. */
const READ_ONLY_ALLOWLIST: readonly AllowedRequest[] = [
  { method: 'GET', host: HOST, pathPattern: '/api/v3/account' },
  { method: 'GET', host: HOST, pathPattern: '/api/v3/myTrades' },
  { method: 'GET', host: HOST, pathPattern: '/api/v3/exchangeInfo' },
  { method: 'GET', host: HOST, pathPattern: '/sapi/v1/account/apiRestrictions' },
  { method: 'GET', host: HOST, pathPattern: '/sapi/v1/capital/deposit/hisrec' },
]

/** Disguised forms of genuinely mutating endpoints. */
const SMUGGLED: ReadonlyArray<readonly [label: string, path: string]> = [
  ['plain order', '/api/v3/order'],
  ['plain withdraw', '/sapi/v1/capital/withdraw/apply'],
  ['coindcx create order', '/exchange/v1/orders/create'],

  ['encoded slash', '/api/v3%2Forder'],
  ['double-encoded slash', '/api/v3%252Forder'],
  ['encoded letter', '/api/v3/%6Frder'],
  ['fully encoded segment', '/api/v3/%6F%72%64%65%72'],

  ['dot-dot traversal', '/api/v3/ticker/../order'],
  ['encoded traversal', '/api/v3/ticker/%2E%2E/order'],
  ['single dot segment', '/api/v3/./order'],
  ['double slash', '/api/v3//order'],

  ['upper case', '/API/V3/ORDER'],
  ['mixed case', '/Api/V3/Order'],

  ['trailing slash', '/api/v3/order/'],
  ['trailing dot', '/api/v3/order.'],
  ['trailing space', '/api/v3/order '],
  ['trailing semicolon param', '/api/v3/order;x=1'],

  ['query appended', '/api/v3/order?symbol=BTCUSDT'],
  ['fragment appended', '/api/v3/order#read'],
  ['read path with mutating query', '/api/v3/account?redirect=/api/v3/order'],

  ['absolute url', 'https://api.binance.com/api/v3/order'],
  ['protocol-relative url', '//api.binance.com/api/v3/order'],
  ['different host entirely', 'https://evil.example/api/v3/order'],

  ['fullwidth characters', '/api/v3/ｏrder'],
  ['cyrillic homoglyph', '/api/v3/оrder'],
  ['zero-width space inside', '/api/v3/or​der'],

  ['leading whitespace', '  /api/v3/order'],
  ['embedded newline', '/api/v3/order\n'],
  ['embedded tab', '/api/v3/\torder'],
]

describe('authorise refuses every disguised mutating request', () => {
  it.each(SMUGGLED)('refuses %s', (_label, path) => {
    expect(
      () => { authorise('binance', READ_ONLY_ALLOWLIST, { method: 'GET', host: HOST, path }) },
      `"${path}" was authorised; this is a route to moving money`,
    ).toThrow(AllowlistViolation)
  })

  it('refuses a mutating HTTP method even on an allowlisted read path', () => {
    expect(() => {
      authorise('binance', READ_ONLY_ALLOWLIST, {
        method: 'POST',
        host: HOST,
        path: '/api/v3/account',
      })
    }).toThrow(AllowlistViolation)
  })

  it('refuses a read path on a host key the adapter did not declare for it', () => {
    // The allowlist declares these paths on 'primary' only. Asking for the same path on the
    // public host must not be waved through just because the path itself is read-only.
    expect(() => {
      authorise('binance', READ_ONLY_ALLOWLIST, {
        method: 'GET',
        host: 'public',
        path: '/api/v3/account',
      })
    }).toThrow(AllowlistViolation)
  })
})

describe('a contributed adapter cannot declare a disguised mutating allowlist', () => {
  it.each(SMUGGLED)('rejects an allowlist containing %s', (_label, path) => {
    expect(
      () => {
        assertAllowlistIsReadOnly('contributed', [{ method: 'GET', host: HOST, pathPattern: path }])
      },
      `an adapter declaring "${path}" was accepted`,
    ).toThrow(AllowlistViolation)
  })

  it('rejects a bare wildcard that would admit everything', () => {
    expect(() => {
      assertAllowlistIsReadOnly('contributed', [
        { method: 'GET', host: HOST, pathPattern: '/api/*' },
      ])
    }).not.toThrow()

    // A wildcard anywhere but the tail can straddle a mutating segment.
    expect(() => {
      assertAllowlistIsReadOnly('contributed', [
        { method: 'GET', host: HOST, pathPattern: '/api/*/order' },
      ])
    }).toThrow(AllowlistViolation)
  })
})

describe('the adapters the product actually ships still work', () => {
  const LEGITIMATE = [
    '/api/v3/account',
    '/api/v3/myTrades',
    '/api/v3/exchangeInfo',
    '/sapi/v1/account/apiRestrictions',
    '/sapi/v1/capital/deposit/hisrec',
  ] as const

  it.each(LEGITIMATE)('authorises GET %s', (path) => {
    expect(() => {
      authorise('binance', READ_ONLY_ALLOWLIST, { method: 'GET', host: HOST, path })
    }).not.toThrow()
  })
})
