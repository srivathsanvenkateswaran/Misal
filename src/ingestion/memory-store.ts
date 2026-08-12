/**
 * An in-memory IngestionStore.
 *
 * This is a reference implementation, not a test double: it enforces every uniqueness constraint
 * the migration declares, including the ones the pipeline depends on for idempotency. A rule that
 * only SQLite enforces is a rule the tests cannot see being broken, and the two constraints that
 * matter most here — `account.identity_key` and `(txn.natural_key, txn.occurrence)` — are exactly
 * the ones whose violation silently doubles a net worth.
 */

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
} from './store'
import type { Capability } from './types'

export class ConstraintViolation extends Error {
  override readonly name = 'ConstraintViolation'
}

interface Tables {
  documents: SourceDocumentRow[]
  accounts: AccountRow[]
  instruments: InstrumentRow[]
  aliases: AliasRow[]
  txns: TxnRow[]
  positions: PositionRow[]
  unresolved: UnresolvedInstrumentRow[]
  runs: ImportRunRow[]
  issues: ImportIssueRow[]
}

function emptyTables(): Tables {
  return {
    documents: [],
    accounts: [],
    instruments: [],
    aliases: [],
    txns: [],
    positions: [],
    unresolved: [],
    runs: [],
    issues: [],
  }
}

export class MemoryStore implements IngestionStore {
  private tables: Tables = emptyTables()

  // -- seeding, for tests and for the instrument catalogue the app ships ---------------------

  seedInstrument(row: InstrumentRow): void {
    if (row.isin !== null && this.tables.instruments.some((i) => i.isin === row.isin)) {
      throw new ConstraintViolation(`duplicate instrument isin ${row.isin}`)
    }
    this.tables.instruments.push(row)
  }

  seedAlias(row: AliasRow): void {
    this.insertAliasSync(row)
  }

  snapshot(): Readonly<Tables> {
    return this.tables
  }

  // -- reads ---------------------------------------------------------------------------------

  findDocumentByHash(contentHash: string): Promise<SourceDocumentRow | null> {
    return Promise.resolve(this.tables.documents.find((d) => d.contentHash === contentHash) ?? null)
  }

  findAccountByIdentityKey(identityKey: string): Promise<AccountRow | null> {
    return Promise.resolve(this.tables.accounts.find((a) => a.identityKey === identityKey) ?? null)
  }

  findInstrumentByIsin(isin: string): Promise<InstrumentRow | null> {
    return Promise.resolve(this.tables.instruments.find((i) => i.isin === isin) ?? null)
  }

  findAliasTarget(
    scheme: AliasScheme,
    value: string,
    providerId: string | null,
  ): Promise<string | null> {
    const hit = this.tables.aliases.find(
      (a) => a.scheme === scheme && a.value === value && a.providerId === providerId,
    )
    return Promise.resolve(hit?.instrumentId ?? null)
  }

  countTxnByNaturalKey(naturalKey: string): Promise<number> {
    return Promise.resolve(this.tables.txns.filter((t) => t.naturalKey === naturalKey).length)
  }

  hasTxn(naturalKey: string, occurrence: number): Promise<boolean> {
    return Promise.resolve(
      this.tables.txns.some((t) => t.naturalKey === naturalKey && t.occurrence === occurrence),
    )
  }

  findPosition(accountId: string, instrumentId: string, asOf: string): Promise<PositionRow | null> {
    const hit = this.tables.positions.find(
      (p) => p.accountId === accountId && p.instrumentId === instrumentId && p.asOf === asOf,
    )
    return Promise.resolve(hit ?? null)
  }

  // -- writes --------------------------------------------------------------------------------

  insertSourceDocument(row: SourceDocumentRow): Promise<void> {
    if (this.tables.documents.some((d) => d.contentHash === row.contentHash)) {
      throw new ConstraintViolation(`source_document.content_hash is not unique: ${row.contentHash}`)
    }
    this.tables.documents.push(row)
    return Promise.resolve()
  }

  insertAccount(row: AccountRow): Promise<void> {
    if (row.identityKey !== null && this.tables.accounts.some((a) => a.identityKey === row.identityKey)) {
      throw new ConstraintViolation(`account.identity_key is not unique: ${row.identityKey}`)
    }
    this.tables.accounts.push(row)
    return Promise.resolve()
  }

  updateAccountCapability(accountId: string, capability: Capability): Promise<void> {
    this.tables.accounts = this.tables.accounts.map((a) =>
      a.id === accountId ? { ...a, capability } : a,
    )
    return Promise.resolve()
  }

  insertAlias(row: AliasRow): Promise<void> {
    this.insertAliasSync(row)
    return Promise.resolve()
  }

  insertTxn(row: TxnRow): Promise<void> {
    if (this.tables.txns.some((t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence)) {
      throw new ConstraintViolation(
        `txn(natural_key, occurrence) is not unique: ${row.naturalKey}/${String(row.occurrence)}`,
      )
    }
    this.tables.txns.push(row)
    return Promise.resolve()
  }

  upsertPosition(row: PositionRow): Promise<void> {
    const index = this.tables.positions.findIndex(
      (p) => p.accountId === row.accountId && p.instrumentId === row.instrumentId && p.asOf === row.asOf,
    )
    if (index === -1) this.tables.positions.push(row)
    else this.tables.positions[index] = row
    return Promise.resolve()
  }

  insertUnresolvedInstrument(row: UnresolvedInstrumentRow): Promise<void> {
    this.tables.unresolved.push(row)
    return Promise.resolve()
  }

  insertImportRun(row: ImportRunRow): Promise<void> {
    this.tables.runs.push(row)
    return Promise.resolve()
  }

  insertImportIssue(row: ImportIssueRow): Promise<void> {
    this.tables.issues.push(row)
    return Promise.resolve()
  }

  /**
   * All-or-nothing, by copying the tables and restoring them on a throw.
   *
   * A partially applied import is the one outcome the storage layer must make impossible; the
   * pipeline's "partial import" means some rows failed to parse, never that some rows failed to
   * write.
   */
  async transaction<T>(work: (writer: IngestionWriter) => Promise<T>): Promise<T> {
    const saved: Tables = {
      documents: [...this.tables.documents],
      accounts: [...this.tables.accounts],
      instruments: [...this.tables.instruments],
      aliases: [...this.tables.aliases],
      txns: [...this.tables.txns],
      positions: [...this.tables.positions],
      unresolved: [...this.tables.unresolved],
      runs: [...this.tables.runs],
      issues: [...this.tables.issues],
    }
    try {
      return await work(this)
    } catch (error) {
      this.tables = saved
      throw error
    }
  }

  private insertAliasSync(row: AliasRow): void {
    const clash = this.tables.aliases.find(
      (a) => a.scheme === row.scheme && a.value === row.value && a.providerId === row.providerId,
    )
    if (clash !== undefined) {
      if (clash.instrumentId === row.instrumentId) return
      throw new ConstraintViolation(
        `instrument_alias(${row.scheme}, ${row.value}, ${row.providerId ?? 'null'}) already points elsewhere`,
      )
    }
    this.tables.aliases.push(row)
  }
}
