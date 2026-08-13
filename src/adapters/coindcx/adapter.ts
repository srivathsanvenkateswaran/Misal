/**
 * The CoinDCX adapter.
 *
 * Workable, but every part of it needs defensive handling. The published documentation's response
 * samples disagree with real responses in several places; where they conflict, recorded responses
 * win. Four traps drive the code below.
 *
 * 1. Signing. The HMAC covers the serialised JSON body, and there is no canonicalisation - no key
 *    sorting, no whitespace normalisation. Serialise once, sign that string, transmit that string.
 *    Letting an HTTP client re-serialise the object for the wire produces different bytes and a
 *    permanent 401, and it is the failure that breaks most CoinDCX clients in the wild. Every
 *    request here is built as a string by `jsonBody` and handed to the transport untouched.
 *
 * 2. Inverted naming. CoinDCX defines *target currency* as the traded quantity and *base
 *    currency* as the price denomination - the opposite of the convention everywhere else. For
 *    BTCINR, target_currency_short_name is BTC. Mapping those by name would invert every
 *    position, silently.
 *
 * 3. Ambiguous 401. A bad key, a stale timestamp and a missing timestamp all return an identical
 *    `401 Invalid credentials`. Reporting that as "invalid credentials" would send users to
 *    regenerate a perfectly good key, so it is reported as `auth_or_skew` after one re-measured
 *    retry.
 *
 * 4. Numbers. markets_details returns JSON numbers in scientific notation and fill timestamps as
 *    fractional milliseconds, so nothing here goes through JSON.parse.
 *
 * **There is no `fetchTransfers` here, and its absence is the finding rather than an omission.**
 * CoinDCX's published API covers markets, balances, order placement and trade history, and nothing
 * else; no deposit or withdrawal history endpoint is documented, and none of the plausible paths
 * has a shape anyone has written down. Guessing at one would mean shipping a request whose method,
 * body and response shape were all invented - and on an exchange whose only key class can also
 * move funds, an invented request is precisely the thing the allowlist exists to make impossible.
 * The adapter therefore declares the gap in `coverageGaps` and leaves the method absent, which the
 * runner treats as "never asked" rather than as "asked, and there were none". Establishing the
 * real endpoints needs recorded traffic from a live account, which no test in this repository may
 * produce.
 */

import { addDec, isZeroDec, ZERO_DEC } from '@domain/numeric'
import type {
  AcquiredPage,
  AdapterContext,
  EpochMs,
  ExchangeAdapter,
  GuardedResponse,
  MarketSpec,
  RawBalance,
  RawFill,
  ScopeReport,
} from '../contract'
import { AdapterError, headerValue } from '../errors'
import {
  decimal,
  decimalOrNull,
  parseLossless,
  requireArray,
  text,
  textOrNull,
  type Json,
} from '../lossless-json'
import { epochMsToIso, httpDateToEpochMs, signingTimestamp, truncateToMs } from '../time'
import { type BodyValue, describeDocument, jsonBody } from '../wire'
import { COINDCX_ALLOWLIST } from './allowlist'

const HOSTS = {
  primary: 'https://api.coindcx.com',
  public: 'https://public.coindcx.com',
} as const

/** Documented to 5000; practitioners cap at 500 and so do we. */
const TRADES_PER_PAGE = 500

export interface CoindcxAdapterOptions {
  /** Fills per page. 500 in production; tests lower it to exercise paging. */
  readonly pageSize?: number
}

export function createCoindcxAdapter(options: CoindcxAdapterOptions = {}): ExchangeAdapter {
  return {
    id: 'coindcx',
    displayName: 'CoinDCX',
    baseCurrency: 'INR',
    capability: 'snapshot',
    hosts: HOSTS,
    requestAllowlist: COINDCX_ALLOWLIST,
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        help:
          'CoinDCX does not offer read-only API keys. Generate the key on this machine if you ' +
          'intend to bind it to an IP address.',
      },
      { name: 'apiSecret', label: 'API secret', secret: true },
    ],
    coverageGaps: [
      'CoinDCX exposes no deposit or withdrawal history to API keys, so transfers in and out of ' +
        'the exchange are not visible to Misal.',
      'CoinDCX reports no TDS or tax figures anywhere in its API, so Indian tax figures must ' +
        'come from its CSV export.',
    ],

    /**
     * CoinDCX has no server-time endpoint - every candidate path 404s - so the clock reference is
     * the HTTP `Date` header of a request we were going to make anyway. One-second granularity,
     * which is ample against a ten-second window.
     */
    async serverTime(ctx: AdapterContext): Promise<EpochMs> {
      const response = await ctx.http.send({
        method: 'GET',
        host: 'primary',
        path: '/exchange/v1/markets_details',
        query: '',
        body: null,
        signing: 'none',
        weight: 1,
      })
      const date = headerValue(response.headers, 'date')
      const epoch = date === undefined ? null : httpDateToEpochMs(date)
      if (epoch === null) {
        throw new AdapterError(
          'malformed_response',
          'CoinDCX did not return a usable server clock.',
          { detail: `Date header: ${JSON.stringify(date ?? null)}` },
        )
      }
      return truncateToMs(epoch)
    },

    /**
     * There is no scope to report and there cannot be: a key that authenticates is a full-access
     * key.
     *
     * `canWithdraw` is `'unknown'`, not `false`. The earlier `false` was defensible in prose - it
     * meant "CoinDCX exposes no crypto-withdrawal endpoint we can call" - but prose does not
     * travel with the value. This report is persisted into `credential_ref.scope_flags`, and a
     * consumer reading a stored `false` reads it as "this key cannot withdraw", which is the
     * single most dangerous thing Misal could assert about a CoinDCX key: it is exactly backwards
     * from the risk the connect dialog is warning about.
     *
     * `Tristate` already carries `'unknown'`, and unknown is the truth. A stored value must be
     * defensible on its own, without the comment that produced it.
     */
    describeScope(): Promise<ScopeReport> {
      return Promise.resolve({
        verification: 'unscopable',
        canRead: true,
        canTrade: true,
        canWithdraw: 'unknown',
        canTransferInternally: 'unknown',
        ipRestricted: 'unknown',
        raw: {
          note:
            'CoinDCX does not offer read-only API keys and has no endpoint that reports a key’s ' +
            'permissions. This key can place trades. Misal will never do so - it cannot ' +
            'construct a trade request - but anyone who obtains this key can.',
        },
      })
    },

    async markets(ctx: AdapterContext): Promise<readonly MarketSpec[]> {
      const response = await ctx.http.send({
        method: 'GET',
        host: 'primary',
        path: '/exchange/v1/markets_details',
        query: '',
        body: null,
        signing: 'none',
        weight: 1,
      })
      const rows = requireArray(parseLossless(response.text), 'markets_details')

      return rows.map((row) => ({
        // `symbol` is what trade_history.symbol joins against. `pair` (I-BTC_INR) is for the
        // websocket and futures surfaces, which v1 does not use.
        symbol: text(row, 'symbol', 'market'),
        // Inverted on purpose: CoinDCX's target is the traded asset.
        base: { code: text(row, 'target_currency_short_name', 'market') },
        quote: { code: text(row, 'base_currency_short_name', 'market') },
        quantityPrecision: precisionOf(row),
      }))
    },

    async fetchBalances(ctx: AdapterContext): Promise<AcquiredPage<RawBalance>> {
      const asOfDate = ctx.now().toISOString().slice(0, 10)
      const response = await signedPost(ctx, '/exchange/v1/users/balances', [])
      const rows = requireArray(parseLossless(response.text), 'balances')

      const records: RawBalance[] = rows
        .map((row) => ({
          asset: { code: text(row, 'currency', 'balance') },
          // `balance` is only the usable portion. Treating it as the total understates any asset
          // with an open order against it, so the locked part is carried separately and added.
          free: decimal(row, 'balance', 'balance'),
          locked: decimalOrNull(row, 'locked_balance') ?? ZERO_DEC,
        }))
        // Whether zero-balance currencies are returned is undocumented, so filter client-side.
        .filter((row) => !isZeroDec(addDec(row.free, row.locked)))

      return {
        document: await describeDocument(
          {
            providerId: 'coindcx',
            accountId: ctx.accountId,
            endpoint: '/exchange/v1/users/balances',
            params: {},
            asOfDate,
          },
          `coindcx:balances ${asOfDate}`,
        ),
        records,
        nextCursor: null,
      }
    },

    fetchFills(ctx: AdapterContext, cursor: string | null): AsyncIterable<AcquiredPage<RawFill>> {
      return walkFills(ctx, cursor, options.pageSize ?? TRADES_PER_PAGE)
    },
  }
}

/**
 * Backfill by `from_id`, ascending.
 *
 * `symbol` is optional and omitting it returns fills across all symbols, so CoinDCX has no symbol
 * enumeration problem at all - the watermark is one integer. `from_id` is exclusive ("the trade id
 * after which you want the data") and only coheres with `sort: 'asc'`.
 */
async function* walkFills(
  ctx: AdapterContext,
  cursor: string | null,
  pageSize: number,
): AsyncIterable<AcquiredPage<RawFill>> {
  let fromId = cursor === null || cursor === '' ? null : cursor
  let pages = 0

  for (;;) {
    const requestedFrom = fromId
    pages += 1
    // No total: the walk ends on a short page and there is no count to ask for beforehand.
    ctx.report({
      phase: 'fills',
      done: pages,
      total: null,
      detail: `Trade history page ${pages}`,
    })
    const params: [string, BodyValue][] = [
      ['limit', { int: `${pageSize}` }],
      ['sort', { text: 'asc' }],
    ]
    if (requestedFrom !== null) params.push(['from_id', { int: requestedFrom }])

    const response = await signedPost(ctx, '/exchange/v1/orders/trade_history', params)
    const rows = requireArray(parseLossless(response.text), 'trade_history')
    const records = rows.map((row) => toFill(row))

    const last = records[records.length - 1]
    if (last !== undefined) fromId = last.externalId

    if (records.length > 0) {
      yield {
        document: await describeDocument(
          {
            providerId: 'coindcx',
            accountId: ctx.accountId,
            endpoint: '/exchange/v1/orders/trade_history',
            // The cursor identifies the page. The signed body deliberately does NOT go into the
            // envelope: it carries a timestamp that changes on every call, so hashing it would
            // make every re-fetch a new document and idempotency would never trigger.
            params: { from_id: requestedFrom ?? '0', limit: `${pageSize}` },
          },
          `coindcx:trade_history from_id=${requestedFrom ?? '0'}`,
        ),
        records,
        nextCursor: fromId,
      }
    }

    if (records.length < pageSize) return
  }
}

function toFill(row: Json): RawFill {
  const feeAmount = decimalOrNull(row, 'fee_amount')
  // CoinDCX does not always name the fee asset. Where it does not, the fee is deducted in the
  // market's quote currency; the runner resolves it against the market catalogue.
  const feeAsset = textOrNull(row, 'fee_currency') ?? textOrNull(row, 'fee_currency_short_name')
  const side = textOrNull(row, 'side')

  return {
    externalId: text(row, 'id', 'fill'),
    symbol: text(row, 'symbol', 'fill'),
    side: side === 'sell' ? 'sell' : 'buy',
    quantity: decimal(row, 'quantity', 'fill'),
    price: decimal(row, 'price', 'fill'),
    ...(feeAmount === null
      ? {}
      : { fee: { amount: feeAmount, asset: { code: feeAsset ?? QUOTE_ASSET_SENTINEL } } }),
    // Fractional milliseconds, truncated as a string. Rounding would shift the natural key by a
    // millisecond and defeat deduplication against the same trade from a CSV.
    occurredAt: epochMsToIso(truncateToMs(text(row, 'timestamp', 'fill'))),
  }
}

/**
 * Stands in for "the fee was charged in this market's quote currency".
 *
 * CoinDCX omits the fee currency from `trade_history`. Guessing a concrete code here would be a
 * guess recorded as fact; this sentinel makes the substitution explicit and the runner replaces
 * it from the market catalogue, where the quote asset is known.
 */
export const QUOTE_ASSET_SENTINEL = '@quote'

async function signedPost(
  ctx: AdapterContext,
  path: string,
  params: readonly (readonly [string, BodyValue])[],
): Promise<GuardedResponse> {
  let lastStatus = 401
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Serialised exactly once. This string is signed and transmitted; nothing re-encodes it.
    const body = jsonBody([
      ...params,
      ['timestamp', { int: signingTimestamp(ctx.now(), ctx.clock.offsetMs) }],
    ])

    const response = await ctx.http.send({
      method: 'POST',
      host: 'primary',
      path,
      query: '',
      body,
      signing: 'coindcx-body',
      weight: 1,
    })
    if (response.status < 400) return response
    lastStatus = response.status
    lastText = response.text

    if (response.status === 401 && attempt === 0) {
      // Could be the key, could be the clock. Re-measure before deciding it is the key.
      await ctx.clock.resync()
      continue
    }
    throw coindcxError(response.status, response.text)
  }
  throw coindcxError(lastStatus, lastText)
}

export function coindcxError(status: number, body: string): AdapterError {
  const detail = body.slice(0, 200)
  if (status === 401) {
    return new AdapterError(
      'auth_or_skew',
      'CoinDCX rejected the request. It returns the same error for an invalid key and for a ' +
        'timestamp outside its ten-second window, so this is either the API key or your ' +
        'computer’s clock. Misal already re-checked the clock once.',
      { detail },
    )
  }
  if (status === 404) {
    // A wrong method is indistinguishable from a wrong path on CoinDCX: users/balances answers
    // 404 to a GET, and the futures wallet answers 404 to a POST.
    return new AdapterError('malformed_response', 'CoinDCX does not recognise that request.', {
      detail: `HTTP 404: ${detail}`,
    })
  }
  return new AdapterError('upstream_unavailable', 'CoinDCX returned an error.', {
    detail: `HTTP ${status}: ${detail}`,
  })
}

/** markets_details publishes several precision fields; the traded one is the target's. */
function precisionOf(row: Json): number {
  const declared = textOrNull(row, 'target_currency_precision')
  if (declared !== null && /^\d+$/.test(declared)) {
    const value = smallCount(declared)
    return value > 18 ? 18 : value
  }
  // `step` arrives as a JSON number in scientific notation (1e-05), so it is normalised through
  // the lossless decimal reader before its decimal places are counted.
  const step = decimalOrNull(row, 'step')
  if (step !== null) {
    const fraction = (step.split('.')[1] ?? '').replace(/0+$/, '')
    return fraction.length > 18 ? 18 : fraction.length
  }
  return 8
}

function smallCount(digits: string): number {
  let value = 0
  for (const ch of digits) {
    value = value * 10 + '0123456789'.indexOf(ch)
    if (value > 1000) return 1000
  }
  return value
}
