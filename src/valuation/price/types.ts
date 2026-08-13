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

/**
 * One dated exchange rate from a provider's history feed.
 *
 * `asOf` is the provider's own date for the rate and is never moved: a Friday rate is stored on
 * Friday even when the transaction that needed it happened on the Sunday. Re-dating it would turn
 * "the nearest rate within three days", which `FxTable.on` reports honestly, into a fabricated
 * Sunday print that nothing downstream could recognise as one.
 */
export interface HistoricalFxRate {
  readonly asOf: IsoDate
  readonly rate: Dec
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
      /**
       * True when this reading is a live quote from a session that is still open, so it is *not*
       * `asOf`'s close and must not be stored as one.
       *
       * The `price` table holds one row per `(instrument, as_of)` and every historical calculation
       * reads it as that day's close. A user who refreshes at 11:00 IST and never again would
       * otherwise leave an 11:00 print recorded as the closing price of that day, permanently —
       * the same class of failure as a stale price presented as a current one, except that no
       * later refresh can tell the two apart to correct it.
       *
       * Required rather than optional: a provider that has not thought about it must say so
       * explicitly, because the wrong default here is silent and permanent. Providers whose
       * instruments have no session at all — a mutual fund NAV, a crypto pair that trades
       * continuously — say `false` and explain why at the call site.
       */
      readonly intraday: boolean
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

  /**
   * Optional. Dated exchange rates over an inclusive range, for valuing transactions that happened
   * before the rate feed was ever running.
   *
   * Separate from `fetchFx` because the question is different: `fetchFx` asks "what is the rate
   * now", one request per pair, while this asks "what were the rates across these days" and is
   * answered in one request for a whole span. The result carries only the days the provider
   * actually published; a gap in it is a gap, never an interpolation.
   */
  fetchFxHistory?(
    pair: FxPair,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalFxRate[]>>
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
  /**
   * The table holds prices for this instrument, but none on the date asked for.
   *
   * `lastKnown` is the most recent row before `requested`. It rides on the error branch rather
   * than the `ok` branch on purpose: carrying a price forward is a judgement about acceptable
   * staleness, and only the caller can make it. A caller that wants last-known-price semantics
   * names this field and is visibly opting in; one that reads `value.close` cannot be handed a
   * days-old figure by accident.
   */
  | {
      readonly code: 'PRICE_NOT_ON_DATE'
      readonly instrumentId: string
      readonly requested: IsoDate
      readonly lastKnown: PricePoint
      /** Calendar days from `lastKnown.asOf` to `requested`. Always positive. */
      readonly staleByDays: number
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
  /**
   * Instruments whose provider answered with a live quote from an open session, so nothing was
   * written for them.
   *
   * Not a failure — the fetch succeeded and the number is real — but not a close either, and the
   * only row this table can hold is a close. Reported so the absence of a write is visible rather
   * than looking like a refresh that quietly did nothing.
   *
   * Optional because `PriceService.refresh` is the only thing that can know it, while a report is
   * also assembled by hand in the screens that render one. Absent means "this report predates the
   * question", which readers treat as an empty list.
   */
  readonly intradayHeld?: readonly string[]
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
