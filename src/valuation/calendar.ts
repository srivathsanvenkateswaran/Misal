/**
 * Calendar arithmetic for the fold, the holding-period test and XIRR discounting.
 *
 * Day counts are the one place the engine uses `number`: they are counts of days, never money or
 * quantities, and every one of them is asserted integral before it is used. Where a day count
 * enters arithmetic that touches value — the XIRR exponent `t/365` — it is converted to `Dec`
 * first via `decFromCount`, so no float ever reaches a discount factor.
 */

import { DateTime } from 'luxon'
import type { IsoDate, IsoInstant } from './types'
import { ValuationAssertionError } from './types'

/** Indian markets and Indian statements. Used when a transaction carries no timezone. */
export const DEFAULT_TZ = 'Asia/Kolkata'

function parseDate(date: IsoDate): DateTime {
  const dt = DateTime.fromISO(date, { zone: 'utc' })
  if (!dt.isValid) throw new ValuationAssertionError(`Not an ISO date: ${date}`)
  return dt
}

function requireIsoDate(dt: DateTime): IsoDate {
  const text = dt.toISODate()
  if (text === null) throw new ValuationAssertionError('Invalid DateTime')
  return text
}

/**
 * The account's local calendar day for a transaction.
 *
 * Day granularity, not instant: statements carry trade dates, and normalising an Indian evening
 * trade to 00:00 UTC would move it to the previous day and reorder the fold.
 */
export function localDate(occurredAt: IsoInstant, tz: string | null): IsoDate {
  const dt = DateTime.fromISO(occurredAt, { setZone: true })
  if (!dt.isValid) throw new ValuationAssertionError(`Not an ISO instant: ${occurredAt}`)
  return requireIsoDate(dt.setZone(tz ?? DEFAULT_TZ))
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const days = parseDate(to).diff(parseDate(from), 'days').days
  if (!Number.isInteger(days)) {
    throw new ValuationAssertionError(`Non-integral day count between ${from} and ${to}`)
  }
  return days
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return requireIsoDate(parseDate(date).plus({ days }))
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  return requireIsoDate(parseDate(date).plus({ months }))
}

export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Section 2(42A): long-term when held for *more than* the threshold, counted calendar-wise.
 *
 * Implemented as a calendar comparison rather than `holdingDays > 365`, because the day-count form
 * misclassifies holdings that span a February by a day — a 2023-02-28 purchase sold on 2024-02-29
 * is 366 days but not more than twelve calendar months.
 */
export function isLongTerm(acquiredOn: IsoDate, disposedOn: IsoDate, thresholdMonths: number): boolean {
  return compareDates(disposedOn, addMonths(acquiredOn, thresholdMonths)) > 0
}

/** The Indian financial year containing `date`, as 'FY2026-27'. Runs 1 April to 31 March. */
export function financialYear(date: IsoDate): string {
  const dt = parseDate(date)
  const startYear = dt.month >= 4 ? dt.year : dt.year - 1
  const endShort = (startYear + 1) % 100
  return `FY${startYear.toString()}-${endShort.toString().padStart(2, '0')}`
}

/** The date part of an instant, in the given zone (defaulting to IST). */
export function instantToDate(instant: IsoInstant, tz: string | null = DEFAULT_TZ): IsoDate {
  return localDate(instant, tz)
}

/** Saturday or Sunday. The fallback calendar when no exchange holiday list is available. */
export function isWeekend(date: IsoDate): boolean {
  const weekday = parseDate(date).weekday
  return weekday === 6 || weekday === 7
}

/** Whole weekdays in `(from, to]`, used by the weekday-degraded staleness calendar. */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  const total = daysBetween(from, to)
  if (total <= 0) return 0
  let count = 0
  for (let i = 1; i <= total; i++) {
    if (!isWeekend(addDays(from, i))) count += 1
  }
  return count
}
