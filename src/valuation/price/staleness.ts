/**
 * Price freshness, defined against each instrument's own publication calendar rather than a fixed
 * duration — "four hours old" means fresh for a mutual fund NAV and broken for Bitcoin.
 *
 * A very stale price still produces a value and still counts in net worth; it is flagged. Blanking
 * net worth on a flight is a worse failure than showing a three-day-old number that says it is
 * three days old.
 */

import { businessDaysBetween, daysBetween } from '../calendar'
import type { AssetClass, IsoDate, IsoInstant, Warning } from '../types'
import type { PriceAge, PricePoint, Staleness } from './types'

interface Thresholds {
  /** Unit the two thresholds are counted in. */
  readonly unit: 'business_days' | 'calendar_days'
  readonly staleAfter: number
  readonly veryStaleAfter: number
}

const THRESHOLDS: Record<AssetClass, Thresholds> = {
  mutual_fund: { unit: 'business_days', staleAfter: 2, veryStaleAfter: 7 },
  indian_equity: { unit: 'business_days', staleAfter: 2, veryStaleAfter: 7 },
  us_equity: { unit: 'business_days', staleAfter: 2, veryStaleAfter: 7 },
  // Crypto trades continuously, so its clock runs on calendar time: 6 hours stale, 48 very stale.
  crypto: { unit: 'calendar_days', staleAfter: 0, veryStaleAfter: 2 },
  gold: { unit: 'business_days', staleAfter: 3, veryStaleAfter: 14 },
  bond: { unit: 'business_days', staleAfter: 3, veryStaleAfter: 14 },
  cash: { unit: 'calendar_days', staleAfter: 7, veryStaleAfter: 30 },
}

/**
 * Exchange holiday calendars ship as static data and are refreshed annually. When the calendar is
 * missing a year the engine degrades to a weekday calendar and says so, rather than mislabelling
 * every price as stale over Diwali.
 */
export interface TradingCalendar {
  /** Holidays for the exchange relevant to the asset class, as ISO dates. */
  readonly holidays: ReadonlySet<IsoDate>
  /** Years the calendar actually covers. */
  readonly years: ReadonlySet<number>
}

export interface StalenessInput {
  readonly point: PricePoint
  readonly assetClass: AssetClass
  readonly valuationDate: IsoDate
  readonly calendar?: TradingCalendar
}

export interface StalenessOutcome {
  readonly age: PriceAge
  readonly warnings: readonly Warning[]
}

function countHolidays(calendar: TradingCalendar | undefined, from: IsoDate, to: IsoDate): number {
  if (calendar === undefined) return 0
  let count = 0
  for (const holiday of calendar.holidays) {
    if (holiday > from && holiday <= to) count += 1
  }
  return count
}

function classify(elapsed: number, thresholds: Thresholds): Staleness {
  if (elapsed > thresholds.veryStaleAfter) return 'very_stale'
  if (elapsed > thresholds.staleAfter) return 'stale'
  return 'fresh'
}

export function priceAge(input: StalenessInput): StalenessOutcome {
  const thresholds = THRESHOLDS[input.assetClass]
  const ageDays = daysBetween(input.point.asOf, input.valuationDate)
  const warnings: Warning[] = []

  let elapsed: number
  if (thresholds.unit === 'calendar_days') {
    elapsed = ageDays
  } else {
    const year = yearOf(input.valuationDate)
    if (input.calendar !== undefined && !input.calendar.years.has(year)) {
      warnings.push({
        code: 'TRADING_CALENDAR_STALE',
        message: `No trading calendar for ${year.toString()}; falling back to a weekday calendar, which will call a holiday a missed session.`,
      })
    }
    elapsed =
      businessDaysBetween(input.point.asOf, input.valuationDate) -
      countHolidays(input.calendar, input.point.asOf, input.valuationDate)
  }

  const staleness = classify(elapsed < 0 ? 0 : elapsed, thresholds)
  if (staleness === 'stale') {
    warnings.push({
      code: 'PRICE_STALE',
      message: `Price for ${input.point.instrumentId} is from ${input.point.asOf}.`,
      ref: { instrumentId: input.point.instrumentId },
    })
  } else if (staleness === 'very_stale') {
    warnings.push({
      code: 'PRICE_VERY_STALE',
      message: `Price for ${input.point.instrumentId} is from ${input.point.asOf} and is well past its publication cadence.`,
      ref: { instrumentId: input.point.instrumentId },
    })
  }

  return {
    age: {
      asOf: input.point.asOf,
      fetchedAt: input.point.fetchedAt,
      ageDays,
      staleness,
      source: input.point.source,
    },
    warnings,
  }
}

function yearOf(date: IsoDate): number {
  const text = date.slice(0, 4)
  let year = 0
  for (const digit of text) {
    const code = digit.codePointAt(0)
    if (code === undefined) return 0
    year = year * 10 + (code - 48)
  }
  return year
}

/** The instant a price row was written, for callers that keep their own clock. */
export function fetchedAt(point: PricePoint): IsoInstant {
  return point.fetchedAt
}
