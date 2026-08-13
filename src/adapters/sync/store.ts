/**
 * The narrow store surface a sync needs.
 *
 * An adapter never touches SQL; neither does the runner. Everything below maps one-to-one onto
 * the core schema, and the Rust data-access layer is its only production implementation. Two
 * shapes here are load-bearing rather than incidental:
 *
 *   `commitPositions` takes the whole balance set and is atomic. A partially written balance set
 *   is not incomplete, it is *wrong*: it understates net worth while looking complete. If the
 *   fetch fails halfway, nothing is written and yesterday's positions stand, visibly stale.
 *
 *   `commitTransactions` takes one page and returns how many were duplicates. Trades commit
 *   incrementally, because a partial trade history is merely incomplete and is resumable.
 */

import type { Dec, Minor } from '@domain/numeric'
import type { AdapterIssue, Iso8601, MarketSpec, ProviderId } from '../contract'
import type { InstrumentStore } from '../resolution/resolve'

export interface PositionRow {
  readonly instrumentId: string
  readonly quantity: Dec
}

export interface TxnRow {
  readonly accountId: string
  readonly instrumentId: string
  /**
   * A subset of the schema's `txn.type` CHECK.
   *
   * `transfer_in`/`transfer_out` are here because a deposit is not a purchase: the fold opens a
   * `transfer_in` as a lot whose cost is explicitly unknown, whereas a `buy` with a null price is a
   * purchase whose cost we merely failed to record. The two read identically in a quantity column
   * and completely differently in a cost-basis one.
   */
  readonly type: 'buy' | 'sell' | 'fee' | 'transfer_in' | 'transfer_out'
  readonly occurredAt: Iso8601
  /** Always null for exchange data: exchanges report epoch UTC and there is no original zone. */
  readonly occurredTz: null
  readonly quantity: Dec
  readonly price: Dec | null
  /**
   * Null for a crypto-quoted trade. `amount_minor` is an integer count of an ISO-4217 minor
   * unit, and USDT has neither an ISO code nor minor units; the value is derived from quantity
   * and price at valuation time instead.
   */
  readonly amountMinor: Minor | null
  readonly otherFeesMinor: Minor
  /** 'INR' for a fiat-quoted trade; 'X:USDT' for a crypto-quoted one. */
  readonly currency: string
  readonly sourceDocumentId: string
  /** The exchange's trade id, carried into the natural key. See natural-key.ts. */
  readonly externalId: string
  readonly naturalKey: string
  /** Distinguishes genuinely identical transactions within one document. */
  readonly occurrence: number
}

export interface DocumentRef {
  readonly id: string
  /**
   * True when this content hash was already stored. A repeated fetch is not an error; it is
   * idempotency working, so the runner reuses the existing id rather than raising.
   */
  readonly existed: boolean
}

export type RunStatus = 'completed' | 'failed'

export interface RunCounts {
  readonly rowsRead: number
  readonly rowsCommitted: number
  readonly rowsDuplicate: number
  readonly rowsFailed: number
}

export type SyncStatus = 'ok' | 'partial' | 'failed' | 'quarantined'

export interface SyncStore extends InstrumentStore {
  readCursor(accountId: string, stream: string, scope: string): Promise<string | null>
  writeCursor(
    accountId: string,
    stream: string,
    scope: string,
    cursor: string | null,
    meta: { lastSyncedAt: string; coverageNote?: string },
  ): Promise<void>

  upsertDocument(descriptor: {
    providerId: ProviderId
    accountId: string
    kind: 'api-response'
    contentHash: string
    pageRef: string
    periodStart?: string
    periodEnd?: string
  }): Promise<DocumentRef>

  startRun(documentId: string): Promise<string>
  finishRun(runId: string, status: RunStatus, counts: RunCounts): Promise<void>
  recordIssue(runId: string, issue: AdapterIssue): Promise<void>

  /** Atomic: every row for this `as_of`, or none. */
  commitPositions(
    accountId: string,
    asOf: string,
    rows: readonly PositionRow[],
    documentId: string,
  ): Promise<void>

  commitTransactions(
    rows: readonly TxnRow[],
  ): Promise<{ committed: number; duplicate: number }>

  /** Sum of transaction quantities per instrument, for the coverage check. */
  foldQuantities(accountId: string): Promise<ReadonlyMap<string, Dec>>

  readDiscoveredAssets(accountId: string): Promise<readonly string[]>
  addDiscoveredAssets(accountId: string, codes: readonly string[]): Promise<void>

  /** Cached at most daily. `asOfDate` lets the runner decide whether the cache is stale. */
  readMarkets(providerId: ProviderId, asOfDate: string): Promise<readonly MarketSpec[] | null>
  writeMarkets(
    providerId: ProviderId,
    asOfDate: string,
    markets: readonly MarketSpec[],
  ): Promise<void>

  /** Marks the account as needing the user, without deleting anything they hold. */
  setAccountStatus(accountId: string, status: SyncStatus, errorCode: string | null): Promise<void>

  /** So the account manager can show a key that has silently stopped being used. */
  touchCredential(accountId: string): Promise<void>
}
