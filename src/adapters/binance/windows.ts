/**
 * Walking a date-windowed endpoint backwards, resumably.
 *
 * Binance's history endpoints are not id-paged like `myTrades`. Deposits, withdrawals and Convert
 * all take a `startTime`/`endTime` pair, all default to the last 90 days if you omit it, and all
 * refuse a span wider than their maximum - 90 days for the capital endpoints, 30 for Convert. So
 * "give me everything since 2017" is not a request that can be made; it is thirty-odd requests, and
 * at 18,000 UID weight a call for withdrawals it is thirty-odd requests that have to be paced.
 *
 * Two passes come out of that, and the order matters:
 *
 *   Forward, from the newest instant already covered up to now. This is what an incremental sync
 *   does, it is one window in practice, and it runs first because recent activity is the activity a
 *   user is waiting to see.
 *
 *   Backward, from the oldest instant already covered towards the exchange's own epoch, bounded to
 *   a fixed number of windows per sync. A first sync therefore does not spend the account's entire
 *   minute budget on a decade of withdrawal history before it will show anything; the backfill
 *   finishes over the next few syncs and the cursor remembers exactly where it got to.
 *
 * The covered interval is stored rather than a single watermark, because one number cannot express
 * "everything from March onwards, and nothing before it".
 */

/** One request's worth of time, inclusive at both ends, in epoch milliseconds. */
export interface HistoryWindow {
  readonly startMs: bigint
  readonly endMs: bigint
}

/**
 * The interval a stream has already fetched.
 *
 * Serialised into the sync cursor, so the fields are strings: an epoch in milliseconds is inside
 * `Number.MAX_SAFE_INTEGER` today but nothing else on this boundary is a number, and a cursor is
 * exactly the kind of value that gets round-tripped through JSON by something that does not care.
 */
export interface CoveredInterval {
  /** Oldest instant fetched, inclusive. */
  readonly floorMs: string
  /** Newest instant fetched, inclusive. */
  readonly highMs: string
  /** True once the backwards walk has reached the exchange's own beginning. */
  readonly done: boolean
}

export interface PlannedWindow {
  readonly window: HistoryWindow
  /** The interval to record *after* this window's pages have all been committed. */
  readonly covered: CoveredInterval
  /** 'forward' fills the gap since the last sync; 'backfill' extends history downwards. */
  readonly direction: 'forward' | 'backfill'
}

export interface PlanOptions {
  readonly covered: CoveredInterval | null
  readonly nowMs: bigint
  /** The endpoint's maximum span. 90 days for the capital endpoints, 30 for Convert. */
  readonly spanMs: bigint
  /** How far back history could possibly go. */
  readonly historyStartMs: bigint
  /** Backfill windows this sync may spend. The forward pass is never bounded. */
  readonly backfillWindows: number
  /**
   * How far back below the covered high the forward pass restarts.
   *
   * Not paranoia, and not an optimisation in the wrong direction. A deposit that was still
   * confirming when its window was read is skipped - correctly, because units that have not
   * arrived are not inventory - but its timestamp stays inside that window forever. Without an
   * overlap the forward pass resumes strictly above the window, and the deposit is never looked at
   * again once it settles: silently lost, and only visible later as a coverage gap.
   *
   * Re-reading costs one request and nothing else, because the natural key makes every row in the
   * overlap a duplicate.
   */
  readonly revisitMs?: bigint
}

/**
 * The interval a stream starts from when it has never run.
 *
 * `floor` sits one millisecond *after* `now` so that the instant `now` is not claimed as covered by
 * a request that was never made. The first backfill window then ends exactly at `now`.
 */
export function emptyInterval(nowMs: bigint): CoveredInterval {
  return { floorMs: `${nowMs + 1n}`, highMs: `${nowMs}`, done: false }
}

export function planWindows(options: PlanOptions): PlannedWindow[] {
  const { nowMs, spanMs, historyStartMs } = options
  const start = options.covered ?? emptyInterval(nowMs)
  let floor = BigInt(start.floorMs)
  let high = BigInt(start.highMs)
  let done = start.done
  const planned: PlannedWindow[] = []

  // Forward, and unbounded: the gap since the last sync is however long the app was closed, and
  // stopping halfway through it would leave a hole that the backwards walk never revisits.
  //
  // Guarded on `high < nowMs` rather than run unconditionally, so a first sync - where nothing is
  // covered and `high` is `now` - goes straight to the backfill instead of re-reading a window
  // it is about to read anyway.
  if (high < nowMs) {
    let startMs = high + 1n - (options.revisitMs ?? 0n)
    if (startMs < historyStartMs) startMs = historyStartMs
    while (startMs <= nowMs) {
      const endMs = min(startMs + spanMs - 1n, nowMs)
      high = endMs
      planned.push({
        window: { startMs, endMs },
        covered: { floorMs: `${floor}`, highMs: `${high}`, done },
        direction: 'forward',
      })
      startMs = endMs + 1n
    }
  }

  // Backward, and bounded.
  for (let spent = 0; !done && floor > historyStartMs && spent < options.backfillWindows; spent++) {
    const endMs = floor - 1n
    const startMs = max(historyStartMs, endMs - spanMs + 1n)
    floor = startMs
    done = startMs <= historyStartMs
    planned.push({
      window: { startMs, endMs },
      covered: { floorMs: `${floor}`, highMs: `${high}`, done },
      direction: 'backfill',
    })
  }

  return planned
}

/** True when history below `covered` is still unread, so the figures above it are partial. */
export function backfillIncomplete(covered: CoveredInterval, historyStartMs: bigint): boolean {
  return !covered.done && BigInt(covered.floorMs) > historyStartMs
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}
