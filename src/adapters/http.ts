/**
 * The guarded transport.
 *
 * Everything an adapter can do to the network passes through here. The TypeScript side never
 * holds the API secret and never opens a socket: it hands a fully serialised request to the Rust
 * core, which checks the allowlist a second time, signs the exact bytes, sends them, and returns
 * the response as text.
 *
 * The allowlist check is deliberately duplicated on both sides. The Rust check is the one that
 * counts - it is closest to the socket and cannot be bypassed by a bug up here - but failing in
 * TypeScript gives a contributor a stack trace pointing at the offending adapter line rather than
 * an opaque error from the core.
 */

import type {
  AllowedRequest,
  GuardedHttp,
  GuardedRequest,
  GuardedResponse,
  HostKey,
  ProviderId,
} from './contract'
import { authorise } from './allowlist'
import { AdapterError, headerValue, retryAfterMs } from './errors'
import type { RateLimiter } from './ratelimit'

/**
 * What crosses to the Rust core.
 *
 * `query` and `body` are strings, already serialised by the adapter. The core appends the
 * signature to the query or sets the signature header, and transmits those exact bytes; there is
 * no object here for anything to re-encode.
 */
export interface TransportRequest {
  readonly adapterId: ProviderId
  readonly accountId: string
  readonly allowlist: readonly AllowedRequest[]
  readonly hostUrl: string
  readonly host: HostKey
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly query: string
  readonly body: string | null
  readonly signing: GuardedRequest['signing']
  readonly userAgent: string
  /**
   * Sign with a staged, memory-only credential rather than the account's stored one.
   *
   * Present only during the connect probe, which has to authenticate before the scope check has
   * decided whether the secret may be written to the keychain at all.
   */
  readonly credentialHandle?: string
}

/**
 * The socket-owning layer. Implemented by the Rust core in production and by a fixture replayer
 * in tests; there is no third implementation, and the test environment can construct only the
 * second.
 *
 * The Rust side of this - allowlist enforcement, signing and secret handling - is
 * `src-tauri/src/exchange_guard.rs`. Binding an HTTP client to its `Transport` trait and exposing
 * the Tauri command that drives it is the one integration step still outstanding; nothing in this
 * file or in either adapter changes when it lands.
 */
export interface Transport {
  send(request: TransportRequest): Promise<GuardedResponse>
}

export interface GuardedHttpOptions {
  readonly adapterId: ProviderId
  readonly accountId: string
  readonly allowlist: readonly AllowedRequest[]
  readonly hosts: Readonly<Record<HostKey, string>>
  readonly transport: Transport
  readonly limiter: RateLimiter
  /**
   * Explicit and browser-like. CoinDCX sits behind Cloudflare, which answers a default library
   * user-agent with a non-JSON 403 that looks exactly like an auth failure.
   */
  readonly userAgent: string
  readonly maxAttempts?: number
  /** See TransportRequest.credentialHandle. */
  readonly credentialHandle?: string
}

const DEFAULT_MAX_ATTEMPTS = 5

/** Binance's IP ban starts at two minutes and escalates. Assume the longest published start. */
const DEFAULT_BAN_MS = 120_000

export function createGuardedHttp(options: GuardedHttpOptions): GuardedHttp {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  return {
    async send(request: GuardedRequest): Promise<GuardedResponse> {
      // Before the limiter, before the socket, before anything: is this request expressible?
      authorise(options.adapterId, options.allowlist, request)

      const weight = request.weight ?? 1
      let lastError: AdapterError | null = null

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await options.limiter.acquire(weight)

        const response = await send(options, request)
        options.limiter.observe(response.headers)

        const failure = classifyTransportFailure(response, options.limiter)
        if (failure === null) return response
        if (!failure.retryable) throw failure

        lastError = failure
        if (attempt === maxAttempts) break
        const wait = failure.retryAfterMs ?? options.limiter.backoffMs(attempt)
        await options.limiter.sleep(wait)
      }

      throw (
        lastError ??
        new AdapterError('network', 'The exchange did not respond.', {
          detail: `${request.method} ${request.path}`,
        })
      )
    },
  }
}

async function send(
  options: GuardedHttpOptions,
  request: GuardedRequest,
): Promise<GuardedResponse> {
  const hostUrl = options.hosts[request.host]
  try {
    return await options.transport.send({
      adapterId: options.adapterId,
      accountId: options.accountId,
      allowlist: options.allowlist,
      hostUrl,
      host: request.host,
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
      signing: request.signing,
      userAgent: options.userAgent,
      ...(options.credentialHandle === undefined
        ? {}
        : { credentialHandle: options.credentialHandle }),
    })
  } catch (cause) {
    if (cause instanceof AdapterError) throw cause
    throw new AdapterError('network', 'Could not reach the exchange.', {
      detail: `${request.method} ${request.path}`,
      cause,
    })
  }
}

/**
 * Failures every exchange shares. Anything else - a 400 or a 401 with a provider-specific body -
 * is returned to the adapter, which is the only layer that knows what its error codes mean.
 */
export function classifyTransportFailure(
  response: GuardedResponse,
  limiter: RateLimiter,
): AdapterError | null {
  if (response.status < 400) return null

  if (response.status === 418) {
    const wait = retryAfterMs(response.headers) ?? DEFAULT_BAN_MS
    limiter.halt(wait, 'Binance has temporarily banned this IP address.')
    return new AdapterError(
      'ip_banned',
      'The exchange has temporarily banned this IP address. Syncing is paused until it lifts.',
      { retryAfterMs: wait, detail: response.text.slice(0, 200) },
    )
  }

  if (response.status === 429) {
    const wait = retryAfterMs(response.headers)
    return new AdapterError('rate_limited', 'The exchange is rate limiting us.', {
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
      detail: response.text.slice(0, 200),
    })
  }

  // A WAF block, not an auth failure. The fix is a request header, not a new API key.
  if (response.status === 403 && !looksLikeJson(response)) {
    return new AdapterError(
      'blocked_by_edge',
      'The exchange’s edge network blocked the request. This is not a problem with your key.',
      { detail: response.text.slice(0, 200) },
    )
  }

  if (response.status >= 500) {
    return new AdapterError('upstream_unavailable', 'The exchange is unavailable right now.', {
      detail: `HTTP ${response.status}: ${response.text.slice(0, 200)}`,
    })
  }

  return null
}

function looksLikeJson(response: GuardedResponse): boolean {
  const contentType = headerValue(response.headers, 'content-type') ?? ''
  if (contentType.toLowerCase().includes('json')) return true
  const body = response.text.trimStart()
  return body.startsWith('{') || body.startsWith('[')
}
