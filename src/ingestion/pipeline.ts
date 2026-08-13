/**
 * The pipeline: acquire -> extract -> normalize -> resolve -> reconcile -> commit.
 *
 * Only `extract` is provider-specific. Everything a contributor would otherwise reimplement —
 * decryption, layout reconstruction, numeric canonicalisation, instrument resolution,
 * deduplication, error collection, the import report — is here, once.
 *
 * Two failure granularities, and the difference between them is the product's most visible
 * promise:
 *
 *   - **Document level** kills the import and returns a typed error. A document that never
 *     decrypted writes no `source_document` at all, because writing one would burn the
 *     content_hash uniqueness and permanently block re-importing the file with the right
 *     password.
 *   - **Row level** never kills anything. The row becomes an `import_issue` carrying enough JSON
 *     to replay it, the run still reaches `completed`, and the rest of the file commits.
 */

import { DEFAULT_CSV_HINT, decodeCsv, detectKind, distinctHints } from './acquire'
import type { DocumentCode } from './codes'
import { DOCUMENT_MESSAGE } from './codes'
import { parseDate } from './dates'
import { sha256Hex } from './hash'
import { DocumentFailure, IssueCollector, type Issue } from './issues'
import { CollectingSink, type ExtractPlugin, selectPlugin } from './plugin'
import { normalizeRecord } from './normalize'
import { reconstructDocument } from './pdf/layout'
import { assertSupportedDocument } from './pdf/reject'
import {
  GENERIC_PASSWORD_HINT,
  type PasswordHint,
  type PasswordPrompt,
  type PdfSource,
  assertNotScanned,
  openPdf,
} from './pdf/source'
import {
  UnresolvedQueue,
  resolveAccount,
  resolveInstrument,
  type ResolvedAccount,
} from './resolve'
import { reconcileTransactions } from './reconcile'
import type {
  AliasRow,
  IngestionStore,
  IngestionWriter,
  PositionRow,
  SourceDocumentRow,
  TxnRow,
} from './store'
import type {
  DecodedInput,
  NormalizedAccount,
  NormalizedPosition,
  NormalizedTransaction,
  ReconciledTransaction,
  ResolvedPosition,
  SourceKind,
} from './types'

export interface ImportRequest {
  readonly bytes: Uint8Array
  readonly originalName: string
  /**
   * Asked only if the file turns out to be encrypted. Absent means "do not prompt", which yields
   * E_PASSWORD_REQUIRED rather than a hang.
   */
  readonly password?: PasswordPrompt
  /**
   * Which provider the user said they were importing, so the password prompt can be worded
   * correctly. The format cannot be detected before decryption, so this cannot be derived — the
   * import screen already asks, because the request instructions are per provider.
   */
  readonly passwordHint?: PasswordHint
}

export interface ImportDeps {
  readonly store: IngestionStore
  readonly plugins: readonly ExtractPlugin[]
  readonly now: () => string
  readonly newId: () => string
  readonly pdfSource?: PdfSource
  /** Recorded on the run so a parser fix can find the imports it invalidates. */
  readonly parserVersion?: string
  /**
   * How many rows an already-imported document is still withholding from every total.
   *
   * The content hash makes an import idempotent, which is right for a file whose rows all landed
   * and wrong for one whose rows did not. An import whose instruments could not be identified
   * writes zero `txn` rows and a `source_document` carrying the hash, so once the user maps the
   * identifier the queue asked about, re-importing the same file — the only way those rows can
   * reach the ledger — was refused forever. Where this reports rows still withheld, the file is
   * read again into the document it already has.
   *
   * Absent means the short-circuit always wins, which is the behaviour a caller with no way to ask
   * should get.
   */
  readonly withheldFor?: (documentId: string) => Promise<number>
}

export interface ImportCounters {
  readonly read: number
  readonly committed: number
  readonly duplicate: number
  readonly skipped: number
  readonly failed: number
  /** Part of `skipped`: rows held back because their instrument is not yet identified. */
  readonly withheld: number
}

export type ImportOutcome =
  | {
      readonly status: 'already-imported'
      readonly contentHash: string
      readonly documentId: string
      readonly importedAt: string
    }
  | {
      readonly status: 'failed'
      readonly contentHash: string
      readonly code: DocumentCode
      readonly message: string
    }
  | {
      readonly status: 'completed'
      readonly contentHash: string
      readonly documentId: string
      readonly runId: string
      readonly pluginId: string
      readonly counters: ImportCounters
      readonly issues: readonly Issue[]
      readonly accountIds: readonly string[]
      /**
       * True when this run read a file the database had already seen, to release rows it withheld.
       * No second `source_document` was written; the rows landed against the one already recorded.
       */
      readonly reimported: boolean
    }

/**
 * Import one file.
 *
 * Files are imported one at a time, each its own run. Ordering does not matter, because the
 * natural key is order-independent.
 */
export async function runImport(request: ImportRequest, deps: ImportDeps): Promise<ImportOutcome> {
  const contentHash = await sha256Hex(request.bytes)

  // Document-level idempotency. Not an error, and deliberately no import_run: nothing happened.
  //
  // Except where the document is still withholding rows. Then nothing happening is the problem:
  // those rows are absent from every total, mapping their identifier does not write them, and this
  // file is the only place they exist. It is read again, into the document it already has.
  const seen = await deps.store.findDocumentByHash(contentHash)
  if (seen !== null) {
    const stillWithheld = deps.withheldFor === undefined ? 0 : await deps.withheldFor(seen.id)
    if (stillWithheld === 0) {
      return {
        status: 'already-imported',
        contentHash,
        documentId: seen.id,
        importedAt: seen.importedAt,
      }
    }
  }

  try {
    return await importDecoded(request, deps, contentHash, seen)
  } catch (error) {
    if (error instanceof DocumentFailure) {
      return { status: 'failed', contentHash, code: error.code, message: error.message }
    }
    throw error
  }
}

async function importDecoded(
  request: ImportRequest,
  deps: ImportDeps,
  contentHash: string,
  existing: SourceDocumentRow | null,
): Promise<ImportOutcome> {
  const kind = detectKind(request.bytes, request.originalName)
  const inputs = await decode(request, deps, kind)
  const match = selectPlugin(deps.plugins, inputs, kind)
  const plugin = match.plugin

  const issues = new IssueCollector()
  const sink = new CollectingSink()
  let crashed: string | null = null
  try {
    await plugin.extract(match.input, sink)
  } catch (error) {
    // A plugin that throws is a bug, but not a fatal one: whatever it emitted before the throw is
    // real data with real provenance, and discarding it would be the silent loss the design
    // forbids.
    crashed = error instanceof Error ? error.message : String(error)
  }

  for (const raw of sink.issues) {
    issues.add({
      severity: raw.severity,
      code: raw.code,
      message: raw.message,
      ...(raw.ref !== undefined ? { ref: raw.ref } : {}),
      ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
    })
  }
  if (crashed !== null) {
    issues.add({
      severity: 'error',
      code: 'E_PLUGIN_CRASH',
      message: `${plugin.id}: ${crashed}`,
    })
  }

  // -- normalize ----------------------------------------------------------------------------
  const accounts: NormalizedAccount[] = []
  const transactions: NormalizedTransaction[] = []
  const positions: NormalizedPosition[] = []
  let failed = issues
    .all()
    .filter((i) => i.severity === 'error' && i.code !== 'E_PLUGIN_CRASH' && i.raw !== undefined).length

  for (const record of sink.records) {
    const before = issues.count('error')
    for (const normalized of normalizeRecord(record, (issue) => issues.add(issue))) {
      if (normalized.kind === 'account') accounts.push(normalized)
      else if (normalized.kind === 'transaction') transactions.push(normalized)
      else positions.push(normalized)
    }
    failed += issues.count('error') - before
  }

  // -- resolve ------------------------------------------------------------------------------
  const now = deps.now()
  const resolvedAccounts = new Map<string, ResolvedAccount>()
  for (const account of accounts) {
    const existing = resolvedAccounts.get(account.accountKey)
    if (existing !== undefined) continue
    const resolved = await resolveAccount(
      deps.store,
      account,
      plugin.providerId,
      now,
      deps.newId,
    )
    resolvedAccounts.set(account.accountKey, resolved)
    if (resolved.downgraded) {
      issues.add({
        severity: 'warning',
        code: 'W_CAPABILITY_DOWNGRADE',
        message: `${account.label} moved from ledger to snapshot because ${request.originalName} did not reconcile`,
        ref: account.origin.ref,
      })
    }
  }

  const queue = new UnresolvedQueue()
  const resolvedTransactions: (NormalizedTransaction & { accountId: string; instrumentId: string })[] = []
  const resolvedPositions: ResolvedPosition[] = []
  const provenAliases: AliasRow[] = []

  for (const txn of transactions) {
    const account = resolvedAccounts.get(txn.accountKey)
    if (account === undefined) {
      issues.add({
        severity: 'error',
        code: 'E_MISSING_REQUIRED_FIELD',
        message: `no account was declared for ${txn.accountKey}`,
        ref: txn.origin.ref,
        raw: txn.origin.raw,
      })
      failed += 1
      continue
    }
    const instrumentId = await resolveInstrument(deps.store, txn.instrument, plugin.providerId)
    if (instrumentId === null) {
      queue.addTransaction(txn, account.id)
      issues.add({
        severity: 'warning',
        code: 'W_UNRESOLVED_INSTRUMENT',
        message: `${txn.instrument.name} is not identified yet, so this row is withheld from totals`,
        ref: txn.origin.ref,
        raw: txn.origin.raw,
      })
      continue
    }
    provenAliases.push(...aliasesProvenBy(txn.instrument, instrumentId))
    resolvedTransactions.push({ ...txn, accountId: account.id, instrumentId })
  }

  for (const position of positions) {
    const account = resolvedAccounts.get(position.accountKey)
    if (account === undefined) {
      issues.add({
        severity: 'error',
        code: 'E_MISSING_REQUIRED_FIELD',
        message: `no account was declared for ${position.accountKey}`,
        ref: position.origin.ref,
        raw: position.origin.raw,
      })
      failed += 1
      continue
    }
    const instrumentId = await resolveInstrument(deps.store, position.instrument, plugin.providerId)
    if (instrumentId === null) {
      queue.addPosition(position, account.id)
      issues.add({
        severity: 'warning',
        code: 'W_UNRESOLVED_INSTRUMENT',
        message: `${position.instrument.name} is not identified yet, so this holding is withheld from totals`,
        ref: position.origin.ref,
        raw: position.origin.raw,
      })
      continue
    }
    provenAliases.push(...aliasesProvenBy(position.instrument, instrumentId))
    resolvedPositions.push({ ...position, accountId: account.id, instrumentId })
  }

  // -- reconcile ----------------------------------------------------------------------------
  const reconciled = await reconcileTransactions(deps.store, resolvedTransactions)
  for (const txn of reconciled) {
    if (txn.disposition === 'repeat-in-document') {
      issues.add({
        severity: 'warning',
        code: 'W_DUPLICATE_IN_DOCUMENT',
        message:
          `an identical ${txn.txnType} of ${txn.quantity.value} on ${txn.occurredDate} appears ` +
          `more than once in this file; both were kept`,
        ref: txn.origin.ref,
        raw: txn.origin.raw,
      })
    }
  }

  const positionPlans = await planPositions(deps, resolvedPositions, issues)

  // -- commit -------------------------------------------------------------------------------
  // A re-import writes its rows into the document already recorded for these bytes. Minting a
  // second id would burn the content_hash uniqueness on a file the user is importing precisely
  // because the first attempt held rows back.
  const documentId = existing?.id ?? deps.newId()
  const runId = deps.newId()
  const accountIds = [...resolvedAccounts.values()].map((a) => a.id)

  const committed =
    reconciled.filter((t) => t.disposition !== 'duplicate-in-db').length +
    positionPlans.filter((p) => p.action !== 'duplicate').length
  const duplicate =
    reconciled.filter((t) => t.disposition === 'duplicate-in-db').length +
    positionPlans.filter((p) => p.action === 'duplicate').length
  const withheld = queue.all().reduce((sum, entry) => sum + entry.rowCount, 0)
  const skipped = sink.skips.length + withheld
  const counters: ImportCounters = {
    read: committed + duplicate + skipped + failed,
    committed,
    duplicate,
    skipped,
    failed,
    withheld,
  }

  const period = normalizePeriod(sink)
  const document: SourceDocumentRow = {
    id: documentId,
    // One CAS names dozens of accounts, so a single nullable column cannot hold the attribution.
    // It lives on each txn and position row, which is where it is actually needed.
    accountId: accountIds.length === 1 ? (accountIds[0] as string) : null,
    providerId: plugin.providerId,
    kind: kind === 'cas-pdf' ? 'cas-pdf' : 'csv',
    contentHash,
    originalName: request.originalName,
    periodStart: period.start,
    periodEnd: period.end,
    importedAt: now,
    pageRef: pageRefOf(match.input),
  }

  await deps.store.transaction(async (writer: IngestionWriter) => {
    if (existing === null) await writer.insertSourceDocument(document)

    for (const account of resolvedAccounts.values()) {
      if (account.created) await writer.insertAccount(account.row)
      else if (account.capabilityChanged) {
        await writer.updateAccountCapability(account.id, account.row.capability)
      }
    }

    for (const alias of dedupeAliases(provenAliases)) {
      const existing = await deps.store.findAliasTarget(alias.scheme, alias.value, alias.providerId)
      // An alias pointing at a different instrument is not overwritten. The uniqueness constraint
      // exists so a wrong alias cannot be inserted twice; quietly repointing it would defeat that.
      if (existing === null) await writer.insertAlias(alias)
    }

    for (const txn of reconciled) {
      if (txn.disposition === 'duplicate-in-db') continue
      await writer.insertTxn(txnRowOf(txn, documentId, deps.newId(), now))
    }

    for (const plan of positionPlans) {
      if (plan.action === 'duplicate') continue
      await writer.upsertPosition({ ...plan.row, sourceDocumentId: documentId })
    }

    for (const entry of queue.all()) {
      const observed = UnresolvedQueue.observedValue(entry)
      await writer.insertUnresolvedInstrument({
        id: deps.newId(),
        sourceDocumentId: documentId,
        accountId: entry.accountId,
        rawIdentifier: entry.rawIdentifier,
        rawName: entry.rawName,
        assetClassHint: entry.assetClassHint,
        observedQuantity: entry.observedQuantity,
        observedValueMinor: observed,
        currency: entry.currency,
        firstSeenAt: now,
      })
    }

    await writer.insertImportRun({
      id: runId,
      sourceDocumentId: documentId,
      startedAt: now,
      finishedAt: deps.now(),
      // A partial import is a first-class outcome: completed, with a non-zero rows_failed.
      status: 'completed',
      parserVersion: deps.parserVersion ?? plugin.id,
      rowsRead: counters.read,
      rowsCommitted: counters.committed,
      rowsDuplicate: counters.duplicate,
      rowsSkipped: counters.skipped,
      rowsFailed: counters.failed,
    })

    for (const issue of issues.all()) {
      await writer.insertImportIssue({
        id: deps.newId(),
        importRunId: runId,
        rowRef: issue.ref ?? null,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        // The raw payload is what makes a single row re-runnable. It is the plugin's own record
        // of the source row and never contains a password, because the plugin never saw one.
        rawPayload: issue.raw === undefined ? null : JSON.stringify(issue.raw),
        resolution: 'open',
      })
    }
  })

  return {
    status: 'completed',
    contentHash,
    documentId,
    runId,
    pluginId: plugin.id,
    counters,
    issues: issues.all(),
    accountIds,
    reimported: existing !== null,
  }
}

// ---------------------------------------------------------------------------
// Acquire helpers
// ---------------------------------------------------------------------------

async function decode(
  request: ImportRequest,
  deps: ImportDeps,
  kind: SourceKind,
): Promise<DecodedInput[]> {
  if (kind === 'csv') {
    const hints = distinctHints(deps.plugins.flatMap((p) => p.decodeHints ?? [DEFAULT_CSV_HINT]))
    return hints.map((hint) => decodeCsv(request.bytes, hint))
  }

  const source = deps.pdfSource
  if (source === undefined) {
    throw new DocumentFailure('E_UNKNOWN_FORMAT', DOCUMENT_MESSAGE.E_UNKNOWN_FORMAT)
  }
  const opened = await openPdf(
    source,
    request.bytes,
    request.passwordHint ?? GENERIC_PASSWORD_HINT,
    request.password,
  )
  await assertNotScanned(opened.pdf)
  const pages = reconstructDocument(opened.pdf.pages)
  // Refused by name before any plugin runs, because both resemble a CAS closely enough that a
  // detector might claim one and then half-parse it.
  assertSupportedDocument(pages)
  return [{ kind: 'pdf-text', pages, meta: opened.pdf.meta }]
}

function pageRefOf(input: DecodedInput): string {
  if (input.kind === 'pdf-text') {
    return input.pages.length === 0 ? 'p.0' : `p.1-${String(input.pages.length)}`
  }
  return `r.${String(input.rows.length)}`
}

function normalizePeriod(sink: CollectingSink): { start: string | null; end: string | null } {
  const period = sink.period_
  if (period === null) return { start: null, end: null }
  const start =
    period.start === undefined ? null : parseDate(period.start, period.format, period.timezone)
  const end = period.end === undefined ? null : parseDate(period.end, period.format, period.timezone)
  return {
    start: start !== null && start.ok ? start.value.at : null,
    end: end !== null && end.ok ? end.value.at : null,
  }
}

// ---------------------------------------------------------------------------
// Commit helpers
// ---------------------------------------------------------------------------

interface PositionPlan {
  readonly action: 'insert' | 'restate' | 'duplicate'
  /** Everything but the source document, which does not have an id until commit. */
  readonly row: Omit<PositionRow, 'sourceDocumentId'>
}

/**
 * A position is a restatement of a fact, not an event.
 *
 * Re-importing the same statement is a no-op. A corrected statement for the same date is an
 * update — and it writes a warning naming both documents, because a holding changing under the
 * user without a word is exactly the silent behaviour the design forbids.
 */
async function planPositions(
  deps: ImportDeps,
  positions: readonly ResolvedPosition[],
  issues: IssueCollector,
): Promise<PositionPlan[]> {
  const plans: PositionPlan[] = []
  for (const position of positions) {
    const existing = await deps.store.findPosition(
      position.accountId,
      position.instrumentId,
      position.asOf,
    )
    const row: Omit<PositionRow, 'sourceDocumentId'> = {
      id: existing?.id ?? deps.newId(),
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      quantity: position.quantity.value,
      asOf: position.asOf,
    }
    if (existing === null) {
      plans.push({ action: 'insert', row })
      continue
    }
    if (existing.quantity === row.quantity) {
      plans.push({ action: 'duplicate', row })
      continue
    }
    issues.add({
      severity: 'warning',
      code: 'W_POSITION_RESTATED',
      message: `holding on ${position.asOfDate} changed from ${existing.quantity} to ${row.quantity}`,
      ref: position.origin.ref,
      raw: position.origin.raw,
    })
    plans.push({ action: 'restate', row })
  }
  return plans
}

function txnRowOf(
  txn: ReconciledTransaction,
  documentId: string,
  id: string,
  now: string,
): TxnRow {
  return {
    id,
    accountId: txn.accountId,
    instrumentId: txn.instrumentId,
    type: txn.txnType,
    occurredAt: txn.occurredAt,
    occurredTz: txn.occurredTz,
    quantity: txn.quantity.value,
    price: txn.price?.value ?? null,
    amountMinor: txn.amountMinor ?? null,
    brokerageMinor: txn.fees.brokerage,
    sttMinor: txn.fees.stt,
    gstMinor: txn.fees.gst,
    stampDutyMinor: txn.fees.stampDuty,
    otherFeesMinor: txn.fees.other,
    tdsMinor: txn.fees.tds,
    currency: txn.currency,
    fxRate: txn.fxRate?.value ?? null,
    sourceDocumentId: documentId,
    naturalKey: txn.naturalKey,
    occurrence: txn.occurrence,
    authority: txn.authority,
    createdAt: now,
  }
}

/**
 * Aliases the source proves.
 *
 * Only ever written for an instrument that already resolved, and only from identifiers printed on
 * the same row: an ISIN and an exchange symbol side by side is proof that they name the same
 * security. A provider-local code is never learned this way, because the row that carries it is
 * exactly the row that failed to resolve.
 */
function aliasesProvenBy(
  instrument: { isin?: string; symbol?: string; exchange?: 'NSE' | 'BSE' | 'NASDAQ' | 'NYSE' },
  instrumentId: string,
): AliasRow[] {
  const out: AliasRow[] = []
  if (instrument.isin !== undefined && instrument.isin !== '' && instrument.exchange !== undefined) {
    if (instrument.symbol !== undefined && instrument.symbol !== '') {
      const scheme = instrument.exchange === 'NSE' ? 'nse' : instrument.exchange === 'BSE' ? 'bse' : 'ticker'
      out.push({ instrumentId, scheme, value: instrument.symbol, providerId: null })
    }
  }
  return out
}

function dedupeAliases(aliases: readonly AliasRow[]): AliasRow[] {
  const seen = new Map<string, AliasRow>()
  for (const alias of aliases) {
    seen.set(`${alias.scheme} ${alias.value} ${alias.providerId ?? ''}`, alias)
  }
  return [...seen.values()]
}
