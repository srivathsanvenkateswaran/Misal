/**
 * Test scaffolding: a whole adapter context wired to recorded fixtures and a clock that only
 * moves when something asks it to.
 *
 * Nothing here can reach the network. The transport is a fixture replayer, and the socket guard
 * installed from tests/setup.ts fails the test if anything tries to go around it.
 */

import type { AdapterContext, AdapterIssue, ExchangeAdapter } from '../contract'
import { createGuardedHttp } from '../http'
import { RateLimiter, type LimiterClock } from '../ratelimit'
import { fixedClockOffset, MeasuredClockOffset } from '../time'
import { createReplayTransport, loadFixtures, type ReplayTransport } from './replay-transport'

/** A clock that advances only through `sleep`, so backoff is instant and deterministic. */
export class ManualClock implements LimiterClock {
  private current = 0
  readonly slept: number[] = []

  now(): number {
    return this.current
  }

  sleep(ms: number): Promise<void> {
    this.slept.push(ms)
    this.current += ms
    return Promise.resolve()
  }

  random(): number {
    return 0.5
  }

  advance(ms: number): void {
    this.current += ms
  }
}

export interface HarnessOptions {
  readonly adapter: ExchangeAdapter
  readonly exchange: string
  /** Fixture names, in preference order. Omit to make every fixture in the directory available. */
  readonly fixtures?: readonly string[]
  readonly accountId?: string
  readonly now?: Date
  readonly maxAttempts?: number
  readonly budgetPerMinute?: number
  readonly maxPerSecond?: number
}

export interface Harness {
  readonly ctx: AdapterContext
  readonly transport: ReplayTransport
  readonly limiter: RateLimiter
  readonly clock: ManualClock
  readonly issues: AdapterIssue[]
  readonly offset: MeasuredClockOffset
}

export function createHarness(options: HarnessOptions): Harness {
  const fixtures = loadFixtures(options.exchange)
  const transport = createReplayTransport(
    fixtures,
    options.fixtures === undefined ? {} : { only: options.fixtures },
  )
  const clock = new ManualClock()
  const limiter = new RateLimiter({
    budgetPerMinute: options.budgetPerMinute ?? 6000,
    maxPerSecond: options.maxPerSecond ?? 1000,
    clock,
  })
  const issues: AdapterIssue[] = []
  const accountId = options.accountId ?? 'account-1'
  const now = options.now ?? new Date('2026-08-12T10:00:00.000Z')

  const http = createGuardedHttp({
    adapterId: options.adapter.id,
    accountId,
    allowlist: options.adapter.requestAllowlist,
    hosts: options.adapter.hosts,
    transport,
    limiter,
    userAgent: 'Misal/0.1 (test)',
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })

  const base: AdapterContext = {
    accountId,
    http,
    clock: fixedClockOffset('0'),
    discoveredAssets: [],
    log: (issue) => issues.push(issue),
    now: () => now,
  }

  const offset = new MeasuredClockOffset('0', async () => ({
    serverMs: await options.adapter.serverTime(base),
    localMs: `${BigInt(now.getTime())}`,
  }))

  return { ctx: { ...base, clock: offset }, transport, limiter, clock, issues, offset }
}

/** A context with a given discovered asset set, for Binance's symbol enumeration. */
export function withAssets(ctx: AdapterContext, assets: readonly string[]): AdapterContext {
  return { ...ctx, discoveredAssets: assets }
}
