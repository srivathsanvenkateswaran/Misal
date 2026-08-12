/**
 * The adapter registry.
 *
 * Registration validates the allowlist. An adapter whose declared requests include a mutating
 * path cannot be constructed at all, so the failure happens at startup in front of a developer
 * rather than at sync time in front of a user's funds.
 */

import { assertAllowlistIsReadOnly } from './allowlist'
import { createBinanceAdapter } from './binance/adapter'
import { createCoindcxAdapter } from './coindcx/adapter'
import type { ExchangeAdapter, ProviderId } from './contract'
import type { RateLimiter } from './ratelimit'
import { RateLimiter as Limiter } from './ratelimit'

export * from './contract'
export { AdapterError, type AdapterErrorCode } from './errors'
export { assertAllowlistIsReadOnly, classifyPath, isMutatingPath } from './allowlist'
export { connectAccount, type ConnectOutcome, type CredentialVault } from './connect'
export { runSync, type SyncOutcome } from './sync/runner'
export { RateLimiter } from './ratelimit'

export interface AdapterRegistration {
  readonly adapter: ExchangeAdapter
  readonly limiter: RateLimiter
}

/**
 * Rate-limit seeds.
 *
 * Binance's is replaced by the published figure from exchangeInfo on the first market fetch.
 * CoinDCX's per-second cap is deliberate and stays: the exchange publishes four mutually
 * contradictory limits, so a conservative floor plus the live header is the only defensible
 * policy.
 */
const LIMITS: Record<ProviderId, { budgetPerMinute: number; maxPerSecond: number; usedWeightHeader?: string }> = {
  binance: { budgetPerMinute: 6000, maxPerSecond: 20, usedWeightHeader: 'x-mbx-used-weight-1m' },
  coindcx: { budgetPerMinute: 5000, maxPerSecond: 16 },
}

/** An explicit, browser-like User-Agent. CoinDCX's edge 403s anything that looks like a library. */
export const USER_AGENT = 'Misal/0.1 (+https://github.com/srivathsanvenkateswaran/Misal)'

export function createAdapter(id: ProviderId): AdapterRegistration {
  const limiter = new Limiter(LIMITS[id])
  const adapter = id === 'binance' ? createBinanceAdapter({ limiter }) : createCoindcxAdapter()
  assertAllowlistIsReadOnly(adapter.id, adapter.requestAllowlist)
  return { adapter, limiter }
}

export const ADAPTER_IDS: readonly ProviderId[] = ['binance', 'coindcx']

/** Every adapter, constructed. Used by the conformance suite, which must cover all of them. */
export function createAllAdapters(): readonly AdapterRegistration[] {
  return ADAPTER_IDS.map(createAdapter)
}
