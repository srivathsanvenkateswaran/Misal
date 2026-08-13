/**
 * Binance's date-windowed histories: deposits, withdrawals and Convert.
 *
 * These are the three streams `myTrades` cannot see, and each one is invisible in a different way.
 *
 *   A deposit is how an asset gets onto the exchange without ever being bought there. Until it is
 *   fetched, a coin sent in from a hardware wallet and never traded has no balance explanation at
 *   all - and worse, it never enters the discovered-asset set, so the symbol sweep never even asks
 *   whether it was traded.
 *
 *   A withdrawal is units leaving. Without it the fold sits permanently above the reported balance
 *   by exactly the amount withdrawn, and the coverage check reports a gap it cannot explain.
 *
 *   A Convert fill appears in no trade history whatsoever. `/sapi/v1/convert/tradeFlow` is the only
 *   endpoint that has ever carried it.
 *
 * None of the three is free. Deposits are IP weight 1; withdrawals are **UID weight 18,000** and
 * Convert **UID weight 3,000**, against a 180,000-a-minute account budget - so five withdrawal
 * windows and thirty Convert windows are all a minute holds at the limiter's half-budget target.
 * The pacing is the limiter's job; the walk's job is to make every window resumable, so that being
 * paced is merely slow rather than fragile.
 */

import type { AcquiredPage, AdapterContext, RawConversion, RawTransfer } from '../contract'
import { AdapterError } from '../errors'
import {
  decimal,
  decimalOrNull,
  field,
  isRawNumber,
  parseLossless,
  requireArray,
  text,
  textOrNull,
  type Json,
} from '../lossless-json'
import { binanceCivilTimeToIso, epochMsToIso, truncateToMs } from '../time'
import { describeDocument } from '../wire'
import { signed } from './signing'
import {
  backfillIncomplete,
  emptyInterval,
  planWindows,
  type CoveredInterval,
} from './windows'

const DAY_MS = 86_400_000n

/** The capital endpoints refuse a span wider than 90 days, and default to it when asked for none. */
export const TRANSFER_SPAN_MS = 90n * DAY_MS
/** Convert's maximum is 30, and both bounds are mandatory rather than defaulted. */
export const CONVERT_SPAN_MS = 30n * DAY_MS

/**
 * How far back a backfill walks.
 *
 * Binance opened in July 2017, so nothing predates it; there is no account-level "first activity"
 * field to read instead, and asking for a window that is simply empty costs the same as one that
 * is not.
 */
export const HISTORY_START_MS = BigInt(Date.UTC(2017, 6, 1))

/** Rows per page. 1000 is the documented maximum for both capital endpoints and for Convert. */
const MAX_ROWS_PER_PAGE = 1000

/**
 * How far below the last sync the forward pass restarts.
 *
 * A deposit still confirming when its window was read is not committed - units that have not
 * arrived are not inventory - but its timestamp stays in that window forever, so without an
 * overlap it is never looked at again once it settles. Seven days covers chain confirmations and
 * Binance's own manual review holds; anything held longer than that is the residual gap, and it is
 * recorded in docs/known-issues.md rather than papered over with a bigger number.
 *
 * The overlap costs one extra request per stream per sync and nothing else, because every row in
 * it deduplicates on the natural key.
 */
const REVISIT_MS = 7n * DAY_MS

/**
 * Backfill windows one sync may spend, per stream.
 *
 * A uniform number would be the arbitrary choice here, not this table: the three endpoints differ
 * in price by four orders of magnitude, so the same window count means twelve units of budget on
 * one of them and 216,000 on another.
 *
 * The figures are chosen so that a whole sync's backfill fits inside one minute of Binance's
 * account budget - 180,000 UID weight, of which the limiter targets half:
 *
 *     withdrawals  2 x 18,000 = 36,000
 *     Convert      8 x  3,000 = 24,000
 *     deposits    12 x      0 =      0   (IP weight 1 each, off this budget entirely)
 *                             -------
 *                               60,000, leaving room for the forward windows and a retry
 *
 * A sync therefore never sits waiting for the budget to refill, which matters because the thing
 * waiting is a user watching a progress bar. The price is that a decade of Convert history arrives
 * over a couple of dozen syncs rather than one; the cursor makes each of those a resumption, and
 * `reportIncomplete` says out loud how far back the figures currently go.
 */
export const BACKFILL_WINDOWS = {
  deposits: 12,
  withdrawals: 2,
  conversions: 8,
} as const

export interface HistoryOptions {
  /** Overrides every stream's window count. Tests set it to 1; production leaves it alone. */
  readonly backfillWindows?: number
  /** Rows per page. Tests lower it to exercise paging without a thousand-row fixture. */
  readonly pageSize?: number
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Deposits and withdrawals are two endpoints on one stream, so one cursor carries both intervals.
 *
 * They cannot share one: deposits cost weight 1 and can be walked to 2017 in a single sync, while
 * withdrawals cost 18,000 and cannot, so the two walks reach different depths and the cursor has to
 * be able to say so.
 */
export interface BinanceTransferCursor {
  readonly v: 1
  readonly deposits: CoveredInterval
  readonly withdrawals: CoveredInterval
}

export interface BinanceConversionCursor {
  readonly v: 1
  readonly conversions: CoveredInterval
}

function parseInterval(value: unknown, nowMs: bigint): CoveredInterval {
  if (typeof value !== 'object' || value === null) return emptyInterval(nowMs)
  const record = value as Partial<CoveredInterval>
  if (typeof record.floorMs !== 'string' || typeof record.highMs !== 'string') {
    return emptyInterval(nowMs)
  }
  return { floorMs: record.floorMs, highMs: record.highMs, done: record.done === true }
}

/**
 * A cursor we cannot read must not silently become "start from the beginning" without a trace.
 * Re-walking is safe thanks to the natural key, but the corruption itself is a bug.
 */
function parseCursorObject(cursor: string | null, what: string): Record<string, unknown> {
  if (cursor === null || cursor === '') return {}
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (cause) {
    throw new AdapterError('malformed_response', `The stored Binance ${what} cursor is unreadable.`, {
      detail: cursor.slice(0, 200),
      cause,
    })
  }
}

export function parseTransferCursor(cursor: string | null, nowMs: bigint): BinanceTransferCursor {
  const raw = parseCursorObject(cursor, 'transfer')
  return {
    v: 1,
    deposits: parseInterval(raw.deposits, nowMs),
    withdrawals: parseInterval(raw.withdrawals, nowMs),
  }
}

export function parseConversionCursor(
  cursor: string | null,
  nowMs: bigint,
): BinanceConversionCursor {
  const raw = parseCursorObject(cursor, 'Convert')
  return { v: 1, conversions: parseInterval(raw.conversions, nowMs) }
}

// ---------------------------------------------------------------------------
// Deposits and withdrawals
// ---------------------------------------------------------------------------

/**
 * Deposit and withdrawal status codes, which do not agree with each other.
 *
 * A failed withdrawal never left the account and a pending deposit has not arrived, so neither may
 * become a transaction; both are still carried out of the adapter, because "there is a withdrawal
 * we are not counting" is a thing the import report can say and "nothing here" is not.
 */
function depositStatus(code: string | null): RawTransfer['status'] {
  switch (code) {
    case '1':
      return 'completed'
    // 6 is 'credited but cannot withdraw' - the units are in the account, so it has landed.
    case '6':
      return 'completed'
    case '7':
    case '11':
      return 'failed'
    // A status we cannot read is not a settled deposit. 'pending' withholds the units, which is
    // the safe direction: counting inventory the exchange has not confirmed is the unsafe one.
    case null:
    default:
      return 'pending'
  }
}

function withdrawalStatus(code: string | null): RawTransfer['status'] {
  switch (code) {
    case '6':
      return 'completed'
    case '1':
    case '3':
    case '5':
      return 'failed'
    case null:
    default:
      return 'pending'
  }
}

function intText(row: Json, key: string): string | null {
  const value = field(row, key)
  if (isRawNumber(value)) return value.raw
  return typeof value === 'string' ? value : null
}

function toDeposit(row: Json): RawTransfer {
  const asset = { code: text(row, 'coin', 'deposit') }
  return {
    // `id` is Binance's own row id; `txId` is the chain's. The row id is the stable one - a chain
    // transaction crediting two coins produces two rows sharing one txId.
    externalId: textOrNull(row, 'id') ?? intText(row, 'id') ?? text(row, 'txId', 'deposit'),
    asset,
    direction: 'in',
    quantity: decimal(row, 'amount', 'deposit'),
    occurredAt: epochMsToIso(text(row, 'insertTime', 'deposit')),
    status: depositStatus(intText(row, 'status')),
  }
}

function toWithdrawal(row: Json): RawTransfer {
  const asset = { code: text(row, 'coin', 'withdrawal') }
  // Charged on top of the amount, in the same asset. Netting it into the quantity would understate
  // what was withdrawn; dropping it would leave the fold above the balance by exactly the fee.
  const fee = decimalOrNull(row, 'transactionFee')
  const applied = textOrNull(row, 'completeTime') ?? text(row, 'applyTime', 'withdrawal')
  return {
    externalId: text(row, 'id', 'withdrawal'),
    asset,
    direction: 'out',
    quantity: decimal(row, 'amount', 'withdrawal'),
    ...(fee === null ? {} : { fee: { amount: fee, asset } }),
    occurredAt: binanceCivilTimeToIso(applied),
    status: withdrawalStatus(intText(row, 'status')),
  }
}

interface CapitalEndpoint {
  readonly path: string
  readonly weight: number
  readonly uidWeight: number
  readonly label: string
  readonly parse: (row: Json) => RawTransfer
}

const DEPOSITS: CapitalEndpoint = {
  path: '/sapi/v1/capital/deposit/hisrec',
  weight: 1,
  uidWeight: 0,
  label: 'deposits',
  parse: toDeposit,
}

const WITHDRAWALS: CapitalEndpoint = {
  path: '/sapi/v1/capital/withdraw/history',
  // The expensive one, and the reason a backfill is bounded per sync: 18,000 of a 180,000-a-minute
  // account budget buys five of these a minute at the limiter's half-budget target.
  weight: 1,
  uidWeight: 18_000,
  label: 'withdrawals',
  parse: toWithdrawal,
}

export async function* walkTransfers(
  ctx: AdapterContext,
  cursor: string | null,
  options: HistoryOptions,
): AsyncIterable<AcquiredPage<RawTransfer>> {
  const nowMs = BigInt(ctx.now().getTime())
  const pageSize = options.pageSize ?? MAX_ROWS_PER_PAGE
  const backfillWindows = options.backfillWindows
  const stored = parseTransferCursor(cursor, nowMs)

  const deposits = planWindows({
    covered: stored.deposits,
    nowMs,
    spanMs: TRANSFER_SPAN_MS,
    historyStartMs: HISTORY_START_MS,
    backfillWindows: backfillWindows ?? BACKFILL_WINDOWS.deposits,
    revisitMs: REVISIT_MS,
  })
  const withdrawals = planWindows({
    covered: stored.withdrawals,
    nowMs,
    spanMs: TRANSFER_SPAN_MS,
    historyStartMs: HISTORY_START_MS,
    backfillWindows: backfillWindows ?? BACKFILL_WINDOWS.withdrawals,
    revisitMs: REVISIT_MS,
  })

  const total = deposits.length + withdrawals.length
  let done = 0
  let state: BinanceTransferCursor = stored
  ctx.report({
    phase: 'fills',
    done,
    total,
    detail: `Reading ${total} windows of deposit and withdrawal history`,
  })

  for (const [endpoint, plan, key] of [
    [DEPOSITS, deposits, 'deposits'],
    [WITHDRAWALS, withdrawals, 'withdrawals'],
  ] as const) {
    for (const step of plan) {
      for (let offset = 0; ; offset += pageSize) {
        const params: [string, string][] = [
          ['startTime', `${step.window.startMs}`],
          ['endTime', `${step.window.endMs}`],
          ['offset', `${offset}`],
          ['limit', `${pageSize}`],
        ]
        const response = await signed(ctx, {
          method: 'GET',
          path: endpoint.path,
          params,
          weight: endpoint.weight,
          uidWeight: endpoint.uidWeight,
        })
        const rows = requireArray(parseLossless(response.text), endpoint.label)
        const records = rows.map((row) => endpoint.parse(row))

        // Every page inside a window carries the cursor as it stood *before* the window, not
        // after it. `offset` is not a watermark: a sync that commits page one of three and then
        // dies must come back and re-read the whole window, and a cursor that had already claimed
        // the window would lose pages two and three permanently. Re-reading page one costs
        // nothing, because the natural key makes it a duplicate.
        if (records.length > 0) {
          yield {
            document: await describeDocument(
              {
                providerId: 'binance',
                accountId: ctx.accountId,
                endpoint: endpoint.path,
                params: {
                  startTime: `${step.window.startMs}`,
                  endTime: `${step.window.endMs}`,
                  offset: `${offset}`,
                },
              },
              `binance:${endpoint.label} ${isoDay(step.window.startMs)}..${isoDay(step.window.endMs)} offset=${offset}`,
              { start: epochMsToIso(`${step.window.startMs}`), end: epochMsToIso(`${step.window.endMs}`) },
            ),
            records,
            nextCursor: JSON.stringify(state),
          }
        }
        if (records.length < pageSize) break
      }

      state =
        key === 'deposits'
          ? { ...state, deposits: step.covered }
          : { ...state, withdrawals: step.covered }
      done += 1
      ctx.report({
        phase: 'fills',
        done,
        total,
        detail: `${endpoint.label} ${isoDay(step.window.startMs)} to ${isoDay(step.window.endMs)}`,
      })
      // A checkpoint per window, so a bounded backfill resumes exactly where it stopped even when
      // every window it walked was empty.
      yield { document: null, records: [], nextCursor: JSON.stringify(state) }
    }
  }

  reportIncomplete(ctx, 'transfers', [
    ['Deposit', state.deposits],
    ['Withdrawal', state.withdrawals],
  ])
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

function toConversion(row: Json): RawConversion {
  return {
    externalId: text(row, 'orderId', 'conversion'),
    from: { code: text(row, 'fromAsset', 'conversion') },
    fromQuantity: decimal(row, 'fromAmount', 'conversion'),
    to: { code: text(row, 'toAsset', 'conversion') },
    toQuantity: decimal(row, 'toAmount', 'conversion'),
    // `inverseRatio` is quote per base, which is what a price is. Dividing fromAmount by toAmount
    // ourselves would introduce a rounding decision the exchange has already made.
    price: decimal(row, 'inverseRatio', 'conversion'),
    occurredAt: epochMsToIso(text(row, 'createTime', 'conversion')),
  }
}

export async function* walkConversions(
  ctx: AdapterContext,
  cursor: string | null,
  options: HistoryOptions,
): AsyncIterable<AcquiredPage<RawConversion>> {
  const nowMs = BigInt(ctx.now().getTime())
  const pageSize = options.pageSize ?? MAX_ROWS_PER_PAGE
  const stored = parseConversionCursor(cursor, nowMs)

  const plan = planWindows({
    covered: stored.conversions,
    nowMs,
    spanMs: CONVERT_SPAN_MS,
    historyStartMs: HISTORY_START_MS,
    backfillWindows: options.backfillWindows ?? BACKFILL_WINDOWS.conversions,
    revisitMs: REVISIT_MS,
  })

  let done = 0
  let state = stored
  ctx.report({
    phase: 'fills',
    done,
    total: plan.length,
    detail: `Reading ${plan.length} windows of Convert history`,
  })

  for (const step of plan) {
    // Convert has no `offset`. It answers `moreData: true` and expects the window to be narrowed,
    // so an over-full window is walked by pulling its upper bound down to just before the oldest
    // row already seen. Repeating the same endTime would return the same rows forever.
    let endMs = step.window.endMs
    for (;;) {
      const response = await signed(ctx, {
        method: 'GET',
        path: '/sapi/v1/convert/tradeFlow',
        params: [
          // Both bounds are mandatory here, unlike the capital endpoints.
          ['startTime', `${step.window.startMs}`],
          ['endTime', `${endMs}`],
          ['limit', `${pageSize}`],
        ],
        weight: 1,
        uidWeight: 3_000,
      })
      const body = parseLossless(response.text)
      const rows = requireArray(field(body, 'list') ?? [], 'convert.tradeFlow.list')
      const records = rows.map((row) => toConversion(row))

      if (records.length > 0) {
        yield {
          document: await describeDocument(
            {
              providerId: 'binance',
              accountId: ctx.accountId,
              endpoint: '/sapi/v1/convert/tradeFlow',
              params: { startTime: `${step.window.startMs}`, endTime: `${endMs}` },
            },
            `binance:convert ${isoDay(step.window.startMs)}..${isoDay(endMs)}`,
            {
              start: epochMsToIso(`${step.window.startMs}`),
              end: epochMsToIso(`${endMs}`),
            },
          ),
          records,
          // The window's own state, not the state after it. Narrowing `endTime` walks *down*
          // through a window, so a crash mid-window has to re-read the window from its top; a
          // cursor that had already claimed it would drop every row below the crash.
          nextCursor: JSON.stringify(state),
        }
      }

      if (field(body, 'moreData') !== true || rows.length === 0) break
      // From the raw epoch rather than the formatted instant: the response's own integer is the
      // value the next request has to name, and re-parsing an ISO string to get back to it would
      // put a `Date` in the middle of a bound the exchange compares exactly.
      const oldest = rows
        .map((row) => BigInt(truncateToMs(text(row, 'createTime', 'conversion'))))
        .reduce((a, b) => (a < b ? a : b))
      const narrowed = oldest - 1n
      // Defensive: a server that says `moreData` while returning rows at the window's floor would
      // otherwise loop forever on the same request.
      if (narrowed <= step.window.startMs || narrowed >= endMs) break
      endMs = narrowed
    }

    state = { ...state, conversions: step.covered }
    done += 1
    ctx.report({
      phase: 'fills',
      done,
      total: plan.length,
      detail: `Convert ${isoDay(step.window.startMs)} to ${isoDay(step.window.endMs)}`,
    })
    yield { document: null, records: [], nextCursor: JSON.stringify(state) }
  }

  reportIncomplete(ctx, 'conversions', [['Convert', state.conversions]])
}

// ---------------------------------------------------------------------------
// Saying what is still missing
// ---------------------------------------------------------------------------

/**
 * State plainly that history below a date has not been read yet.
 *
 * A bounded backfill is honest only if it says so. Without this the first sync of an old account
 * shows a cost basis built from three years of history and nothing distinguishes it from one built
 * from all of it.
 */
function reportIncomplete(
  ctx: AdapterContext,
  stream: string,
  streams: readonly (readonly [string, CoveredInterval])[],
): void {
  for (const [label, covered] of streams) {
    if (!backfillIncomplete(covered, HISTORY_START_MS)) continue
    ctx.log({
      severity: 'warning',
      code: 'backfill_incomplete',
      message:
        `${label} history has been read back to ${isoDay(BigInt(covered.floorMs))} so far. ` +
        'Binance meters these endpoints per account rather than per request, so the rest is ' +
        'fetched over the next few syncs.',
      rowRef: stream,
    })
  }
}

function isoDay(ms: bigint): string {
  return epochMsToIso(`${ms}`).slice(0, 10)
}
