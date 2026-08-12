/**
 * The storage port.
 *
 * Subsystem A owns the SQLite transaction; ingestion owns the decision about what goes into it.
 * This interface is the seam between the two, expressed in the migration's column names so that
 * the mapping to SQL is mechanical and reviewable.
 *
 * Every numeric value crossing this boundary is a string, for the reason the core spec gives: a
 * JSON number is a double, and the IPC boundary is JSON.
 *
 * All methods are async because the real implementation is an IPC round trip. The in-memory
 * implementation used by the tests satisfies the same contract, including the uniqueness
 * constraints, so a violation shows up in a test rather than in a user's database.
 */

import type { Capability, TxnType } from './types'

export interface AccountRow {
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly externalRef: string | null
  readonly identityKey: string | null
  readonly capability: Capability
  readonly baseCurrency: string
  readonly createdAt: string
}

export interface InstrumentRow {
  readonly id: string
  readonly assetClass: string
  readonly displayName: string
  readonly isin: string | null
  readonly currency: string
}

export type AliasScheme = 'isin' | 'nse' | 'bse' | 'amfi' | 'ticker' | 'coingecko' | 'provider-local'

export interface AliasRow {
  readonly instrumentId: string
  readonly scheme: AliasScheme
  readonly value: string
  /** Non-null when scheme is 'provider-local'. */
  readonly providerId: string | null
}

export interface SourceDocumentRow {
  readonly id: string
  /** NULL for a document declaring more than one account; attribution lives on each row. */
  readonly accountId: string | null
  readonly providerId: string
  readonly kind: 'cas-pdf' | 'csv' | 'api-response'
  readonly contentHash: string
  readonly originalName: string
  readonly periodStart: string | null
  readonly periodEnd: string | null
  readonly importedAt: string
  readonly pageRef: string | null
}

export interface TxnRow {
  readonly id: string
  readonly accountId: string
  readonly instrumentId: string
  readonly type: TxnType
  readonly occurredAt: string
  readonly occurredTz: string | null
  readonly quantity: string
  readonly price: string | null
  readonly amountMinor: string | null
  readonly brokerageMinor: string
  readonly sttMinor: string
  readonly gstMinor: string
  readonly stampDutyMinor: string
  readonly otherFeesMinor: string
  readonly tdsMinor: string
  readonly currency: string
  readonly fxRate: string | null
  readonly sourceDocumentId: string
  readonly naturalKey: string
  readonly occurrence: number
  readonly authority: 'primary' | 'corroborating'
  readonly createdAt: string
}

export interface PositionRow {
  readonly id: string
  readonly accountId: string
  readonly instrumentId: string
  readonly quantity: string
  readonly asOf: string
  readonly sourceDocumentId: string
}

export interface UnresolvedInstrumentRow {
  readonly id: string
  readonly sourceDocumentId: string
  readonly accountId: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly assetClassHint: string | null
  readonly observedQuantity: string | null
  readonly observedValueMinor: string | null
  readonly currency: string | null
  readonly firstSeenAt: string
}

export interface ImportRunRow {
  readonly id: string
  readonly sourceDocumentId: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly status: 'running' | 'completed' | 'failed'
  readonly parserVersion: string
  readonly rowsRead: number
  readonly rowsCommitted: number
  readonly rowsDuplicate: number
  readonly rowsSkipped: number
  readonly rowsFailed: number
}

export interface ImportIssueRow {
  readonly id: string
  readonly importRunId: string
  readonly rowRef: string | null
  readonly severity: 'error' | 'warning'
  readonly code: string
  readonly message: string
  /** JSON, so a single row is re-runnable after a mapping fix. Never holds a password. */
  readonly rawPayload: string | null
  readonly resolution: 'open' | 'resolved' | 'ignored'
}

/** Reads used during resolve. Separated from writes because resolve must not write. */
export interface IngestionReader {
  findDocumentByHash(contentHash: string): Promise<SourceDocumentRow | null>
  /**
   * Look up an account by its realm-qualified identity key, ignoring provider_id.
   *
   * Ignoring the provider is the entire mechanism that stops one MF folio becoming two accounts
   * when it arrives in a CAMS statement and again in an NSDL eCAS. Net worth doubling is the
   * worst failure available to this product, and this lookup is where it is prevented.
   */
  findAccountByIdentityKey(identityKey: string): Promise<AccountRow | null>
  findInstrumentByIsin(isin: string): Promise<InstrumentRow | null>
  findAliasTarget(scheme: AliasScheme, value: string, providerId: string | null): Promise<string | null>
  /** How many rows already carry this natural key, whatever their occurrence. */
  countTxnByNaturalKey(naturalKey: string): Promise<number>
  hasTxn(naturalKey: string, occurrence: number): Promise<boolean>
  findPosition(accountId: string, instrumentId: string, asOf: string): Promise<PositionRow | null>
}

/** The writes, all of which happen inside one transaction owned by the implementation. */
export interface IngestionWriter {
  insertSourceDocument(row: SourceDocumentRow): Promise<void>
  insertAccount(row: AccountRow): Promise<void>
  updateAccountCapability(accountId: string, capability: Capability): Promise<void>
  insertAlias(row: AliasRow): Promise<void>
  insertTxn(row: TxnRow): Promise<void>
  upsertPosition(row: PositionRow): Promise<void>
  insertUnresolvedInstrument(row: UnresolvedInstrumentRow): Promise<void>
  insertImportRun(row: ImportRunRow): Promise<void>
  insertImportIssue(row: ImportIssueRow): Promise<void>
}

export interface IngestionStore extends IngestionReader, IngestionWriter {
  /** Runs `work` inside one transaction. A throw rolls everything back. */
  transaction<T>(work: (writer: IngestionWriter) => Promise<T>): Promise<T>
}
