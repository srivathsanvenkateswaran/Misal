/**
 * A token bucket per exchange, seeded from the exchange's own response headers.
 *
 * Not from a hardcoded constant: both exchanges publish a live budget header and both have
 * changed their documented limits since. CoinDCX publishes four mutually contradictory figures
 * across its docs, FAQ and help site, so the live header plus a conservative per-second floor is
 * the only defensible policy.
 *
 * The target is half the published budget. Misal is a background tracker; there is no reason to
 * race, and the cost of being wrong is an IP ban that escalates from two minutes to three days.
 */

import { delayMillis } from './duration'
import { AdapterError, headerValue } from './errors'

export interface LimiterClock {
  /** Milliseconds since some fixed origin. Monotonic within a process is enough. */
  now(): number
  sleep(ms: number): Promise<void>
  /** In [0, 1). Injected so backoff jitter is deterministic under test. */
  random(): number
}

export const systemClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
}

export interface LimiterOptions {
  /** Published budget per minute, until a response header says otherwise. */
  readonly budgetPerMinute: number
  /** Hard ceiling per second, applied whatever the minute budget says. */
  readonly maxPerSecond: number
  /** Header naming the weight consumed so far in the current minute, if the exchange sends one. */
  readonly usedWeightHeader?: string
  readonly clock?: LimiterClock
}

/** Half the budget: a tracker has no reason to spend the rest. */
const TARGET_FRACTION = 2

export class RateLimiter {
  private budgetPerMinute: number
  private readonly maxPerSecond: number
  private readonly usedWeightHeader: string | undefined
  private readonly clock: LimiterClock

  /** Weight spent in the current window, and when that window opened. */
  private spent = 0
  private windowStart: number
  /** Timestamps of recent requests, for the per-second ceiling. */
  private recent: number[] = []
  /** Wall time before which nothing may be sent. Set by a 418, and never shortened. */
  private haltedUntil = 0
  private haltReason = ''

  constructor(options: LimiterOptions) {
    this.budgetPerMinute = options.budgetPerMinute
    this.maxPerSecond = options.maxPerSecond
    this.usedWeightHeader = options.usedWeightHeader
    this.clock = options.clock ?? systemClock
    this.windowStart = this.clock.now()
  }

  /** Wait until `weight` may be spent, then record it. */
  async acquire(weight: number): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      if (now < this.haltedUntil) {
        // Retrying into a ban converts a two-minute outage into a three-day one.
        throw new AdapterError('ip_banned', this.haltReason, {
          retryAfterMs: this.haltedUntil - now,
        })
      }
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now
        this.spent = 0
      }
      this.recent = this.recent.filter((t) => now - t < 1000)

      const minuteRoom = this.spent + weight <= this.budgetPerMinute / TARGET_FRACTION
      const secondRoom = this.recent.length < this.maxPerSecond
      if (minuteRoom && secondRoom) {
        this.spent += weight
        this.recent.push(now)
        return
      }
      const waitForMinute = minuteRoom ? 0 : 60_000 - (now - this.windowStart)
      const waitForSecond = secondRoom ? 0 : 1000
      await this.clock.sleep(waitForMinute > waitForSecond ? waitForMinute : waitForSecond)
    }
  }

  /**
   * Update the budget from a response.
   *
   * Error responses may omit the headers entirely - CoinDCX's do - so absence must leave the
   * limiter's own accounting untouched rather than resetting it to zero.
   */
  observe(headers: Readonly<Record<string, string>>): void {
    const used = this.usedWeightHeader === undefined
      ? undefined
      : headerValue(headers, this.usedWeightHeader)
    if (used !== undefined && /^\d+$/.test(used)) {
      // The server's figure is authoritative: it counts requests this process did not make.
      const serverSpent = smallCount(used)
      if (serverSpent > this.spent) this.spent = serverSpent
    }

    // CoinDCX: `ratelimit: limit=5000, remaining=4999, reset=…`
    const ratelimit = headerValue(headers, 'ratelimit')
    if (ratelimit !== undefined) {
      const limit = /limit=(\d+)/.exec(ratelimit)
      const remaining = /remaining=(\d+)/.exec(ratelimit)
      if (limit?.[1] !== undefined) this.budgetPerMinute = smallCount(limit[1])
      if (limit?.[1] !== undefined && remaining?.[1] !== undefined) {
        const serverSpent = smallCount(limit[1]) - smallCount(remaining[1])
        if (serverSpent > this.spent) this.spent = serverSpent
      }
    }
  }

  /** Read the published budget out of Binance's exchangeInfo rate-limit block. */
  setBudgetPerMinute(value: number): void {
    if (value > 0) this.budgetPerMinute = value
  }

  /** Stop the adapter for the stated duration. Called on a 418. */
  halt(durationMs: number, reason: string): void {
    const until = this.clock.now() + durationMs
    if (until > this.haltedUntil) {
      this.haltedUntil = until
      this.haltReason = reason
    }
  }

  get halted(): boolean {
    return this.clock.now() < this.haltedUntil
  }

  /** The limiter owns the clock, so a test can drive backoff without real time passing. */
  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms)
  }

  /** Exponential backoff with full jitter, for a retryable failure. */
  backoffMs(attempt: number, floorMs = 500): number {
    const ceiling = floorMs * 2 ** (attempt - 1)
    const capped = ceiling > 60_000 ? 60_000 : ceiling
    return delayMillis(BigInt(Math.trunc(this.clock.random() * capped)))
  }
}

/** Parse a small non-negative counter without a float. Header values are bounded in practice. */
function smallCount(text: string): number {
  let value = 0
  for (const ch of text) {
    value = value * 10 + '0123456789'.indexOf(ch)
    if (value > 10_000_000) return 10_000_000
  }
  return value
}
