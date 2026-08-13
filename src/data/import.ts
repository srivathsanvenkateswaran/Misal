/**
 * The write half of the IPC boundary: a SQLite-backed `IngestionStore`.
 *
 * `src/data/client.ts` reads rows out of the Rust core; this module puts an import in. It is the
 * only implementation of `IngestionStore` that touches a real database — the pipeline and its
 * tests run against `MemoryStore`, which enforces the same constraints — so nothing here decides
 * anything. Every judgement about what to write was already made in `src/ingestion/`.
 *
 * **Numeric fields are strings on both sides, in both directions.** The read path casts every
 * INTEGER money column to TEXT on the way out; on the way in, the minor-unit string is parsed to
 * an integer in Rust. Nothing in this file parses a `Minor` or a `Dec` into a JavaScript number,
 * and there is no arithmetic here at all.
 *
 * **A transaction is buffered, not held open.** `IngestionStore.transaction` gives the pipeline a
 * writer and promises that a throw rolls everything back. Implementing that as BEGIN and COMMIT
 * commands around a series of IPC round trips would hold a SQLite write transaction open across an
 * unbounded number of them, and a webview that reloads mid-import would leave the database locked
 * in a transaction nobody will ever close. Instead the writer collects the rows and one
 * `ingest_commit` applies them in a single Rust-side transaction: if the work throws, nothing was
 * ever sent, which is a stronger guarantee than a rollback.
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  AccountRow,
  AliasRow,
  AliasScheme,
  ImportIssueRow,
  ImportRunRow,
  IngestionStore,
  IngestionWriter,
  InstrumentRow,
  PositionRow,
  SourceDocumentRow,
  TxnRow,
  UnresolvedInstrumentRow,
} from '@ingestion/store'
import type { Capability } from '@ingestion/types'

/** One account whose capability an already-stored account row is being moved to. */
export interface CapabilityUpdate {
  readonly accountId: string
  readonly capability: Capability
}

/**
 * Everything one import writes, in one payload.
 *
 * Grouped by table rather than kept as an ordered op log, because the commit order is a property
 * of the schema's foreign keys rather than of the order the pipeline happened to call the writer.
 */
export interface ImportBatch {
  /**
   * Absent for a re-import, which writes its rows into the `source_document` already recorded for
   * these bytes. See `runImport`: a file whose rows were withheld for want of an identifier is
   * imported again once it has one, and a second document row for the same bytes would both
   * violate `content_hash` uniqueness and misstate provenance.
   */
  document: SourceDocumentRow | null
  accounts: AccountRow[]
  capabilityUpdates: CapabilityUpdate[]
  aliases: AliasRow[]
  txns: TxnRow[]
  positions: PositionRow[]
  unresolved: UnresolvedInstrumentRow[]
  run: ImportRunRow | null
  issues: ImportIssueRow[]
}

export function emptyBatch(): ImportBatch {
  return {
    document: null,
    accounts: [],
    capabilityUpdates: [],
    aliases: [],
    txns: [],
    positions: [],
    unresolved: [],
    run: null,
    issues: [],
  }
}

/**
 * The writer handed to `IngestionStore.transaction`.
 *
 * Records rather than writes. A second `insertSourceDocument` or `insertImportRun` in one
 * transaction is a pipeline bug rather than a user-visible condition, so it throws here where it
 * is cheap to notice instead of arriving at SQLite as a confusing constraint failure.
 */
export class BufferedWriter implements IngestionWriter {
  readonly batch: ImportBatch = emptyBatch()

  insertSourceDocument(row: SourceDocumentRow): Promise<void> {
    if (this.batch.document !== null) {
      throw new Error('one import writes exactly one source_document')
    }
    this.batch.document = row
    return Promise.resolve()
  }

  insertAccount(row: AccountRow): Promise<void> {
    this.batch.accounts.push(row)
    return Promise.resolve()
  }

  updateAccountCapability(accountId: string, capability: Capability): Promise<void> {
    this.batch.capabilityUpdates.push({ accountId, capability })
    return Promise.resolve()
  }

  insertAlias(row: AliasRow): Promise<void> {
    this.batch.aliases.push(row)
    return Promise.resolve()
  }

  insertTxn(row: TxnRow): Promise<void> {
    this.batch.txns.push(row)
    return Promise.resolve()
  }

  upsertPosition(row: PositionRow): Promise<void> {
    this.batch.positions.push(row)
    return Promise.resolve()
  }

  insertUnresolvedInstrument(row: UnresolvedInstrumentRow): Promise<void> {
    this.batch.unresolved.push(row)
    return Promise.resolve()
  }

  insertImportRun(row: ImportRunRow): Promise<void> {
    if (this.batch.run !== null) throw new Error('one import writes exactly one import_run')
    this.batch.run = row
    return Promise.resolve()
  }

  insertImportIssue(row: ImportIssueRow): Promise<void> {
    this.batch.issues.push(row)
    return Promise.resolve()
  }
}

/** The commands this store speaks. Injectable so the tests do not need a Tauri runtime. */
export type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const tauriInvoke: Invoker = (command, args) => invoke(command, args)

export class SqliteIngestionStore implements IngestionStore {
  private readonly call: Invoker

  constructor(call: Invoker = tauriInvoke) {
    this.call = call
  }

  // -- reads ---------------------------------------------------------------------------------

  findDocumentByHash(contentHash: string): Promise<SourceDocumentRow | null> {
    return this.call('ingest_find_document_by_hash', { contentHash })
  }

  findAccountByIdentityKey(identityKey: string): Promise<AccountRow | null> {
    return this.call('ingest_find_account_by_identity_key', { identityKey })
  }

  findInstrumentByIsin(isin: string): Promise<InstrumentRow | null> {
    return this.call('ingest_find_instrument_by_isin', { isin })
  }

  findAliasTarget(
    scheme: AliasScheme,
    value: string,
    providerId: string | null,
  ): Promise<string | null> {
    return this.call('ingest_find_alias_target', { scheme, value, providerId })
  }

  countTxnByNaturalKey(naturalKey: string): Promise<number> {
    return this.call('ingest_count_txn_by_natural_key', { naturalKey })
  }

  hasTxn(naturalKey: string, occurrence: number): Promise<boolean> {
    return this.call('ingest_has_txn', { naturalKey, occurrence })
  }

  findPosition(accountId: string, instrumentId: string, asOf: string): Promise<PositionRow | null> {
    return this.call('ingest_find_position', { accountId, instrumentId, asOf })
  }

  // -- writes --------------------------------------------------------------------------------

  insertSourceDocument(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertAccount(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  updateAccountCapability(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertAlias(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertTxn(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  upsertPosition(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertUnresolvedInstrument(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertImportRun(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }
  insertImportIssue(): Promise<void> {
    return Promise.reject(new Error('writes go through transaction()'))
  }

  /**
   * Collect the writes, then apply them in one SQLite transaction.
   *
   * A throw from `work` — a constraint the pipeline noticed, a normalizer that gave up, a
   * disconnected webview — leaves the database untouched because nothing has crossed the boundary
   * yet. A run with no import_run is a pipeline bug and is refused rather than committed
   * half-formed.
   *
   * A batch with no `source_document` is not: that is a re-import, writing into the document the
   * first pass recorded. What proves the document exists is `import_run.source_document_id`, which
   * is a foreign key, so a batch naming no document at all still cannot commit.
   */
  async transaction<T>(work: (writer: IngestionWriter) => Promise<T>): Promise<T> {
    const writer = new BufferedWriter()
    const result = await work(writer)
    const batch = writer.batch
    if (batch.run === null) {
      throw new Error('an import must write an import_run')
    }
    await this.call('ingest_commit', { batch })
    return result
  }
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

export interface PickedFile {
  /**
   * An opaque reference to a file the user chose in the native dialog.
   *
   * Not a path, and deliberately so. The core used to expose `read_statement_bytes(path)`, which
   * was `std::fs::read` on whatever the webview named — one call away from returning `~/.ssh/id_rsa`
   * to anything that could reach the IPC bridge. A handle can only be exchanged for a file the
   * picker returned, and the frontend never learns where on disk that is because it has no use for
   * it.
   */
  readonly handle: string
  readonly name: string
  readonly byteLength: number
}

/** The native picker. `null` means the user closed it, which is not an error. */
export const pickStatementFile = (call: Invoker = tauriInvoke): Promise<PickedFile | null> =>
  call('pick_statement_file')

/**
 * Read a file the user picked, by the handle the picker returned.
 *
 * Arrives as an ArrayBuffer rather than a JSON array of byte values, which for a multi-megabyte
 * statement would be an order of magnitude larger on the wire. The bytes are hashed and parsed in
 * memory; nothing is copied into Misal's storage.
 */
export async function readStatementBytes(
  handle: string,
  call: Invoker = tauriInvoke,
): Promise<Uint8Array> {
  const buffer = await call<ArrayBuffer | number[]>('read_statement_bytes', { handle })
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer)
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export interface UnresolvedEntryRow {
  readonly id: string
  readonly sourceDocumentId: string
  readonly accountId: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly assetClassHint: string | null
  readonly observedQuantity: string | null
  /** Minor units, as a string. The exact amount withheld from every total. */
  readonly observedValueMinor: string | null
  readonly currency: string | null
  readonly firstSeenAt: string
}

export interface MappingOutcome {
  /** The alias learned, when the identifier was one that can be aliased at all. */
  readonly aliasScheme: string | null
  /**
   * Queue entries this mapping answered, across every account that named the same identifier.
   *
   * Not "released". A mapping moves no money: the rows the import withheld are still not in the
   * ledger, so these entries go on withholding — and go on disclosing — exactly what they did
   * before. They close when a document carrying those rows is imported.
   */
  readonly matched: number
}

/**
 * What this document could not identify, and is still asking about.
 *
 * Scoped to the document, unlike the settings queue. Dismissed and mapped entries are absent: both
 * have been answered, and neither has put its value into a total, so both remain in
 * `list_unresolved` and in the withheld figure.
 */
export const unresolvedForDocument = (
  documentId: string,
  call: Invoker = tauriInvoke,
): Promise<UnresolvedEntryRow[]> => call('ingest_unresolved_for_document', { documentId })

/**
 * How many rows an already-imported document is still withholding from every total.
 *
 * What the review queue says about this document. Not, on its own, an answer about whether the file
 * should be read again: the queue keeps one open entry per identifier per account, shared by every
 * statement that named it, so a release earned by one document zeroes this for all of them.
 * `outstandingForDocument` is the per-document answer.
 */
export const withheldForDocument = (
  documentId: string,
  call: Invoker = tauriInvoke,
): Promise<number> => call('ingest_withheld_for_document', { documentId })

/**
 * Whether this document's own last import left rows it still owes the ledger.
 *
 * True means re-importing the file is not a no-op: it is the only way those rows reach the ledger.
 * Fed to `runImport` so the content-hash short-circuit can stand aside. Recorded per run rather
 * than inferred from the queue, which cannot answer for a document that shares its entry with
 * another statement, nor for a file whose parser threw before it reached half the folios in it.
 */
export const outstandingForDocument = (
  documentId: string,
  call: Invoker = tauriInvoke,
): Promise<boolean> => call('ingest_outstanding_for_document', { documentId })

/**
 * Map an unresolved identifier onto an instrument the user picked.
 *
 * Writes the alias, so the next statement resolves without asking again, and records the answer
 * against every queue entry naming the same identifier. It does not re-run the rows this import
 * withheld — the statement's own text is the only record of them and Misal never copies the file —
 * so the entry stays open and its `observedValueMinor` goes on being reported as withheld until a
 * document carrying those rows is imported. Importing the same file again does that, which is what
 * `withheldForDocument` exists to permit.
 */
export const mapUnresolvedInstrument = (
  unresolvedId: string,
  instrumentId: string,
  call: Invoker = tauriInvoke,
): Promise<MappingOutcome> => call('ingest_map_unresolved', { unresolvedId, instrumentId })

/**
 * Dismiss without mapping.
 *
 * The import report stops asking. Nothing else changes: the value stays withheld from every total,
 * the entry stays open in Settings → Review queue, and the withheld figure goes on stating it —
 * because the holding is every bit as absent from net worth as it was before the click.
 */
export const ignoreUnresolvedInstrument = (
  unresolvedId: string,
  call: Invoker = tauriInvoke,
): Promise<void> => call('ingest_ignore_unresolved', { unresolvedId })
