/**
 * The price service boundary.
 *
 * Valuation never fetches; it reads the `price` table. Fetching lives behind `PriceProvider` and is
 * invoked only by an explicit refresh. That split is what makes the application work offline and
 * what makes the engine testable without a network — every test in this subsystem runs against a
 * fake provider and an in-memory store.
 */

import type { CurrencyCode, Dec } from '@domain/numeric'
import type { AssetClass, InstrumentRef, IsoDate, IsoInstant } from '../types'

/**
 * Must stay in step with the CHECK constraint on `price.source` in migration 0001. A source the
 * database accepts but this type rejects is a row that can be written and never read back.
 */
export type PriceSource = 'amfi' | 'twelvedata' | 'yahoo' | 'coingecko' | 'manual'

/**
 * Either a specific date or the most recent row.
 *
 * `IsoDate & {}` rather than a bare `IsoDate`, so that the `'latest'` literal survives the union
 * instead of being absorbed into `string`.
 */
export type PriceSelector = 'latest' | (IsoDate & {})

export interface UnitPrice {
  readonly value: Dec
  readonly currency: CurrencyCode
}

/** A row of the `price` table, parsed. */
export interface PricePoint {
  readonly instrumentId: string
  readonly asOf: IsoDate
  readonly close: Dec
  readonly currency: CurrencyCode
  readonly source: PriceSource
  readonly fetchedAt: IsoInstant
}

export interface HistoricalClose {
  readonly asOf: IsoDate
  readonly close: Dec
  readonly currency: CurrencyCode
}

export interface RateLimit {
  readonly perMinute: number
  readonly perDay: number
  readonly creditsPerSymbol: number
}

export interface ProviderCapabilities {
  readonly assetClasses: readonly AssetClass[]
  readonly requiresApiKey: boolean
  readonly latency: 'realtime' | 'delayed' | 'eod'
  readonly supportsHistory: boolean
  readonly supportsFx: boolean
  readonly rateLimit: RateLimit | null
}

export type ProviderError =
  /** The provider does not cover this instrument at all. */
  | { readonly code: 'NOT_SUPPORTED' }
  /** The symbol is unknown to the provider. */
  | { readonly code: 'NOT_FOUND' }
  | { readonly code: 'PLAN_RESTRICTED'; readonly detail: string }
  | { readonly code: 'RATE_LIMITED'; readonly retryAfterMs: number }
  | { readonly code: 'AUTH_FAILED' }
  | { readonly code: 'OFFLINE' }
  | { readonly code: 'MALFORMED_RESPONSE'; readonly detail: string }
  | { readonly code: 'UPSTREAM'; readonly status: number }

export type QuoteResult =
  | {
      readonly ok: true
      readonly ref: InstrumentRef
      readonly price: UnitPrice
      readonly asOf: IsoDate
      readonly previousClose: UnitPrice | null
    }
  | { readonly ok: false; readonly ref: InstrumentRef; readonly error: ProviderError }

export interface FxPair {
  readonly base: CurrencyCode
  readonly quote: 'INR'
}

export type FxQuoteResult =
  | { readonly ok: true; readonly pair: FxPair; readonly rate: Dec; readonly asOf: IsoDate }
  | { readonly ok: false; readonly pair: FxPair; readonly error: ProviderError }

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderError }

export interface PriceProvider {
  readonly id: PriceSource
  readonly capabilities: ProviderCapabilities

  /** Pure predicate over instrument metadata and aliases. No I/O. */
  supports(instrument: InstrumentRef): boolean

  /**
   * Latest available price. Batched, and the batch is the unit of rate limiting.
   *
   * Returns a per-symbol result array rather than throwing, because one unknown ticker in a batch
   * of forty must not lose the other thirty-nine.
   */
  fetchLatest(refs: readonly InstrumentRef[], signal: AbortSignal): Promise<readonly QuoteResult[]>

  /** Historical closes, inclusive range. */
  fetchHistory(
    ref: InstrumentRef,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalClose[]>>

  /** Optional. Only providers that serve FX implement this. */
  fetchFx?(
    pairs: readonly FxPair[],
    on: PriceSelector,
    signal: AbortSignal,
  ): Promise<readonly FxQuoteResult[]>
}

export type PriceError =
  /** Supported, just never fetched. Recoverable by a refresh. */
  | { readonly code: 'NO_PRICE'; readonly instrumentId: string }
  /** No provider supports it. Permanent until a manual override is entered. */
  | { readonly code: 'NO_PRICE_SOURCE'; readonly instrumentId: string }
  | {
      readonly code: 'PRICE_CURRENCY_MISMATCH'
      readonly expected: CurrencyCode
      readonly got: CurrencyCode
    }

export interface RefreshScope {
  readonly instrumentIds?: readonly string[]
  readonly assetClasses?: readonly AssetClass[]
  readonly onlyStale?: boolean
}

export interface RefreshReport {
  readonly startedAt: IsoInstant
  readonly finishedAt: IsoInstant
  readonly requested: number
  readonly updated: number
  readonly unchanged: number
  readonly failed: number
  readonly failures: readonly { readonly instrumentId: string; readonly error: ProviderError }[]
  readonly creditsConsumed: number
  readonly rateLimited: boolean
}

export type Staleness = 'fresh' | 'stale' | 'very_stale'

export interface PriceAge {
  readonly asOf: IsoDate
  readonly fetchedAt: IsoInstant
  /** Calendar days from `asOf` to the valuation date. */
  readonly ageDays: number
  readonly staleness: Staleness
  readonly source: PriceSource
}
