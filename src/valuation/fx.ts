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

export type FxResult = { readonly ok: true; readonly value: FxPoint } | { readonly ok: false; readonly error: FxError }

export interface FxService {
  latest(from: CurrencyCode, to: 'INR'): FxResult
  on(from: CurrencyCode, to: 'INR', date: IsoDate): FxResult
}

/** Weekends and holidays only. Interpolating FX across a longer gap is invention. */
export const MAX_FX_BACKFILL_DAYS = 3

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

  latest(from: CurrencyCode, to: 'INR'): FxResult {
    if (from === to) return { ok: true, value: IDENTITY }
    const rows = this.byBase.get(from)
    const last = rows?.[rows.length - 1]
    if (last === undefined) return { ok: false, error: { code: 'NO_FX_SOURCE', pair: `${from}/${to}` } }
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
