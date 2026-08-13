/**
 * Epoch milliseconds to ISO-8601, without a float anywhere in the path.
 *
 * CoinDCX returns fill timestamps as fractional milliseconds - `1718386312255.3608`. The rule is
 * truncate the string at the decimal point, never round: rounding introduces a one-millisecond
 * jitter that changes `txn.natural_key` and therefore defeats deduplication against the same
 * trade imported from a CSV.
 *
 * The civil-date conversion is done in bigint arithmetic rather than through `Date`, because
 * `new Date(ms)` needs a `number` and this module would then be the one place in the adapters
 * where every timestamp passes through a double. It is exact and it is cheap.
 */

import type { ClockOffset } from './contract'
import { AdapterError } from './errors'

/** Integer milliseconds since the Unix epoch, as a string. */
export type EpochMs = string

/**
 * Truncate a timestamp literal to whole milliseconds.
 *
 * Applied to the raw response text, before anything parses it.
 */
export function truncateToMs(raw: string): EpochMs {
  const trimmed = raw.trim()
  const match = /^(-?\d+)(?:\.\d+)?$/.exec(trimmed)
  if (match === null || match[1] === undefined) {
    throw new AdapterError('malformed_response', 'The exchange returned an unreadable timestamp.', {
      detail: `timestamp: ${JSON.stringify(raw)}`,
    })
  }
  return match[1]
}

const MS_PER_DAY = 86_400_000n

/** Convert epoch milliseconds to a UTC ISO-8601 string with an explicit offset. */
export function epochMsToIso(ms: EpochMs): string {
  const total = BigInt(truncateToMs(ms))
  // Floor division, so times before 1970 land on the right day rather than one day late.
  const days = total >= 0n ? total / MS_PER_DAY : -((-total + MS_PER_DAY - 1n) / MS_PER_DAY)
  const msOfDay = total - days * MS_PER_DAY

  const { year, month, day } = civilFromDays(days)
  const hour = msOfDay / 3_600_000n
  const minute = (msOfDay / 60_000n) % 60n
  const second = (msOfDay / 1000n) % 60n
  const milli = msOfDay % 1000n

  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(milli, 3)}Z`
  )
}

/** The UTC calendar date of an instant, as 'YYYY-MM-DD'. Used for `position.as_of`. */
export function epochMsToUtcDate(ms: EpochMs): string {
  return epochMsToIso(ms).slice(0, 10)
}

/** The UTC calendar date of a Date, as 'YYYY-MM-DD'. */
export function utcDateOf(when: Date): string {
  return when.toISOString().slice(0, 10)
}

/**
 * Epoch milliseconds for an instant, adjusted by the measured exchange clock offset.
 *
 * Both exchanges reject signed requests whose timestamp drifts too far, and a laptop resuming
 * from sleep is exactly the machine that drifts. Every signed timestamp goes through here rather
 * than reading the local clock directly.
 */
export function signingTimestamp(now: Date, clockOffsetMs: string): EpochMs {
  return `${BigInt(now.getTime()) + BigInt(clockOffsetMs)}`
}

/** Epoch milliseconds of a Date, exactly. */
export function epochMsOf(when: Date): EpochMs {
  return `${BigInt(when.getTime())}`
}

/**
 * Binance's withdrawal timestamps, which are not epochs.
 *
 * `capital/withdraw/history` reports `applyTime` and `completeTime` as `'2019-10-12 11:12:02'` -
 * a UTC civil datetime with a space instead of a `T` and no zone marker at all - while every other
 * endpoint on the same API reports integer milliseconds. Reformatted by string surgery rather than
 * fed to `Date`, because `new Date('2019-10-12 11:12:02')` is parsed in the *local* zone by every
 * engine, which would silently shift an Indian user's withdrawals by five and a half hours and put
 * some of them on the wrong calendar day - and the calendar day is what the natural key is built on.
 */
export function binanceCivilTimeToIso(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(
    raw.trim(),
  )
  if (match === null) {
    throw new AdapterError('malformed_response', 'The exchange returned an unreadable timestamp.', {
      detail: `timestamp: ${JSON.stringify(raw)}`,
    })
  }
  const [, year, month, day, hour, minute, second, milli] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${(milli ?? '').padEnd(3, '0')}Z`
}

/**
 * Parse an HTTP `Date` header to epoch milliseconds.
 *
 * CoinDCX has no server-time endpoint - every candidate path 404s - so this header is the only
 * clock reference it offers. One-second granularity, which is ample against a ten-second window.
 */
export function httpDateToEpochMs(value: string): EpochMs | null {
  const parsed = new Date(value)
  const time = parsed.getTime()
  // NaN is the only failure mode Date exposes, and it is not equal to itself.
  if (time !== time) return null
  return `${BigInt(time)}`
}

/**
 * The measured drift, and the one re-measurement a skew rejection is allowed to trigger.
 *
 * `measure` is supplied by the sync runner and calls the adapter's own `serverTime`, so this
 * class stays ignorant of which exchange it is talking to - Binance has a server-time endpoint,
 * CoinDCX has none and reads the HTTP `Date` header instead.
 */
export class MeasuredClockOffset implements ClockOffset {
  private current: string
  private resyncs = 0

  constructor(
    initial: string,
    private readonly measure: () => Promise<{ serverMs: string; localMs: string }>,
  ) {
    this.current = initial
  }

  get offsetMs(): string {
    return this.current
  }

  /** How many times the offset has been re-measured this sync. Asserted by the skew tests. */
  get resyncCount(): number {
    return this.resyncs
  }

  async resync(): Promise<void> {
    const { serverMs, localMs } = await this.measure()
    this.current = `${BigInt(serverMs) - BigInt(localMs)}`
    this.resyncs += 1
  }
}

/** A fixed offset, for the connect flow and for tests that do not exercise skew. */
export function fixedClockOffset(offsetMs = '0'): ClockOffset {
  return {
    offsetMs,
    resync: () => Promise.resolve(),
  }
}

/**
 * Days since 1970-01-01 to a civil date. Howard Hinnant's algorithm, in exact integer maths.
 */
function civilFromDays(days: bigint): { year: bigint; month: bigint; day: bigint } {
  const z = days + 719_468n
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n
  const doe = z - era * 146_097n
  const yoe = (doe - doe / 1460n + doe / 36_524n - doe / 146_096n) / 365n
  const y = yoe + era * 400n
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n)
  const mp = (5n * doy + 2n) / 153n
  const d = doy - (153n * mp + 2n) / 5n + 1n
  const m = mp < 10n ? mp + 3n : mp - 9n
  return { year: m <= 2n ? y + 1n : y, month: m, day: d }
}

function pad(value: bigint, width: number): string {
  return `${value}`.padStart(width, '0')
}
