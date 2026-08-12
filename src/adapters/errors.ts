/**
 * The adapter error taxonomy.
 *
 * Every code here exists because it needs different handling, and two of them exist because the
 * obvious classification would send the user to fix the wrong thing:
 *
 *   `auth_or_skew` - CoinDCX returns an identical `401 Invalid credentials` for a bad key, a
 *   stale timestamp and a missing timestamp. Reporting that as "invalid credentials" would send
 *   users to regenerate a perfectly good key.
 *
 *   `blocked_by_edge` - CoinDCX sits behind Cloudflare, which answers a non-browser User-Agent
 *   with a text/plain 403. Treating a 403 as an auth failure would say the key is bad when the
 *   real fix is a request header.
 */

import { delayMillis } from './duration'

export type AdapterErrorCode =
  /** Terminal; needs the user. */
  | 'auth_invalid'
  /** Terminal after one retry; CoinDCX's ambiguous 401. */
  | 'auth_or_skew'
  /** Terminal; credential refused at connect or quarantined mid-life. */
  | 'auth_over_scoped'
  /** One automatic resync-and-retry, then terminal. */
  | 'clock_skew'
  | 'rate_limited'
  /** The adapter is halted for the ban duration. Retrying into a ban extends it. */
  | 'ip_banned'
  | 'network'
  /** 5xx or maintenance. */
  | 'upstream_unavailable'
  /** The page is abandoned and logged as an import_issue; the sync continues. */
  | 'malformed_response'
  /** Non-JSON 403 from a WAF. Retryable, and NOT an auth failure. */
  | 'blocked_by_edge'
  /** A request the allowlist does not permit. Never retryable; it is a programming error. */
  | 'request_not_allowed'

const RETRYABLE: ReadonlySet<AdapterErrorCode> = new Set<AdapterErrorCode>([
  'rate_limited',
  'network',
  'upstream_unavailable',
  'blocked_by_edge',
])

export interface AdapterErrorOptions {
  /** Diagnostics pane only; never contains the secret. */
  readonly detail?: string
  readonly retryAfterMs?: number
  readonly cause?: unknown
}

export class AdapterError extends Error {
  override readonly name = 'AdapterError'
  readonly code: AdapterErrorCode
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly detail: string | undefined

  constructor(code: AdapterErrorCode, message: string, options: AdapterErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryable = RETRYABLE.has(code)
    this.retryAfterMs = options.retryAfterMs
    this.detail = options.detail
  }
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError
}

/** Parse a `Retry-After` header. Seconds only; the HTTP-date form is not used by either API. */
export function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = headerValue(headers, 'retry-after')
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  // delayMillis bounds it, so a mistaken header cannot park a sync for a week.
  return delayMillis(BigInt(raw.trim()) * 1000n)
}

/** Case-insensitive header lookup. Header casing differs between the two exchanges. */
export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}
