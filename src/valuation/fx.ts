/**
 * FX. INR is the base currency, always, and is not configurable in v1.
 *
 * The `fx_rate` table has no documented direction convention, so this subsystem fixes one:
 * **`base` is the foreign currency, `quote` is INR, and `rate` is the number of INR per one unit of
 * `base`.** The inverse convention is equally common in the wild, and a silent inversion turns a
 * ₹50 lakh US holding into ₹6,500 — so a row whose quote is not INR is rejected rather than
 * inverted on a guess.
 *
 * Two rules, and the whole of FX correctness follows from them:
 *
 *  1. Present value uses the current rate. Nothing historical enters it.
 *  2. XIRR uses the rate stored on each transaction (see `xirr.ts`).
 *
 * Rule 1 needs a definition of *current*, and this module supplies one rather than assuming the
 * newest row it happens to hold is today's. Both reads are therefore bounded against a date the
 * caller supplies: `on` by `MAX_FX_BACKFILL_DAYS`, `latest` by `MAX_FX_LATEST_AGE_DAYS`. An
 * unbounded `latest` is the quietest failure this subsystem can have — prices keep refreshing daily
 * while the FX leg is pinned to whenever the provider last answered, so net worth moves every day
 * and looks entirely healthy while one of its two factors is frozen. Beyond the bound the read
 * fails, the holding leaves net worth, and the engine says so; it is never converted at the last
 * rate that happened to arrive.
 */

import { type CurrencyCode, type Dec, dec } from '@domain/numeric'
import { daysBetween } from './calendar'
import type { IsoDate } from './types'

export interface FxRateRow {
  readonly base: string
  readonly quote: string
  readonly asOf: IsoDate
  readonly rate: Dec
  readonly source: string
}

export interface FxPoint {
  readonly rate: Dec
  readonly asOf: IsoDate
  readonly source: string
}

export type FxError =
  | { readonly code: 'NO_FX_RATE'; readonly pair: string; readonly date: IsoDate }
  | { readonly code: 'NO_FX_SOURCE'; readonly pair: string }
  | { readonly code: 'FX_DIRECTION_INVALID'; readonly base: string; readonly quote: string }
  /** A rate exists but is too old to be called the current one. `asOf` is the rate's own date. */
  | {
      readonly code: 'FX_RATE_STALE'
      readonly pair: string
      readonly asOf: IsoDate
      readonly ageDays: number
    }

export type FxResult = { readonly ok: true; readonly value: FxPoint } | { readonly ok: false; readonly error: FxError }

export interface FxService {
  /** `asOf` is the valuation date: the day `latest` is being asked to be current as of. */
  latest(from: CurrencyCode, to: 'INR', asOf: IsoDate): FxResult
  on(from: CurrencyCode, to: 'INR', date: IsoDate): FxResult
}

/** Weekends and holidays only. Interpolating FX across a longer gap is invention. */
export const MAX_FX_BACKFILL_DAYS = 3

/**
 * How old the newest stored rate may be and still be presented as the current one.
 *
 * Longer than `MAX_FX_BACKFILL_DAYS` because it answers a different question. `on` asks for a
 * particular past day and a weekend is the whole of its slack; `latest` asks for today, and a
 * refresh is a thing the user does rather than a thing that happens, so a week absorbs a run of
 * weekends and public holidays in either market plus a few days of not opening the app. Past a
 * week, "the current rate" is a claim the stored data does not support — usually because a
 * provider has been failing, or because the base currency was moved off INR and the rate feed
 * silently stopped.
 */
export const MAX_FX_LATEST_AGE_DAYS = 7

const IDENTITY: FxPoint = { rate: dec('1'), asOf: '0001-01-01', source: 'identity' }

export class FxTable implements FxService {
  private readonly byBase = new Map<string, FxRateRow[]>()
  private readonly rejected: FxRateRow[] = []

  constructor(rows: readonly FxRateRow[]) {
    for (const row of rows) {
      if (row.quote !== 'INR') {
        // Rejected, not inverted. See the module comment.
        this.rejected.push(row)
        continue
      }
      const bucket = this.byBase.get(row.base)
      if (bucket === undefined) this.byBase.set(row.base, [row])
      else bucket.push(row)
    }
    for (const bucket of this.byBase.values()) {
      bucket.sort((a, b) => (a.asOf < b.asOf ? -1 : 1))
    }
  }

  /** Rows discarded for having a non-INR quote, so the UI can report them rather than lose them. */
  get invalidDirectionRows(): readonly FxRateRow[] {
    return this.rejected
  }

  /**
   * The newest stored rate, provided it is still current as of `asOf`.
   *
   * A rate older than `MAX_FX_LATEST_AGE_DAYS` is refused rather than returned, and refused with
   * its own date attached so the caller can say *how* old rather than merely that something is
   * missing. The holding it would have converted leaves net worth, exactly as it does when no rate
   * was ever stored: a frozen rate multiplied by a price that is still moving produces a total that
   * changes every day and is wrong every day, which is the one outcome this subsystem must not
   * produce quietly.
   *
   * A rate dated after `asOf` is not stale — a provider quoting in a timezone ahead of IST puts one
   * there routinely — so the comparison is one-sided.
   */
  latest(from: CurrencyCode, to: 'INR', asOf: IsoDate): FxResult {
    if (from === to) return { ok: true, value: IDENTITY }
    const rows = this.byBase.get(from)
    const last = rows?.[rows.length - 1]
    if (last === undefined) return { ok: false, error: { code: 'NO_FX_SOURCE', pair: `${from}/${to}` } }
    const ageDays = daysBetween(last.asOf, asOf)
    if (ageDays > MAX_FX_LATEST_AGE_DAYS) {
      return {
        ok: false,
        error: { code: 'FX_RATE_STALE', pair: `${from}/${to}`, asOf: last.asOf, ageDays },
      }
    }
    return { ok: true, value: { rate: last.rate, asOf: last.asOf, source: last.source } }
  }

  /**
   * The nearest preceding rate within three calendar days, marked with its actual `asOf` so the
   * caller can see it is not the requested date's rate.
   */
  on(from: CurrencyCode, to: 'INR', date: IsoDate): FxResult {
    if (from === to) return { ok: true, value: IDENTITY }
    const rows = this.byBase.get(from)
    if (rows === undefined || rows.length === 0) {
      return { ok: false, error: { code: 'NO_FX_SOURCE', pair: `${from}/${to}` } }
    }
    let best: FxRateRow | null = null
    for (const row of rows) {
      if (row.asOf > date) break
      best = row
    }
    if (best === null || daysBetween(best.asOf, date) > MAX_FX_BACKFILL_DAYS) {
      return { ok: false, error: { code: 'NO_FX_RATE', pair: `${from}/${to}`, date } }
    }
    return { ok: true, value: { rate: best.rate, asOf: best.asOf, source: best.source } }
  }
}
