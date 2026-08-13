/**
 * Signed Binance calls, and the error vocabulary they can fail with.
 *
 * Split out of the adapter so trade history, transfer history and Convert history all go down the
 * one path that knows about `recvWindow`, the clock offset and the single permitted re-measurement
 * on a `-1021`. Three copies of that retry would be three chances to get "at most once" wrong.
 */

import type { AdapterContext } from '../contract'
import { AdapterError } from '../errors'
import { parseLossless, textOrNull } from '../lossless-json'
import { signingTimestamp } from '../time'
import { queryString } from '../wire'

/** Binance's default is 5000 ms and its cap is 60000. Generous but inside the cap. */
const RECV_WINDOW = '10000'

export interface SignedCall {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly params: readonly (readonly [string, string])[]
  /** Weight against the per-IP budget. */
  readonly weight: number
  /**
   * Weight against the per-account budget, where the endpoint is metered on that one instead.
   *
   * Binance publishes these separately and they are not comparable: deposit history is IP weight 1
   * and withdrawal history is UID weight 18,000 out of 180,000 a minute.
   */
  readonly uidWeight?: number
}

/**
 * Issue a signed request, re-measuring the clock exactly once on a `-1021` rejection.
 *
 * One retry, then a typed `clock_skew` error naming the measured drift. Retrying indefinitely
 * against a broken clock burns rate budget and hides a real machine problem.
 */
export async function signed(ctx: AdapterContext, call: SignedCall) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const query = queryString([
      ...call.params,
      ['recvWindow', RECV_WINDOW],
      ['timestamp', signingTimestamp(ctx.now(), ctx.clock.offsetMs)],
    ])
    const response = await ctx.http.send({
      method: call.method,
      host: 'primary',
      path: call.path,
      query,
      body: null,
      signing: 'binance-query',
      weight: call.weight,
      ...(call.uidWeight === undefined ? {} : { uidWeight: call.uidWeight }),
    })
    if (response.status < 400) return response

    const error = binanceError(response.status, response.text)
    if (error.code === 'clock_skew' && attempt === 0) {
      await ctx.clock.resync()
      continue
    }
    throw error
  }
  throw new AdapterError('clock_skew', 'Binance rejected our timestamp twice.', {
    detail: `offset ${ctx.clock.offsetMs} ms`,
  })
}

/** Binance error bodies are `{"code": -1021, "msg": "..."}`. */
export function binanceError(status: number, body: string): AdapterError {
  let code: string | null = null
  let msg = body.slice(0, 200)
  try {
    const parsed = parseLossless(body)
    code = textOrNull(parsed, 'code')
    msg = textOrNull(parsed, 'msg') ?? msg
  } catch {
    // Not JSON. Fall through to the status-based classification below.
  }

  switch (code ?? '') {
    case '-1021':
      return new AdapterError(
        'clock_skew',
        'Your computer’s clock is too far from Binance’s. Misal re-checked it once and Binance ' +
          'still refused the request; please correct your system time.',
        { detail: msg },
      )
    case '-1022':
      return new AdapterError('auth_invalid', 'Binance rejected the request signature.', {
        detail: msg,
      })
    case '-2014':
      return new AdapterError('auth_invalid', 'That API key is not in a format Binance accepts.', {
        detail: msg,
      })
    case '-2015':
      return new AdapterError(
        'auth_invalid',
        'Binance rejected the key, this IP address, or the key’s permissions.',
        { detail: msg },
      )
    default:
      break
  }

  if (status === 401 || status === 403) {
    return new AdapterError('auth_invalid', 'Binance rejected the credentials.', { detail: msg })
  }
  return new AdapterError('upstream_unavailable', 'Binance returned an error.', {
    detail: `HTTP ${status}: ${msg}`,
  })
}
