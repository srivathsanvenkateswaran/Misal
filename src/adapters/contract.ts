/**
 * The exchange adapter contract.
 *
 * An adapter replaces exactly two steps of the ingestion pipeline - `acquire` and `extract` - and
 * nothing else. It produces what a statement parser produces: a source-document descriptor plus a
 * batch of raw records. It never touches SQL, never resolves an instrument, and never decides
 * whether a transaction is a duplicate. Adding an exchange is therefore one directory and a
 * fixture set, not a pipeline.
 *
 * Every numeric that could be a quantity, a price or a fee crosses this boundary as `Dec` - the
 * branded decimal string from @domain/numeric - so a `number` cannot reach the store even by
 * accident. Timestamps cross as integer-millisecond strings for the same reason: CoinDCX reports
 * fractional milliseconds, and a value that has been through a double has already lost digits.
 */

import type { Dec } from '@domain/numeric'

/** An arbitrary-precision decimal, up to 18 dp for crypto. Never a `number`. */
export type DecimalString = Dec

/** Integer milliseconds since the Unix epoch, as a string. int64 exceeds 2^53. */
export type EpochMs = string

/** UTC ISO-8601 with an explicit offset. */
export type Iso8601 = string

export type ProviderId = 'binance' | 'coindcx'

/** An asset as the exchange names it. Never assumed to be globally meaningful. */
export interface RawAsset {
  readonly code: string
}

export interface RawBalance {
  readonly asset: RawAsset
  readonly free: DecimalString
  /** '0' where the exchange has no such concept. */
  readonly locked: DecimalString
}

export interface RawFill {
  readonly externalId: string
  /** Exchange market name, verbatim: 'BTCUSDT', 'BTCINR'. Split via the market catalogue. */
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  /** In the base asset, per MarketSpec - not per the exchange's own naming. */
  readonly quantity: DecimalString
  /** Quote asset per base asset. */
  readonly price: DecimalString
  readonly quoteQuantity?: DecimalString
  readonly fee?: { readonly amount: DecimalString; readonly asset: RawAsset }
  readonly occurredAt: Iso8601
}

/**
 * Units moving into or out of the exchange account.
 *
 * A transfer is **not** a trade and this shape is deliberately unable to describe one: there is no
 * `price` and no `side`. A deposit moves units in without establishing what they cost, and the only
 * honest record of it is a `transfer_in` with no price at all - which the fold already models as a
 * lot whose cost is explicitly unknown. Inventing a market price for the day it arrived would turn
 * a known unknown into a plausible-looking wrong number in the cost-basis column.
 */
export interface RawTransfer {
  readonly externalId: string
  readonly asset: RawAsset
  readonly direction: 'in' | 'out'
  /** Always positive, in units of `asset`. The direction carries the sign, not this field. */
  readonly quantity: DecimalString
  /**
   * Charged on top of `quantity` on the way out, in units of the exchange's choosing. Binance
   * deducts `transactionFee` in addition to the withdrawn amount, so omitting it would leave the
   * fold short by exactly the fee and manufacture a coverage gap that is not one.
   */
  readonly fee?: { readonly amount: DecimalString; readonly asset: RawAsset }
  readonly occurredAt: Iso8601
  readonly status: 'completed' | 'pending' | 'failed'
}

/**
 * A conversion: one asset swapped directly for another, off the order book.
 *
 * Unlike a transfer this *does* establish a cost - the units given up are the consideration - so it
 * is a priced acquisition. It is not a `RawFill` because there is no market and no symbol: Binance
 * Convert will swap any listed pair whether or not a trading pair exists for it, so there is
 * nothing for the market catalogue to split. The two assets are named outright instead.
 */
export interface RawConversion {
  readonly externalId: string
  /** The asset given up. It denominates the cost of what was acquired. */
  readonly from: RawAsset
  readonly fromQuantity: DecimalString
  /** The asset acquired. */
  readonly to: RawAsset
  readonly toQuantity: DecimalString
  /** Units of `from` per unit of `to`, as the exchange reports it. Never recomputed by division. */
  readonly price: DecimalString
  readonly occurredAt: Iso8601
}

/**
 * Splits an exchange symbol into its assets.
 *
 * Supplied by the adapter from the exchange's own market catalogue, never inferred by string
 * splitting: 'BTCUSDT' and 'BTCUSD' are indistinguishable to a suffix match, and any base asset
 * whose code ends in its quote asset's code breaks the same way.
 */
export interface MarketSpec {
  readonly symbol: string
  /** The asset whose quantity is traded. */
  readonly base: RawAsset
  /** The asset the price is denominated in. */
  readonly quote: RawAsset
  /** Display precision, 0-18. */
  readonly quantityPrecision: number
}

export interface SourceDocumentDescriptor {
  readonly providerId: ProviderId
  readonly accountId: string
  readonly kind: 'api-response'
  readonly contentHash: string
  /** Human-readable locator for the UI source stamp: 'binance:myTrades BTCUSDT fromId=0'. */
  readonly pageRef: string
  readonly periodStart?: Iso8601
  readonly periodEnd?: Iso8601
}

/** One acquire step: a batch of records plus the document descriptor they came from. */
export interface AcquiredPage<T> {
  /**
   * null on a checkpoint page - one carrying no records, emitted only to advance the cursor.
   * Binance needs these: proving that a candidate symbol has no trades is worth remembering, and
   * it would otherwise cost a source_document row per empty symbol on every sync.
   */
  readonly document: SourceDocumentDescriptor | null
  readonly records: readonly T[]
  /** null means the caller has reached the end of this stream. */
  readonly nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Scope introspection
// ---------------------------------------------------------------------------

export type ScopeVerification =
  /** The exchange told us, authoritatively. */
  | 'introspected'
  /** The exchange cannot tell us; the user confirmed the settings. */
  | 'attested'
  /** The exchange has no permission model at all. */
  | 'unscopable'

/**
 * 'unknown' is a distinct value from false and the UI must render it differently. Reporting
 * "withdrawals disabled" when we simply cannot see is false reassurance, which is worse than
 * saying nothing.
 */
export type Tristate = boolean | 'unknown'

export interface ScopeReport {
  readonly verification: ScopeVerification
  readonly canRead: Tristate
  readonly canTrade: Tristate
  readonly canWithdraw: Tristate
  readonly canTransferInternally: Tristate
  readonly ipRestricted: Tristate
  /** For the diagnostics pane. Never contains the secret. */
  readonly raw?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

export interface CredentialFieldSpec {
  readonly name: string
  readonly label: string
  /** Rendered masked, and never echoed back to the UI once stored. */
  readonly secret: boolean
  readonly help?: string
}

export type AdapterIssueSeverity = 'error' | 'warning'

/** A note from an adapter that the runner turns into an `import_issue` row. */
export interface AdapterIssue {
  readonly severity: AdapterIssueSeverity
  readonly code: string
  readonly message: string
  readonly rowRef?: string
  readonly rawPayload?: string
}

/**
 * What a sync is doing right now.
 *
 * A first Binance sync is slow by construction and not by accident: `myTrades` requires a symbol,
 * there is no cross-symbol endpoint, and the discovery sweep therefore queries every plausible
 * pair the account's assets could have traded in. That is minutes of work at weight 20 a call, and
 * a progress bar is the difference between "this is working" and "this has hung".
 */
/**
 * Deliberately unchanged by the transfer and Convert streams, which report under `'fills'`.
 *
 * The screens keep an exhaustive `Record<SyncPhase, string>` of phase headings and an ordered list
 * for the "step 3 of 6" counter, so a new member here is a UI change rather than an adapter one -
 * and an adapter that emitted a phase the table has no row for would render a blank heading and an
 * `undefined` in an aria-label. Deposits, withdrawals and Convert are all history walks, so
 * `'fills'` is at worst imprecise where a new phase would be actively broken. See
 * docs/known-issues.md; splitting them out belongs on a branch that owns both sides.
 */
export type SyncPhase =
  | 'scope'
  | 'clock'
  | 'markets'
  | 'balances'
  | 'transfers'
  | 'conversions'
  | 'fills'
  | 'coverage'

export interface SyncProgress {
  readonly phase: SyncPhase
  /** Units finished within the phase. */
  readonly done: number
  /**
   * Units expected, or null where the count is not knowable in advance. CoinDCX pages until a
   * short page arrives and cannot say how many that will be; Binance knows its symbol list.
   */
  readonly total: number | null
  /** What is being worked on, e.g. the trading pair being queried. */
  readonly detail: string
}

export type ProgressReporter = (progress: SyncProgress) => void

/** Method and path only. There is no field here that could express a request body. */
export interface AllowedRequest {
  readonly method: 'GET' | 'POST'
  /** An exact path, or a path with a single trailing '*'. */
  readonly pathPattern: string
  /** Which of the adapter's declared hosts the path lives on. */
  readonly host: HostKey
}

/**
 * Hosts are named rather than supplied per request, so an adapter cannot point a signed request
 * at an arbitrary origin. 'public' is the unauthenticated market-data host where one exists.
 */
export type HostKey = 'primary' | 'public'

/**
 * Exchange server time minus local time, measured at sync start and re-measurable once when a
 * request is rejected for skew.
 *
 * Mutable by design: Binance answers a drifted timestamp with `-1021`, and the correct response
 * is to re-measure once and retry once. Retrying indefinitely against a broken clock burns rate
 * budget and hides a real machine problem, so `resync` is called at most once per request.
 */
export interface ClockOffset {
  readonly offsetMs: string
  resync(): Promise<void>
}

export interface AdapterContext {
  readonly accountId: string
  /** Signs and sends. Rejects any request outside `requestAllowlist` before opening a socket. */
  readonly http: GuardedHttp
  readonly clock: ClockOffset
  /**
   * Every asset this account has ever been seen to hold, from balances, transfers and previously
   * ingested fills. Binance needs it because `myTrades` requires a symbol and there is no
   * all-symbols endpoint; the set only ever grows.
   */
  readonly discoveredAssets: readonly string[]
  readonly log: (issue: AdapterIssue) => void
  /**
   * Say what is happening. Only the adapter knows how much work a phase is: the runner sees an
   * async iterable of pages and cannot tell one symbol of two hundred from the last one.
   */
  readonly report: ProgressReporter
  /** Injected so tests are deterministic and so no adapter reaches for Date.now() directly. */
  readonly now: () => Date
}

export interface ExchangeAdapter {
  readonly id: ProviderId
  readonly displayName: string
  /** 'USD' for Binance, 'INR' for CoinDCX. */
  readonly baseCurrency: string
  /**
   * 'snapshot' for both v1 exchanges. Neither can prove complete trade coverage, and 'ledger'
   * would unlock XIRR and realised P&L on a history we know to be incomplete.
   */
  readonly capability: 'ledger' | 'snapshot'
  readonly credentialFields: readonly CredentialFieldSpec[]
  readonly hosts: Readonly<Record<HostKey, string>>

  /** Enforced by the HTTP layer. The single mechanism that makes Misal structurally read-only. */
  readonly requestAllowlist: readonly AllowedRequest[]

  /** Exchange clock, for HMAC skew correction. */
  serverTime(ctx: AdapterContext): Promise<EpochMs>

  /** Called at connect and again before every sync. */
  describeScope(ctx: AdapterContext): Promise<ScopeReport>

  /** Cached locally; refreshed at most daily. */
  markets(ctx: AdapterContext): Promise<readonly MarketSpec[]>

  fetchBalances(ctx: AdapterContext): Promise<AcquiredPage<RawBalance>>

  /**
   * An AsyncIterable rather than an array specifically so the runner can commit and advance the
   * watermark per page. A backfill of 40,000 trades that dies on the last page must keep the
   * first 39,000.
   */
  fetchFills(
    ctx: AdapterContext,
    cursor: string | null,
    markets: readonly MarketSpec[],
  ): AsyncIterable<AcquiredPage<RawFill>>

  /**
   * Optional: not every exchange exposes deposits and withdrawals.
   *
   * Absent rather than empty where the exchange has no such endpoint. An adapter that returned an
   * empty stream would be indistinguishable from an account with no transfers, and the difference
   * is the whole content of the coverage note.
   */
  fetchTransfers?(
    ctx: AdapterContext,
    cursor: string | null,
  ): AsyncIterable<AcquiredPage<RawTransfer>>

  /**
   * Optional: direct asset-for-asset conversions that never reach the order book.
   *
   * Binance Convert is the case that forced this onto the contract - its fills appear in no trade
   * history at all, so an account whose holdings were acquired that way reads as units with no
   * purchase behind them.
   */
  fetchConversions?(
    ctx: AdapterContext,
    cursor: string | null,
  ): AsyncIterable<AcquiredPage<RawConversion>>

  /**
   * Coverage the adapter knows it cannot provide, stated once per sync so the UI can say so
   * rather than implying the figure is complete. Binance Convert fills, for instance, never
   * appear in trade history at all.
   */
  readonly coverageGaps: readonly string[]
}

// ---------------------------------------------------------------------------
// The guarded transport
// ---------------------------------------------------------------------------

/**
 * How the request is authenticated. The adapter names a scheme; it never sees the secret and
 * never builds an Authorization header itself.
 */
export type SigningScheme =
  | 'none'
  /** HMAC-SHA256 over the exact query string, appended as a trailing `signature` parameter. */
  | 'binance-query'
  /** HMAC-SHA256 over the exact serialised body, sent in X-AUTH-SIGNATURE. */
  | 'coindcx-body'

/**
 * A request as the adapter expresses it.
 *
 * `query` and `body` are already-serialised strings, not objects. That is the whole point: the
 * bytes signed are the bytes transmitted, because there is no second serialisation step for them
 * to diverge across. Handing the transport an object and letting it re-encode is the failure that
 * breaks most CoinDCX clients in the wild.
 */
export interface GuardedRequest {
  readonly method: 'GET' | 'POST'
  readonly host: HostKey
  readonly path: string
  /** Serialised query string without a leading '?'. Empty when there is none. */
  readonly query: string
  /** Serialised request body, or null. */
  readonly body: string | null
  readonly signing: SigningScheme
  /** Request weight against the per-IP budget, for the rate limiter. Defaults to 1. */
  readonly weight?: number
  /**
   * Weight against the *account* budget, where the exchange keeps a second one.
   *
   * Binance's SAPI endpoints are metered twice, and the two figures are not comparable: reading
   * deposits costs 1 IP weight, reading withdrawals costs 18,000 UID weight out of 180,000 a
   * minute. Folding that into `weight` would either exhaust an IP budget that was never touched or
   * let a handful of requests blow the UID budget unnoticed, so the two are counted apart.
   */
  readonly uidWeight?: number
}

/**
 * The response, with the body as raw text.
 *
 * Deliberately not parsed: CoinDCX returns JSON floats for several endpoints, and by the time
 * `JSON.parse` has returned, the digits are already gone.
 */
export interface GuardedResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
}

export interface GuardedHttp {
  send(request: GuardedRequest): Promise<GuardedResponse>
}
