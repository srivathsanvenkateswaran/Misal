/**
 * An in-memory SyncStore, standing in for the Rust data-access layer until it exists.
 *
 * It enforces the two constraints the sync semantics actually depend on, rather than pretending
 * to be a database:
 *
 *   the unique index on (natural_key, occurrence), so a duplicate insert is a no-op and the
 *   idempotency tests mean something;
 *
 *   the atomicity of a balance commit, so a failure part-way leaves the previous day's positions
 *   untouched.
 */

import type { Dec } from '@domain/numeric'
import { ZERO_DEC, addDec } from '@domain/numeric'
import type { AdapterIssue, MarketSpec, ProviderId } from '../contract'
import type { InstrumentSpec, UnresolvedRecord } from '../resolution/resolve'
import type {
  DocumentRef,
  PositionRow,
  RunCounts,
  RunStatus,
  SyncStatus,
  SyncStore,
  TxnRow,
} from '../sync/store'

interface StoredInstrument extends InstrumentSpec {
  readonly id: string
}

interface StoredAlias {
  readonly instrumentId: string
  readonly scheme: string
  readonly value: string
  readonly providerId: ProviderId | null
}

export interface StoredRun {
  readonly id: string
  readonly documentId: string
  status: RunStatus | 'running'
  counts: RunCounts | null
}

export class MemorySyncStore implements SyncStore {
  readonly instruments: StoredInstrument[] = []
  readonly aliases: StoredAlias[] = []
  readonly unresolved: UnresolvedRecord[] = []
  readonly documents = new Map<string, { id: string; pageRef: string }>()
  readonly runs: StoredRun[] = []
  readonly issues: { runId: string; issue: AdapterIssue }[] = []
  readonly transactions: TxnRow[] = []
  readonly positions: (PositionRow & { accountId: string; asOf: string; documentId: string })[] = []
  readonly cursors = new Map<string, { cursor: string | null; coverageNote?: string }>()
  readonly discovered = new Map<string, Set<string>>()
  readonly markets = new Map<string, readonly MarketSpec[]>()
  accountStatus: { status: SyncStatus; errorCode: string | null } | null = null
  readonly statusByAccount = new Map<string, SyncStatus>()
  /** The account whose credential was last marked as used. */
  credentialTouchedAt: string | null = null

  private sequence = 0

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  // -- instruments ---------------------------------------------------------

  findInstrumentByAlias(
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<string | null> {
    const found = this.aliases.find(
      (a) => a.scheme === scheme && a.value === value && a.providerId === providerId,
    )
    return Promise.resolve(found?.instrumentId ?? null)
  }

  createInstrument(spec: InstrumentSpec): Promise<string> {
    const id = this.nextId('instrument')
    this.instruments.push({ ...spec, id })
    return Promise.resolve(id)
  }

  addAlias(
    instrumentId: string,
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<void> {
    // PRIMARY KEY (scheme, value, provider_id): inserting the same alias twice is a no-op, not a
    // second row, and never a re-point to a different instrument.
    const clash = this.aliases.find(
      (a) => a.scheme === scheme && a.value === value && a.providerId === providerId,
    )
    if (clash === undefined) this.aliases.push({ instrumentId, scheme, value, providerId })
    return Promise.resolve()
  }

  recordUnresolved(record: UnresolvedRecord): Promise<void> {
    this.unresolved.push(record)
    return Promise.resolve()
  }

  // -- documents and runs --------------------------------------------------

  upsertDocument(descriptor: {
    contentHash: string
    pageRef: string
  }): Promise<DocumentRef> {
    const existing = this.documents.get(descriptor.contentHash)
    if (existing !== undefined) return Promise.resolve({ id: existing.id, existed: true })
    const id = this.nextId('document')
    this.documents.set(descriptor.contentHash, { id, pageRef: descriptor.pageRef })
    return Promise.resolve({ id, existed: false })
  }

  startRun(documentId: string): Promise<string> {
    const id = this.nextId('run')
    this.runs.push({ id, documentId, status: 'running', counts: null })
    return Promise.resolve(id)
  }

  finishRun(runId: string, status: RunStatus, counts: RunCounts): Promise<void> {
    const run = this.runs.find((r) => r.id === runId)
    if (run !== undefined) {
      run.status = status
      run.counts = counts
    }
    return Promise.resolve()
  }

  recordIssue(runId: string, issue: AdapterIssue): Promise<void> {
    this.issues.push({ runId, issue })
    return Promise.resolve()
  }

  // -- data ----------------------------------------------------------------

  /** Set by a test to make the commit throw part-way, proving nothing lands. */
  failPositionsAfter: number | null = null

  commitPositions(
    accountId: string,
    asOf: string,
    rows: readonly PositionRow[],
    documentId: string,
  ): Promise<void> {
    const staged: typeof this.positions = []
    for (const [index, row] of rows.entries()) {
      if (this.failPositionsAfter !== null && index >= this.failPositionsAfter) {
        // Nothing is written: the whole set commits or none of it does.
        return Promise.reject(new Error('balance commit failed part-way'))
      }
      staged.push({ ...row, accountId, asOf, documentId })
    }
    for (const row of staged) {
      const at = this.positions.findIndex(
        (p) => p.accountId === accountId && p.instrumentId === row.instrumentId && p.asOf === asOf,
      )
      if (at >= 0) this.positions[at] = row
      else this.positions.push(row)
    }
    return Promise.resolve()
  }

  commitTransactions(rows: readonly TxnRow[]): Promise<{ committed: number; duplicate: number }> {
    let committed = 0
    let duplicate = 0
    for (const row of rows) {
      const clash = this.transactions.some(
        (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
      )
      if (clash) duplicate += 1
      else {
        this.transactions.push(row)
        committed += 1
      }
    }
    return Promise.resolve({ committed, duplicate })
  }

  foldQuantities(accountId: string): Promise<ReadonlyMap<string, Dec>> {
    const folded = new Map<string, Dec>()
    for (const txn of this.transactions) {
      if (txn.accountId !== accountId) continue
      folded.set(txn.instrumentId, addDec(folded.get(txn.instrumentId) ?? ZERO_DEC, txn.quantity))
    }
    return Promise.resolve(folded)
  }

  // -- sync state ----------------------------------------------------------

  private cursorKey(accountId: string, stream: string, scope: string): string {
    return `${accountId}|${stream}|${scope}`
  }

  readCursor(accountId: string, stream: string, scope: string): Promise<string | null> {
    return Promise.resolve(this.cursors.get(this.cursorKey(accountId, stream, scope))?.cursor ?? null)
  }

  writeCursor(
    accountId: string,
    stream: string,
    scope: string,
    cursor: string | null,
    meta: { lastSyncedAt: string; coverageNote?: string },
  ): Promise<void> {
    this.cursors.set(this.cursorKey(accountId, stream, scope), {
      cursor,
      ...(meta.coverageNote === undefined ? {} : { coverageNote: meta.coverageNote }),
    })
    return Promise.resolve()
  }

  readDiscoveredAssets(accountId: string): Promise<readonly string[]> {
    return Promise.resolve([...(this.discovered.get(accountId) ?? [])])
  }

  addDiscoveredAssets(accountId: string, codes: readonly string[]): Promise<void> {
    const set = this.discovered.get(accountId) ?? new Set<string>()
    for (const code of codes) set.add(code)
    this.discovered.set(accountId, set)
    return Promise.resolve()
  }

  readMarkets(providerId: ProviderId, asOfDate: string): Promise<readonly MarketSpec[] | null> {
    return Promise.resolve(this.markets.get(`${providerId}|${asOfDate}`) ?? null)
  }

  writeMarkets(
    providerId: ProviderId,
    asOfDate: string,
    markets: readonly MarketSpec[],
  ): Promise<void> {
    this.markets.set(`${providerId}|${asOfDate}`, markets)
    return Promise.resolve()
  }

  setAccountStatus(accountId: string, status: SyncStatus, errorCode: string | null): Promise<void> {
    this.accountStatus = { status, errorCode }
    this.statusByAccount.set(accountId, status)
    return Promise.resolve()
  }

  touchCredential(accountId: string): Promise<void> {
    this.credentialTouchedAt = accountId
    return Promise.resolve()
  }
}

/**
 * A credential vault that records what reached the keychain and what only ever sat in memory.
 *
 * The over-scoped-key test asserts against `stored`, not against a return value: "nothing was
 * written" has to be checked by looking, or it is not a check.
 */
export class MemoryVault {
  readonly staged = new Map<string, { apiKey: string; apiSecret: string }>()
  readonly stored = new Map<string, string>()
  private sequence = 0

  stage(credential: { apiKey: string; apiSecret: string }): Promise<string> {
    this.sequence += 1
    const handle = `staged-${this.sequence}`
    this.staged.set(handle, credential)
    return Promise.resolve(handle)
  }

  commit(handle: string, accountId: string): Promise<void> {
    const credential = this.staged.get(handle)
    if (credential === undefined) throw new Error(`No staged credential: ${handle}`)
    this.stored.set(accountId, JSON.stringify(credential))
    this.staged.delete(handle)
    return Promise.resolve()
  }

  discard(handle: string): Promise<void> {
    this.staged.delete(handle)
    return Promise.resolve()
  }

  hasStoredCredential(accountId: string): Promise<boolean> {
    return Promise.resolve(this.stored.has(accountId))
  }
}
