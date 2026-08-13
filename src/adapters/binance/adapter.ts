/**
 * The Binance adapter.
 *
 * The better-behaved of the two exchanges by a wide margin: real key scoping, an endpoint that
 * reports it, string-typed numerics and a published weight budget. Two things still need care.
 *
 * Scope. `GET /sapi/v1/account/apiRestrictions` is the authoritative source and the only one.
 * `GET /api/v3/account`'s canTrade/canWithdraw/canDeposit describe the ACCOUNT, not the KEY - a
 * read-only key on a healthy account still reports `canWithdraw: true`. Reading those fields is
 * the single easiest way to build a scope check that silently does nothing, so this adapter reads
 * them for nothing but `permissions` and `uid`.
 *
 * Trade history. `myTrades` requires a symbol, and a startTime/endTime window may not span more
 * than 24 hours, so several years of history would be thousands of calls per symbol. Backfill is
 * therefore by `fromId` from 0, and the watermark is the last trade id per symbol. Which symbols
 * to ask about is the residual problem, and it is why Binance accounts are `snapshot`: an asset
 * bought and entirely sold in a pair we never guessed leaves no balance and no transfer record,
 * so its fills are invisible. That gap is surfaced, not absorbed.
 */

import { addDec, type Dec, dec } from '@domain/numeric'
import type {
  AcquiredPage,
  AdapterContext,
  EpochMs,
  ExchangeAdapter,
  MarketSpec,
  RawBalance,
  RawFill,
  ScopeReport,
  Tristate,
} from '../contract'
import { AdapterError } from '../errors'
import {
  decimal,
  decimalOrNull,
  field,
  isJsonArray,
  isJsonObject,
  parseLossless,
  requireArray,
  text,
  textOrNull,
  type Json,
} from '../lossless-json'
import type { RateLimiter } from '../ratelimit'
import { epochMsToIso, signingTimestamp, truncateToMs } from '../time'
import { describeDocument, queryString } from '../wire'
import { BINANCE_ALLOWLIST } from './allowlist'

const HOSTS = {
  primary: 'https://api.binance.com',
  // Public market data only. Keeps exchangeInfo's weight off the authenticated IP budget.
  public: 'https://data-api.binance.vision',
} as const

/** Binance's default is 5000 ms and its cap is 60000. Generous but inside the cap. */
const RECV_WINDOW = '10000'

const MAX_TRADES_PER_PAGE = 1000

/**
 * Quote assets worth pairing a discovered asset against.
 *
 * Brute-forcing all ~3,000 listed pairs at weight 20 is not acceptable; this list plus the
 * account's own assets brings a typical user to 50-200 candidate symbols.
 */
const PLAUSIBLE_QUOTES: readonly string[] = [
  'USDT',
  'USDC',
  'FDUSD',
  'BTC',
  'ETH',
  'BNB',
  'TUSD',
  'BUSD',
]

/** Fiat codes are plausible quotes when the account has actually held them. */
const FIAT = new Set(['INR', 'USD', 'EUR', 'GBP', 'AUD', 'TRY', 'BRL', 'JPY'])

export interface BinanceCursor {
  readonly v: 1
  /** Last seen trade id per symbol. Absent means never queried. */
  readonly symbols: Readonly<Record<string, string>>
  /** Symbols confirmed to hold no trades, re-checked only when the asset set changes. */
  readonly empty: readonly string[]
  /** The discovered asset set the `empty` list was computed against. */
  readonly assetsKey: string
}

export function parseCursor(cursor: string | null): BinanceCursor {
  if (cursor === null || cursor === '') {
    return { v: 1, symbols: {}, empty: [], assetsKey: '' }
  }
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    const record = parsed as Partial<BinanceCursor>
    return {
      v: 1,
      symbols: record.symbols ?? {},
      empty: record.empty ?? [],
      assetsKey: record.assetsKey ?? '',
    }
  } catch (cause) {
    // A cursor we cannot read must not silently become "start from the beginning" without a
    // trace: re-walking is safe thanks to natural_key, but the corruption itself is a bug.
    throw new AdapterError('malformed_response', 'The stored Binance sync cursor is unreadable.', {
      detail: cursor.slice(0, 200),
      cause,
    })
  }
}

export interface BinanceAdapterOptions {
  /** Given so the published weight budget from exchangeInfo can replace the default. */
  readonly limiter?: RateLimiter
  /**
   * Trades per `myTrades` call. 1000 is Binance's maximum and the only sensible production
   * value; tests lower it so paging is exercised without a thousand-row fixture.
   */
  readonly pageSize?: number
}

export function createBinanceAdapter(options: BinanceAdapterOptions = {}): ExchangeAdapter {
  return {
    id: 'binance',
    displayName: 'Binance',
    baseCurrency: 'USD',
    // Not 'ledger', and it is the symbol-enumeration gap above that decides it.
    capability: 'snapshot',
    hosts: HOSTS,
    requestAllowlist: BINANCE_ALLOWLIST,
    credentialFields: [
      { name: 'apiKey', label: 'API key', secret: true, help: 'From API Management on Binance.' },
      { name: 'apiSecret', label: 'API secret', secret: true },
    ],
    coverageGaps: [
      'Binance Convert trades never appear in trade history, so any asset acquired through ' +
        'Convert shows a balance with no matching fills.',
      'Earn, staking, savings and lending balances sit outside the spot account and are not ' +
        'included, so this figure may understate what you hold.',
      'Fills in a trading pair Misal did not enumerate are invisible: an asset bought and then ' +
        'entirely sold leaves no balance to discover it by.',
    ],

    async serverTime(ctx: AdapterContext): Promise<EpochMs> {
      const response = await ctx.http.send({
        method: 'GET',
        host: 'primary',
        path: '/api/v3/time',
        query: '',
        body: null,
        signing: 'none',
        weight: 1,
      })
      const body = parseLossless(response.text)
      return truncateToMs(text(body, 'serverTime', 'time'))
    },

    async describeScope(ctx: AdapterContext): Promise<ScopeReport> {
      const response = await signed(ctx, {
        method: 'GET',
        path: '/sapi/v1/account/apiRestrictions',
        params: [],
        weight: 1,
      })
      const body = parseLossless(response.text)
      if (!isJsonObject(body)) {
        throw new AdapterError('malformed_response', 'Binance did not report the key permissions.')
      }

      const flag = (name: string): Tristate => {
        const value = field(body, name)
        return typeof value === 'boolean' ? value : 'unknown'
      }

      const trading = [
        'enableSpotAndMarginTrading',
        'enableMargin',
        'enableFutures',
        'enableFixApiTrade',
        'enableVanillaOptions',
        'enablePortfolioMarginTrading',
      ].map(flag)

      return {
        verification: 'introspected',
        canRead: flag('enableReading'),
        canTrade: anyTrue(trading),
        // The one flag that can empty an account, read from the only endpoint that describes
        // the key rather than the account.
        canWithdraw: flag('enableWithdrawals'),
        canTransferInternally: anyTrue([
          flag('enableInternalTransfer'),
          flag('permitsUniversalTransfer'),
        ]),
        // Never inferred from ipRestrict. That an unrestricted key must be read-only holds for
        // HMAC keys only; a self-generated Ed25519 or RSA key can trade with no IP restriction.
        ipRestricted: flag('ipRestrict'),
        raw: asRecord(body),
      }
    },

    async markets(ctx: AdapterContext): Promise<readonly MarketSpec[]> {
      const response = await ctx.http.send({
        method: 'GET',
        host: 'public',
        path: '/api/v3/exchangeInfo',
        query: '',
        body: null,
        signing: 'none',
        weight: 20,
      })
      const body = parseLossless(response.text)

      // The published budget, read from the response rather than hardcoded at 6,000/min.
      const requestWeight = requireArray(field(body, 'rateLimits') ?? [], 'rateLimits').find(
        (entry) => textOrNull(entry, 'rateLimitType') === 'REQUEST_WEIGHT',
      )
      const limit = requestWeight === undefined ? null : decimalOrNull(requestWeight, 'limit')
      if (limit !== null && options.limiter !== undefined) {
        options.limiter.setBudgetPerMinute(countOf(limit))
      }

      const markets: MarketSpec[] = []
      for (const entry of requireArray(field(body, 'symbols'), 'exchangeInfo.symbols')) {
        if (textOrNull(entry, 'status') !== 'TRADING') continue
        markets.push({
          symbol: text(entry, 'symbol', 'symbol'),
          base: { code: text(entry, 'baseAsset', 'symbol') },
          quote: { code: text(entry, 'quoteAsset', 'symbol') },
          quantityPrecision: stepPrecision(entry),
        })
      }
      return markets
    },

    async fetchBalances(ctx: AdapterContext): Promise<AcquiredPage<RawBalance>> {
      const asOfDate = ctx.now().toISOString().slice(0, 10)
      const response = await signed(ctx, {
        method: 'POST',
        path: '/sapi/v3/asset/getUserAsset',
        params: [],
        weight: 5,
      })
      const rows = requireArray(parseLossless(response.text), 'getUserAsset')

      const records: RawBalance[] = rows.map((row) => ({
        asset: { code: text(row, 'asset', 'balance') },
        free: decimal(row, 'free', 'balance'),
        // Everything that is held but not spendable. Omitting freeze, withdrawing or ipoable
        // would understate the holding while looking complete.
        locked: addDec(
          decimal(row, 'locked', 'balance'),
          decimalOrNull(row, 'freeze') ?? dec('0'),
          decimalOrNull(row, 'withdrawing') ?? dec('0'),
          decimalOrNull(row, 'ipoable') ?? dec('0'),
        ),
      }))

      return {
        document: await describeDocument(
          {
            providerId: 'binance',
            accountId: ctx.accountId,
            endpoint: '/sapi/v3/asset/getUserAsset',
            params: {},
            // One balance document per account per day. Without asOfDate an unchanged balance
            // set would hash identically forever and could never record a second day.
            asOfDate,
          },
          `binance:getUserAsset ${asOfDate}`,
        ),
        records,
        nextCursor: null,
      }
    },

    fetchFills(
      ctx: AdapterContext,
      cursor: string | null,
      markets: readonly MarketSpec[],
    ): AsyncIterable<AcquiredPage<RawFill>> {
      return walkFills(ctx, cursor, markets, options.pageSize ?? MAX_TRADES_PER_PAGE)
    },
  }
}

// ---------------------------------------------------------------------------
// Trade history
// ---------------------------------------------------------------------------

async function* walkFills(
  ctx: AdapterContext,
  cursor: string | null,
  markets: readonly MarketSpec[],
  pageSize: number,
): AsyncIterable<AcquiredPage<RawFill>> {
  const stored = parseCursor(cursor)
  const assets = new Set(ctx.discoveredAssets)
  const assetsKey = [...assets].sort().join(',')

  // The empty list is only trustworthy for the asset set it was computed against: a newly
  // discovered asset can bring a symbol into scope that was never queried.
  const empty = new Set(stored.assetsKey === assetsKey ? stored.empty : [])
  const symbols: Record<string, string> = { ...stored.symbols }

  const candidates = markets
    .filter((market) => assets.has(market.base.code) && isPlausibleQuote(market.quote.code, assets))
    .map((market) => market.symbol)
    .sort()

  let state: BinanceCursor = { v: 1, symbols, empty: [...empty], assetsKey }

  // The sweep is the slow part of a first sync and the reason this adapter reports progress at
  // all: `myTrades` needs a symbol, there is no cross-symbol endpoint, and a hundred-odd calls at
  // weight 20 take minutes. Reported before the first call rather than after it, so the count
  // appears immediately rather than after the first symbol has finished.
  let swept = 0
  ctx.report({
    phase: 'fills',
    done: 0,
    total: candidates.length,
    detail: `Checking ${candidates.length} trading pairs for your trades`,
  })

  for (const symbol of candidates) {
    swept += 1
    ctx.report({ phase: 'fills', done: swept, total: candidates.length, detail: symbol })
    if (empty.has(symbol)) continue
    let lastId = symbols[symbol]

    for (;;) {
      const firstQuery = lastId === undefined
      const fromId = lastId === undefined ? '0' : `${BigInt(lastId) + 1n}`
      const params: [string, string][] = [
        ['symbol', symbol],
        ['fromId', fromId],
        ['limit', `${pageSize}`],
      ]
      const response = await signed(ctx, {
        method: 'GET',
        path: '/api/v3/myTrades',
        params,
        weight: 20,
      })
      const rows = requireArray(parseLossless(response.text), 'myTrades')
      const records = rows.map((row) => toFill(row))

      const last = records[records.length - 1]
      if (last !== undefined) {
        lastId = last.externalId
        symbols[symbol] = last.externalId
      } else if (firstQuery) {
        // One call from id 0 proves a symbol has no trades; remember it so the next sync skips it.
        empty.add(symbol)
      }
      state = { v: 1, symbols, empty: [...empty], assetsKey }

      if (records.length > 0) {
        yield {
          document: await describeDocument(
            {
              providerId: 'binance',
              accountId: ctx.accountId,
              endpoint: '/api/v3/myTrades',
              // The cursor is part of the envelope, so every page is a distinct document and a
              // re-fetched page is a no-op rather than a conflict.
              params: { symbol, fromId },
            },
            `binance:myTrades ${symbol} fromId=${fromId}`,
          ),
          records,
          nextCursor: JSON.stringify(state),
        }
      }

      if (records.length < pageSize) break
    }
  }

  // A final checkpoint so the empty-symbol bookkeeping survives even when no page had rows.
  // The runner treats a record-less page as cursor-only and writes no source document for it.
  yield { document: null, records: [], nextCursor: JSON.stringify(state) }
}

function toFill(row: Json): RawFill {
  const commission = decimalOrNull(row, 'commission')
  const commissionAsset = textOrNull(row, 'commissionAsset')
  const isBuyer = field(row, 'isBuyer')
  const quoteQty = decimalOrNull(row, 'quoteQty')

  return {
    externalId: text(row, 'id', 'trade'),
    symbol: text(row, 'symbol', 'trade'),
    side: isBuyer === true ? 'buy' : 'sell',
    quantity: decimal(row, 'qty', 'trade'),
    price: decimal(row, 'price', 'trade'),
    ...(quoteQty === null ? {} : { quoteQuantity: quoteQty }),
    ...(commission === null || commissionAsset === null
      ? {}
      : { fee: { amount: commission, asset: { code: commissionAsset } } }),
    occurredAt: epochMsToIso(text(row, 'time', 'trade')),
  }
}

function isPlausibleQuote(quote: string, assets: ReadonlySet<string>): boolean {
  if (PLAUSIBLE_QUOTES.includes(quote)) return true
  // A fiat the account has actually held. Not every fiat Binance lists.
  return assets.has(quote) && FIAT.has(quote)
}

// ---------------------------------------------------------------------------
// Signing and small parsers
// ---------------------------------------------------------------------------

interface SignedCall {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly params: readonly (readonly [string, string])[]
  readonly weight: number
}

/**
 * Issue a signed request, re-measuring the clock exactly once on a `-1021` rejection.
 *
 * One retry, then a typed `clock_skew` error naming the measured drift. Retrying indefinitely
 * against a broken clock burns rate budget and hides a real machine problem.
 */
async function signed(ctx: AdapterContext, call: SignedCall) {
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

function anyTrue(values: readonly Tristate[]): Tristate {
  if (values.some((v) => v === true)) return true
  // A single unknown poisons the answer. 'unknown' is not 'false', and rounding it to false is
  // exactly the false reassurance the scope report exists to avoid.
  if (values.some((v) => v === 'unknown')) return 'unknown'
  return false
}

function asRecord(body: Json): Readonly<Record<string, unknown>> {
  return isJsonObject(body) ? body : {}
}

/** Decimal places implied by a LOT_SIZE step, e.g. '0.00100000' -> 3. Clamped to [0, 18]. */
function stepPrecision(entry: Json): number {
  const filters = field(entry, 'filters')
  if (isJsonArray(filters)) {
    for (const filter of filters) {
      if (textOrNull(filter, 'filterType') !== 'LOT_SIZE') continue
      const step = textOrNull(filter, 'stepSize')
      if (step !== null) return precisionOfStep(step)
    }
  }
  // Binance also publishes baseAssetPrecision; it is a safe fallback when filters are absent.
  const declared = textOrNull(entry, 'baseAssetPrecision')
  return declared === null ? 8 : clampPrecision(countOf(dec(declared)))
}

export function precisionOfStep(step: string): number {
  const dot = step.indexOf('.')
  if (dot < 0) return 0
  const fraction = step.slice(dot + 1).replace(/0+$/, '')
  return clampPrecision(fraction.length)
}

function clampPrecision(value: number): number {
  if (value < 0) return 0
  return value > 18 ? 18 : value
}

/** A small non-negative count held as a Dec, for precisions and rate limits. */
function countOf(value: Dec): number {
  let n = 0
  for (const ch of value.split('.')[0] ?? '0') {
    n = n * 10 + '0123456789'.indexOf(ch)
    if (n > 1_000_000) return 1_000_000
  }
  return n
}
