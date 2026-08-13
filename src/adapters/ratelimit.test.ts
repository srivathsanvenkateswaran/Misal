import { describe, expect, it } from 'vitest'
import { AdapterError } from './errors'
import { RateLimiter } from './ratelimit'
import { ManualClock } from './testing/harness'
import { installSocketGuard, NetworkAccessInTestError } from './testing/socket-guard'

describe('the token bucket', () => {
  it('spends only half the published budget', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({ budgetPerMinute: 100, maxPerSecond: 1000, clock })

    // A tracker has no reason to race, and the cost of being wrong is an IP ban.
    for (let i = 0; i < 50; i += 1) await limiter.acquire(1)
    expect(clock.slept).toHaveLength(0)

    await limiter.acquire(1)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('takes the server’s figure over its own when the server counts higher', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({
      budgetPerMinute: 100,
      maxPerSecond: 1000,
      usedWeightHeader: 'x-mbx-used-weight-1m',
      clock,
    })
    // The header counts requests this process did not make - another Misal window, or the
    // user's own script.
    limiter.observe({ 'X-MBX-USED-WEIGHT-1M': '49' })
    await limiter.acquire(1)
    await limiter.acquire(1)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('survives a response with no rate-limit headers at all', () => {
    const limiter = new RateLimiter({ budgetPerMinute: 100, maxPerSecond: 10 })
    // CoinDCX omits them on error responses, and losing the accounting there would be worse
    // than having none.
    expect(() => limiter.observe({})).not.toThrow()
  })

  it('reads CoinDCX’s combined ratelimit header', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({ budgetPerMinute: 5000, maxPerSecond: 1000, clock })
    // limit - remaining = 50 already spent, which is the whole of our half of the budget.
    limiter.observe({ ratelimit: 'limit=100, remaining=50, reset=42' })
    await limiter.acquire(1)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('enforces a per-second ceiling regardless of the minute budget', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({ budgetPerMinute: 100_000, maxPerSecond: 2, clock })
    await limiter.acquire(1)
    await limiter.acquire(1)
    await limiter.acquire(1)
    expect(clock.slept).toContain(1000)
  })

  it('refuses to send anything at all while an IP ban is in force', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({ budgetPerMinute: 6000, maxPerSecond: 100, clock })
    limiter.halt(120_000, 'banned')

    await expect(limiter.acquire(1)).rejects.toBeInstanceOf(AdapterError)
    expect(limiter.halted).toBe(true)

    clock.advance(120_001)
    await expect(limiter.acquire(1)).resolves.toBeUndefined()
  })

  it('never shortens a ban', async () => {
    const clock = new ManualClock()
    const limiter = new RateLimiter({ budgetPerMinute: 6000, maxPerSecond: 100, clock })
    limiter.halt(120_000, 'long')
    limiter.halt(1000, 'short')
    clock.advance(1001)
    await expect(limiter.acquire(1)).rejects.toBeInstanceOf(AdapterError)
  })

  it('jitters its backoff and caps it', () => {
    const limiter = new RateLimiter({
      budgetPerMinute: 6000,
      maxPerSecond: 100,
      clock: new ManualClock(),
    })
    expect(limiter.backoffMs(1)).toBe(250)
    expect(limiter.backoffMs(2)).toBe(500)
    expect(limiter.backoffMs(20)).toBe(30_000)
  })
})

describe('the account budget, which is a separate bucket', () => {
  /** Binance's real figures: 180,000 UID weight a minute, and 18,000 for one withdrawal page. */
  function binanceish(clock: ManualClock): RateLimiter {
    return new RateLimiter({
      budgetPerMinute: 6000,
      maxPerSecond: 1000,
      uidBudgetPerMinute: 180_000,
      usedUidWeightHeader: 'x-sapi-used-uid-weight-1m',
      clock,
    })
  }

  it('paces the expensive endpoints without touching the IP budget', async () => {
    const clock = new ManualClock()
    const limiter = binanceish(clock)

    // Five withdrawal pages is 90,000, which is the whole of our half of the account budget.
    for (let i = 0; i < 5; i += 1) await limiter.acquire(1, 18_000)
    expect(clock.slept).toHaveLength(0)

    await limiter.acquire(1, 18_000)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('does not let account weight exhaust the per-IP budget, or the reverse', async () => {
    const clock = new ManualClock()
    const limiter = binanceish(clock)
    // 18,000 would be six times the IP target on its own; counted apart, it costs 1 there.
    for (let i = 0; i < 4; i += 1) await limiter.acquire(1, 18_000)
    // And a cheap IP-metered call still goes straight through afterwards.
    await limiter.acquire(1, 0)
    expect(clock.slept).toHaveLength(0)
  })

  it('believes the server’s account figure over its own', async () => {
    const clock = new ManualClock()
    const limiter = binanceish(clock)
    // Another device sharing this key has already spent our half of the budget.
    limiter.observe({ 'X-SAPI-USED-UID-WEIGHT-1M': '90000' })
    await limiter.acquire(1, 1)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('refuses a request that could never fit rather than sleeping forever', async () => {
    const clock = new ManualClock()
    const limiter = binanceish(clock)
    // A sync that never finishes and never errors is indistinguishable from a slow one, which is
    // the failure this guard exists to make loud.
    await expect(limiter.acquire(1, 200_000)).rejects.toBeInstanceOf(AdapterError)
    await expect(limiter.acquire(9000, 0)).rejects.toBeInstanceOf(AdapterError)
    expect(clock.slept).toHaveLength(0)
  })

  it('ignores account weight entirely for an exchange that has no such budget', async () => {
    const clock = new ManualClock()
    // CoinDCX publishes one budget. A limiter with no second bucket must not invent one.
    const limiter = new RateLimiter({ budgetPerMinute: 5000, maxPerSecond: 1000, clock })
    for (let i = 0; i < 10; i += 1) await limiter.acquire(1, 18_000)
    expect(clock.slept).toHaveLength(0)
  })
})

describe('the socket guard', () => {
  it('fails any test that tries to reach the network', () => {
    installSocketGuard()
    expect(() => fetch('https://api.binance.com/api/v3/time')).toThrow(NetworkAccessInTestError)
    expect(() => new XMLHttpRequest()).toThrow(NetworkAccessInTestError)
    expect(() => new WebSocket('wss://stream.binance.com')).toThrow(NetworkAccessInTestError)
  })
})
