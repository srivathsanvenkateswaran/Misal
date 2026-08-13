/**
 * The sync runner: the one code path both a first backfill and an incremental sync go down.
 *
 * Backfill is resumable by construction, because it *is* the incremental loop with a null
 * starting cursor. There is no separate backfill path and therefore no backfill-only bug class.
 *
 * Two orderings in here are the difference between a tracker you can trust and one you cannot:
 *
 *   Balances are fetched and committed before the trade crawl, so the user sees their net worth
 *   in seconds rather than after a 40,000-trade walk.
 *
 *   The watermark advances only after the transaction that commits its page has succeeded. A
 *   crash in between costs one re-fetched page, which the natural key makes a no-op. The reverse
 *   ordering loses a page forever, silently.
 */

import { type Dec, addDec } from '@domain/numeric'
import type {
  AcquiredPage,
  AdapterContext,
  AdapterIssue,
  ExchangeAdapter,
  MarketSpec,
  ProgressReporter,
  RawBalance,
  RawFill,
  ScopeReport,
  SourceDocumentDescriptor,
  SyncPhase,
} from '../contract'
import { AdapterError, isAdapterError } from '../errors'
import { createGuardedHttp, type Transport } from '../http'
import type { RateLimiter } from '../ratelimit'
import type { Catalogue } from '../resolution/catalogue'
import { resolveAsset } from '../resolution/resolve'
import { MeasuredClockOffset } from '../time'
import { QUOTE_ASSET_SENTINEL } from '../coindcx/adapter'
import { normalizeFill, withKeys, type UnkeyedTxnRow } from './normalize'
import { reconcileCoverage, type CoverageRow } from './reconcile'
import type { RunCounts, SyncStore } from './store'

const FILLS_STREAM = 'fills'
/** Neither v1 adapter partitions its cursor; the column exists for one that will. */
const UNPARTITIONED = '*'

export interface SyncOptions {
  readonly store: SyncStore
  readonly adapter: ExchangeAdapter
  readonly accountId: string
  readonly transport: Transport
  readonly limiter: RateLimiter
  readonly userAgent: string
  readonly now: () => Date
  readonly catalogue?: Catalogue
  /**
   * Called as the sync moves through its phases and as the adapter works through them.
   *
   * A first Binance sync sweeps a large symbol set one call at a time, which takes minutes; a
   * sync that says nothing for that long is indistinguishable from one that has hung.
   */
  readonly onProgress?: ProgressReporter
}

export interface SyncOutcome {
  /** 'quarantined' is not a failure of the sync; it is a refusal to run one. */
  readonly status: 'completed' | 'failed' | 'quarantined'
  /** True when something was committed but something else was not. */
  readonly partial: boolean
  readonly scope: ScopeReport | null
  readonly balancesCommitted: number
  readonly fillsCommitted: number
  readonly fillsDuplicate: number
  readonly rowsFailed: number
  readonly issues: readonly AdapterIssue[]
  readonly coverage: readonly CoverageRow[]
  readonly errorCode: string | null
}

export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { store, adapter, accountId } = options
  const issues: AdapterIssue[] = []
  const log = (issue: AdapterIssue): void => {
    issues.push(issue)
  }

  const report: ProgressReporter = options.onProgress ?? noProgress
  const phase = (name: SyncPhase, detail: string): void => {
    report({ phase: name, done: 0, total: null, detail })
  }

  const discovered = await store.readDiscoveredAssets(accountId)
  const http = createGuardedHttp({
    adapterId: adapter.id,
    accountId,
    allowlist: adapter.requestAllowlist,
    hosts: adapter.hosts,
    transport: options.transport,
    limiter: options.limiter,
    userAgent: options.userAgent,
  })

  const clock = new MeasuredClockOffset('0', async () => {
    const localBefore = options.now().getTime()
    const serverMs = await adapter.serverTime({ ...ctx, clock: { offsetMs: '0', resync: noop } })
    return { serverMs, localMs: `${BigInt(localBefore)}` }
  })

  const ctx: AdapterContext = {
    accountId,
    http,
    clock,
    discoveredAssets: discovered,
    log,
    report,
    now: options.now,
  }

  // 1. Scope, before anything else and before every sync, not only at connect. A user can widen
  //    a key's permissions on the exchange website at any time.
  let scope: ScopeReport
  phase('scope', `Checking what the ${adapter.displayName} key is allowed to do`)
  try {
    scope = await adapter.describeScope(ctx)
  } catch (error) {
    return failed(options, issues, error, null)
  }

  if (scope.canWithdraw === true) {
    // We do not delete their data, and we do not keep syncing.
    await store.setAccountStatus(accountId, 'quarantined', 'auth_over_scoped')
    return {
      status: 'quarantined',
      partial: false,
      scope,
      balancesCommitted: 0,
      fillsCommitted: 0,
      fillsDuplicate: 0,
      rowsFailed: 0,
      issues: [
        {
          severity: 'error',
          code: 'auth_over_scoped',
          message:
            'This API key can withdraw funds. Misal has stopped syncing this account and kept ' +
            'everything already imported. Create a key without withdrawal rights to resume.',
        },
      ],
      coverage: [],
      errorCode: 'auth_over_scoped',
    }
  }

  // 2. Clock, measured against the host we sign to.
  phase('clock', 'Checking the exchange clock')
  try {
    await clock.resync()
  } catch (error) {
    return failed(options, issues, error, scope)
  }

  // 3. Markets, cached at most daily.
  phase('markets', 'Loading the market catalogue')
  const today = options.now().toISOString().slice(0, 10)
  let markets: readonly MarketSpec[]
  try {
    const cached = await store.readMarkets(adapter.id, today)
    if (cached === null) {
      markets = await adapter.markets(ctx)
      await store.writeMarkets(adapter.id, today, markets)
    } else {
      markets = cached
    }
  } catch (error) {
    return failed(options, issues, error, scope)
  }

  const marketsBySymbol = new Map(markets.map((m) => [m.symbol, m]))
  const precisionByAsset = new Map<string, number>()
  for (const market of markets) {
    if (!precisionByAsset.has(market.base.code)) {
      precisionByAsset.set(market.base.code, market.quantityPrecision)
    }
  }

  // 4. Balances, committed atomically, before the trade crawl.
  let balancesCommitted = 0
  let balanceInstruments = new Map<string, Dec>()
  let balanceRunId: string | null = null
  let anythingCommitted = false
  let rowsFailed = 0
  let errorCode: string | null = null

  phase('balances', 'Reading balances')
  try {
    const page = await adapter.fetchBalances(ctx)
    const result = await commitBalances(options, page, precisionByAsset, issues)
    balancesCommitted = result.committed
    balanceInstruments = result.byInstrument
    balanceRunId = result.runId
    rowsFailed += result.failed
    anythingCommitted = result.committed > 0
    await store.addDiscoveredAssets(
      accountId,
      page.records.map((r) => r.asset.code),
    )
  } catch (error) {
    // Nothing was written: the previous day's positions stand, visibly stale, which is the
    // honest outcome. A half-written balance set would look complete and understate net worth.
    const failure = toAdapterError(error)
    errorCode = failure.code
    issues.push({
      severity: 'error',
      code: failure.code,
      message: failure.message,
      ...(failure.detail === undefined ? {} : { rawPayload: failure.detail }),
    })
    if (!failure.retryable && failure.code !== 'malformed_response') {
      return finish(options, {
        status: 'failed',
        scope,
        balancesCommitted: 0,
        fills: { committed: 0, duplicate: 0 },
        rowsFailed: rowsFailed + 1,
        issues,
        coverage: [],
        errorCode,
        anythingCommitted: false,
      })
    }
  }

  // 5. Fills, one committed transaction per page, watermark after each.
  const fillsCtx: AdapterContext = {
    ...ctx,
    discoveredAssets: await store.readDiscoveredAssets(accountId),
  }
  let fillsCommitted = 0
  let fillsDuplicate = 0

  phase('fills', 'Reading trade history')
  const startCursor = await store.readCursor(accountId, FILLS_STREAM, UNPARTITIONED)
  try {
    for await (const page of adapter.fetchFills(fillsCtx, startCursor, markets)) {
      if (page.records.length === 0) {
        // A checkpoint page: bookkeeping only, no document and no import run.
        await store.writeCursor(accountId, FILLS_STREAM, UNPARTITIONED, page.nextCursor, {
          lastSyncedAt: options.now().toISOString(),
        })
        continue
      }
      const result = await commitFillPage(options, page, marketsBySymbol, precisionByAsset, issues)
      fillsCommitted += result.committed
      fillsDuplicate += result.duplicate
      rowsFailed += result.failed
      anythingCommitted ||= result.committed > 0

      // Only now. A watermark ahead of committed data loses a page forever.
      await store.writeCursor(accountId, FILLS_STREAM, UNPARTITIONED, page.nextCursor, {
        lastSyncedAt: options.now().toISOString(),
        ...(adapter.coverageGaps.length > 0
          ? { coverageNote: adapter.coverageGaps.join(' ') }
          : {}),
      })
    }
  } catch (error) {
    const failure = toAdapterError(error)
    errorCode = failure.code
    rowsFailed += 1
    issues.push({
      severity: 'error',
      code: failure.code,
      message: failure.message,
      ...(failure.detail === undefined ? {} : { rawPayload: failure.detail }),
    })
  }

  // 6. Coverage. A mismatch between the fold and the reported balance is expected and is
  //    recorded as a warning, because measuring it is the evidence behind 'snapshot'.
  phase('coverage', 'Checking the transactions against the reported balances')
  const coverage = await reconcileCoverage(options.store, accountId, balanceInstruments)
  const coverageIssues: AdapterIssue[] = []
  for (const row of coverage) {
    if (row.matches) continue
    coverageIssues.push({
      severity: 'warning',
      code: 'coverage_gap',
      message:
        `Transactions for this holding add up to ${row.folded}, but the exchange reports ` +
        `${row.reported}. The difference of ${row.difference} came from activity Misal cannot ` +
        'see, so cost basis and returns are not shown for this account.',
      rowRef: row.instrumentId,
    })
  }
  for (const gap of options.adapter.coverageGaps) {
    coverageIssues.push({ severity: 'warning', code: 'coverage_note', message: gap })
  }
  issues.push(...coverageIssues)
  // Attached to the balance run, which is the one whose figures the fold was compared against.
  // Without a row in import_issue the gap would exist only in this return value and would be
  // gone by the time the user opened the import report.
  if (balanceRunId !== null) {
    for (const issue of coverageIssues) await store.recordIssue(balanceRunId, issue)
  }

  return finish(options, {
    status: errorCode === null ? 'completed' : 'failed',
    scope,
    balancesCommitted,
    fills: { committed: fillsCommitted, duplicate: fillsDuplicate },
    rowsFailed,
    issues,
    coverage,
    errorCode,
    anythingCommitted,
  })
}

// ---------------------------------------------------------------------------
// Commit steps
// ---------------------------------------------------------------------------

async function commitBalances(
  options: SyncOptions,
  page: AcquiredPage<RawBalance>,
  precisionByAsset: ReadonlyMap<string, number>,
  issues: AdapterIssue[],
): Promise<{
  committed: number
  failed: number
  byInstrument: Map<string, Dec>
  runId: string
}> {
  const { store, adapter, accountId } = options
  const descriptor = requireDocument(page.document)
  const document = await store.upsertDocument(descriptor)
  const runId = await store.startRun(document.id)

  const rows: { instrumentId: string; quantity: Dec }[] = []
  const byInstrument = new Map<string, Dec>()
  const pageIssues: AdapterIssue[] = []
  let failed = 0

  for (const balance of page.records) {
    const total = addDec(balance.free, balance.locked)
    const resolution = await resolveAsset(store, adapter.id, balance.asset.code, {
      ...(options.catalogue === undefined ? {} : { catalogue: options.catalogue }),
      ...(precisionByAsset.has(balance.asset.code)
        ? { precision: precisionByAsset.get(balance.asset.code) as number }
        : {}),
    })
    if (!resolution.resolved) {
      // Not an error: the value is withheld from totals and reportable, and the sync completes.
      await store.recordUnresolved({
        accountId,
        sourceDocumentId: document.id,
        rawIdentifier: balance.asset.code,
        rawName: null,
        assetClassHint: 'crypto',
        observedQuantity: total,
      })
      pageIssues.push({
        severity: 'warning',
        code: 'unresolved_instrument',
        message: `${balance.asset.code} is not in the crypto catalogue yet, so ${total} of it is ` +
          'excluded from your totals until you identify it.',
        rowRef: balance.asset.code,
      })
      failed += 1
      continue
    }
    rows.push({ instrumentId: resolution.instrumentId, quantity: total })
    byInstrument.set(resolution.instrumentId, total)
  }

  const asOf = options.now().toISOString().slice(0, 10)
  // All assets for this as_of, or none.
  await store.commitPositions(accountId, asOf, rows, document.id)

  const counts: RunCounts = {
    rowsRead: page.records.length,
    rowsCommitted: rows.length,
    rowsDuplicate: document.existed ? page.records.length : 0,
    rowsFailed: failed,
  }
  await store.finishRun(runId, 'completed', counts)
  for (const issue of pageIssues) {
    issues.push(issue)
    await store.recordIssue(runId, issue)
  }

  return { committed: rows.length, failed, byInstrument, runId }
}

async function commitFillPage(
  options: SyncOptions,
  page: AcquiredPage<RawFill>,
  marketsBySymbol: ReadonlyMap<string, MarketSpec>,
  precisionByAsset: ReadonlyMap<string, number>,
  issues: AdapterIssue[],
): Promise<{ committed: number; duplicate: number; failed: number }> {
  const { store, adapter, accountId } = options
  const descriptor = requireDocument(page.document)
  const document = await store.upsertDocument(descriptor)
  const runId = await store.startRun(document.id)

  const unkeyed: UnkeyedTxnRow[] = []
  let failed = 0

  for (const fill of page.records) {
    const market = marketsBySymbol.get(fill.symbol)
    if (market === undefined) {
      // Splitting the symbol by string manipulation instead would break on BTCUSDT vs BTCUSD.
      failed += 1
      const issue: AdapterIssue = {
        severity: 'error',
        code: 'unknown_market',
        message: `${fill.symbol} is not in the exchange's market catalogue, so this trade was ` +
          'not imported.',
        rowRef: fill.externalId,
      }
      issues.push(issue)
      await store.recordIssue(runId, issue)
      continue
    }

    const base = await resolveAsset(store, adapter.id, market.base.code, {
      ...(options.catalogue === undefined ? {} : { catalogue: options.catalogue }),
      precision: market.quantityPrecision,
    })
    if (!base.resolved) {
      await store.recordUnresolved({
        accountId,
        sourceDocumentId: document.id,
        rawIdentifier: market.base.code,
        rawName: null,
        assetClassHint: 'crypto',
        observedQuantity: fill.quantity,
      })
      failed += 1
      continue
    }

    const feeAssetCode =
      fill.fee === undefined
        ? null
        : fill.fee.asset.code === QUOTE_ASSET_SENTINEL
          ? market.quote.code
          : fill.fee.asset.code
    let feeInstrumentId: string | null = null
    if (feeAssetCode !== null) {
      const fee = await resolveAsset(store, adapter.id, feeAssetCode, {
        ...(options.catalogue === undefined ? {} : { catalogue: options.catalogue }),
        ...(precisionByAsset.has(feeAssetCode)
          ? { precision: precisionByAsset.get(feeAssetCode) as number }
          : {}),
      })
      feeInstrumentId = fee.resolved ? fee.instrumentId : null
    }

    unkeyed.push(
      ...normalizeFill({
        accountId,
        fill: feeAssetCode === null || fill.fee === undefined
          ? fill
          : { ...fill, fee: { amount: fill.fee.amount, asset: { code: feeAssetCode } } },
        market,
        baseInstrumentId: base.instrumentId,
        feeInstrumentId,
        sourceDocumentId: document.id,
      }),
    )
  }

  const rows = await withKeys(unkeyed)
  const { committed, duplicate } = await store.commitTransactions(rows)

  await store.finishRun(runId, 'completed', {
    rowsRead: page.records.length,
    rowsCommitted: committed,
    rowsDuplicate: duplicate,
    rowsFailed: failed,
  })

  return { committed, duplicate, failed }
}

// ---------------------------------------------------------------------------
// Outcome plumbing
// ---------------------------------------------------------------------------

interface FinishInput {
  status: 'completed' | 'failed'
  scope: ScopeReport | null
  balancesCommitted: number
  fills: { committed: number; duplicate: number }
  rowsFailed: number
  issues: AdapterIssue[]
  coverage: readonly CoverageRow[]
  errorCode: string | null
  anythingCommitted: boolean
}

async function finish(options: SyncOptions, input: FinishInput): Promise<SyncOutcome> {
  // 'failed' is reserved for a sync that committed nothing. A sync that committed at least one
  // page is 'completed' with a non-zero rows_failed and an issue per failed unit, which is the
  // core spec's "partial imports commit, with failures surfaced and individually re-runnable".
  const partial = input.anythingCommitted && input.errorCode !== null
  const status = input.anythingCommitted ? 'completed' : input.status

  await options.store.setAccountStatus(
    options.accountId,
    status === 'failed' ? 'failed' : partial ? 'partial' : 'ok',
    input.errorCode,
  )
  if (status === 'completed') await options.store.touchCredential(options.accountId)

  return {
    status,
    partial,
    scope: input.scope,
    balancesCommitted: input.balancesCommitted,
    fillsCommitted: input.fills.committed,
    fillsDuplicate: input.fills.duplicate,
    rowsFailed: input.rowsFailed,
    issues: input.issues,
    coverage: input.coverage,
    errorCode: input.errorCode,
  }
}

async function failed(
  options: SyncOptions,
  issues: AdapterIssue[],
  error: unknown,
  scope: ScopeReport | null,
): Promise<SyncOutcome> {
  const failure = toAdapterError(error)
  issues.push({
    severity: 'error',
    code: failure.code,
    message: failure.message,
    ...(failure.detail === undefined ? {} : { rawPayload: failure.detail }),
  })
  await options.store.setAccountStatus(options.accountId, 'failed', failure.code)
  return {
    status: 'failed',
    partial: false,
    scope,
    balancesCommitted: 0,
    fillsCommitted: 0,
    fillsDuplicate: 0,
    rowsFailed: 1,
    issues,
    coverage: [],
    errorCode: failure.code,
  }
}

function toAdapterError(error: unknown): AdapterError {
  if (isAdapterError(error)) return error
  return new AdapterError('network', 'The sync could not finish.', {
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}

function requireDocument(document: SourceDocumentDescriptor | null): SourceDocumentDescriptor {
  if (document === null) {
    throw new AdapterError('malformed_response', 'An adapter returned records without a document.')
  }
  return document
}

function noop(): Promise<void> {
  return Promise.resolve()
}

function noProgress(): void {
  // A caller that does not want progress still gets a working sync.
}
