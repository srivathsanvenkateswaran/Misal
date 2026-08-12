/**
 * The request allowlist: the control that actually makes Misal read-only.
 *
 * CoinDCX issues one key class with full trade authority. There is no read-only option, no
 * permission model to query, and no way to introspect what a key may do - a key that
 * authenticates is a full-access key. CoinSwitch is the same. If the safety story were "use a
 * read-only key", it would be a story we could not tell for half the exchanges we support.
 *
 * So the guarantee is inverted. Each adapter declares the exact set of requests it may make; the
 * transport refuses everything else before a socket is opened. Binance's `POST /api/v3/order` is
 * unreachable from Misal not because the key forbids it but because no code path can express it.
 *
 * Two independent checks run on every request, and the second is the one that matters:
 *
 *   1. The concrete method and path must match an allowlist entry.
 *   2. The concrete path must not name a mutating operation - checked again at send time, not
 *      only when the list was written. A trailing wildcard is otherwise a hole: '/api/v3/*' would
 *      admit '/api/v3/order' while looking perfectly innocent in review.
 *
 * `isMutatingPath` is duplicated in the Rust transport (src-tauri/src/exchange_guard.rs). Both
 * implementations are driven by the same fixture table, tests/fixtures/adapters/mutating-paths.json,
 * so the two cannot drift apart without a test failing on one side or the other.
 */

import type { AllowedRequest, GuardedRequest } from './contract'

/**
 * Path segments that name an operation which changes state.
 *
 * Matched per segment rather than as substrings, because a substring match on 'order' would also
 * reject '/exchange/v1/orders/trade_history' and a substring match on 'withdraw' would reject
 * '/sapi/v1/capital/withdraw/history' - both of which are read-only history endpoints we need.
 */
const MUTATING_SEGMENTS: ReadonlySet<string> = new Set([
  'order',
  'orders',
  'openorders',
  'orderlist',
  'oco',
  'cancel',
  'cancelreplace',
  'create',
  'new',
  'delete',
  'update',
  'edit',
  'buy',
  'sell',
  'withdraw',
  'withdrawal',
  'withdrawals',
  'apply',
  'transfer',
  'transfers',
  'convert',
  'borrow',
  'repay',
  'loan',
  'redeem',
  'subscribe',
  'purchase',
  'lend',
  'stake',
  'unstake',
  'send',
  'pay',
  'enable',
  'disable',
])

/**
 * Terminal segments that turn a mutating noun into a read of its history.
 *
 * Only the last segment is consulted. '/sapi/v1/capital/withdraw/history' reads withdrawals;
 * '/sapi/v1/capital/withdraw/apply' performs one, and the difference is entirely in the tail.
 */
const READ_TERMINALS: ReadonlySet<string> = new Set([
  'history',
  'hisrec',
  'trade_history',
  'tradehistory',
  'list',
  'status',
  'info',
  'detail',
  'details',
  'query',
  'all',
  'records',
  'log',
  'logs',
])

export interface MutationVerdict {
  readonly mutating: boolean
  /** Why, in words a reviewer can act on. Empty when the path is read-only. */
  readonly reason: string
}

/**
 * Split a path segment into comparable tokens.
 *
 * Matching whole segments is not enough: the well-formed-path grammar permits `.`, `_` and `-`,
 * so `order.`, `order.json`, `_order` and `order-v2` all differ from `order` as strings while
 * naming the same operation. A contributed adapter could put any of them on its allowlist and
 * pass review. Tokenising on that punctuation closes the family rather than the one example.
 */
function tokensOf(segment: string): string[] {
  return segment.split(/[._-]+/).filter((t) => t !== '')
}

/** Classify a concrete path, or an allowlist pattern, as mutating or not. */
export function classifyPath(path: string): MutationVerdict {
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase())

  const last = segments[segments.length - 1]
  // A wildcard tail cannot be shown to be read-only, so it never earns the exemption below.
  const readOnlyTail = last !== undefined && last !== '*' && READ_TERMINALS.has(last)

  for (const segment of segments) {
    for (const token of tokensOf(segment)) {
      if (!MUTATING_SEGMENTS.has(token)) continue
      if (readOnlyTail) continue
      return {
        mutating: true,
        reason:
          token === segment
            ? `path segment '${segment}' names a mutating operation`
            : `path segment '${segment}' contains '${token}', which names a mutating operation`,
      }
    }
  }

  return { mutating: false, reason: '' }
}

export function isMutatingPath(path: string): boolean {
  return classifyPath(path).mutating
}

export class AllowlistViolation extends Error {
  override readonly name = 'AllowlistViolation'
}

/**
 * Paths are plain, unescaped, absolute and dot-free.
 *
 * Without this, an allowlist is decoration: '/api/v3/myTrades/../order' matches nothing on the
 * list but resolves to the order endpoint at the server, and '/api/v3/myTrades?x=1#/order' hides
 * a query string inside what the guard reads as a path. Both exchanges use nothing but
 * `[A-Za-z0-9._-]` in their paths, so refusing everything else costs nothing.
 */
const WELL_FORMED_PATH = /^(?:\/[A-Za-z0-9._-]+)+$/
const WELL_FORMED_PATTERN = /^(?:\/[A-Za-z0-9._-]+)+(?:\/\*)?$/

export function assertWellFormedPath(what: string, path: string, isPattern = false): void {
  const ok = (isPattern ? WELL_FORMED_PATTERN : WELL_FORMED_PATH).test(path)
  if (!ok || path.includes('..')) {
    throw new AllowlistViolation(`${what}: malformed path ${JSON.stringify(path)}`)
  }
}

/**
 * Validate an allowlist at construction.
 *
 * Called wherever an adapter is registered, and again in the Rust transport when the session is
 * built, so a mutating entry cannot reach a socket even if it survives review.
 */
export function assertAllowlistIsReadOnly(
  adapterId: string,
  allowlist: readonly AllowedRequest[],
): void {
  for (const entry of allowlist) {
    assertWellFormedPath(`${adapterId} allowlist`, entry.pathPattern, true)
    const verdict = classifyPath(entry.pathPattern)
    if (verdict.mutating) {
      throw new AllowlistViolation(
        `${adapterId} allowlist entry ${entry.method} ${entry.pathPattern} is mutating: ${verdict.reason}`,
      )
    }
    const wildcards = entry.pathPattern.split('*').length - 1
    if (wildcards > 1 || (wildcards === 1 && !entry.pathPattern.endsWith('/*'))) {
      throw new AllowlistViolation(
        `${adapterId} allowlist entry ${entry.pathPattern} may use at most one trailing '/*'`,
      )
    }
  }
}

function matchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return path.startsWith(prefix) && path.length > prefix.length
  }
  return pattern === path
}

/** Whether a request is on the list. Does not consider the mutation check; `authorise` does both. */
export function isAllowed(
  allowlist: readonly AllowedRequest[],
  request: Pick<GuardedRequest, 'method' | 'path' | 'host'>,
): boolean {
  return allowlist.some(
    (entry) =>
      entry.method === request.method &&
      entry.host === request.host &&
      matchesPattern(entry.pathPattern, request.path),
  )
}

/**
 * The gate. Throws unless the request is both allowlisted and non-mutating.
 *
 * Deliberately throws rather than returning a result: a caller that forgets to check a boolean is
 * exactly the mistake this module exists to make impossible.
 */
export function authorise(
  adapterId: string,
  allowlist: readonly AllowedRequest[],
  request: Pick<GuardedRequest, 'method' | 'path' | 'host'>,
): void {
  assertWellFormedPath(`${adapterId} refused ${request.method} ${request.path}`, request.path)
  const verdict = classifyPath(request.path)
  if (verdict.mutating) {
    throw new AllowlistViolation(
      `${adapterId} refused ${request.method} ${request.path}: ${verdict.reason}`,
    )
  }
  if (!isAllowed(allowlist, request)) {
    throw new AllowlistViolation(
      `${adapterId} refused ${request.method} ${request.path}: not on the request allowlist`,
    )
  }
}
