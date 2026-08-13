/**
 * The exchange sync, bound to the real core.
 *
 * `src/adapters/` decides what to fetch and what it means; `src-tauri/src/sync.rs` owns the
 * socket, the secret and the SQLite transaction. This module is the seam, and it is deliberately
 * mechanical: every method below is one command, and nothing here decides anything. The single
 * exception is `foldQuantities`, which sums in TypeScript because that is where the decimal
 * library lives - adding eighteen-decimal quantities in SQL would go through SQLite's REAL, which
 * is a float64, and the whole numeric design exists to stop exactly that.
 *
 * **The secret never crosses this boundary in the direction you would expect.** The API key and
 * secret go *in* once, to be staged in memory; nothing ever reads them back. The connect probe
 * signs with an opaque handle, and only `exchange_commit_credential` writes to the OS keychain -
 * so a key the scope check refuses is never stored, structurally rather than by convention.
 *
 * **Numeric fields are strings in both directions**, as everywhere else on this boundary. A JSON
 * number is an IEEE-754 double: a paise value beyond 2^53 would be silently rounded in transit and
 * an eighteen-decimal crypto quantity would lose its tail.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  createAdapter,
  runSync,
  USER_AGENT,
  type AdapterIssue,
  type MarketSpec,
  type ProgressReporter,
  type ProviderId,
  type ScopeReport,
  type SyncOutcome,
} from '@adapters/index'
import { signed } from '@adapters/binance/signing'
import { connectAccount, type ConnectOutcome, type CredentialVault } from '@adapters/connect'
import type { AdapterContext, GuardedResponse } from '@adapters/contract'
import { createGuardedHttp, type Transport, type TransportRequest } from '@adapters/http'
import { parseLossless, textOrNull } from '@adapters/lossless-json'
import { fixedClockOffset, MeasuredClockOffset } from '@adapters/time'
import type {
  DocumentRef,
  PositionRow,
  RunCounts,
  RunStatus,
  SyncStatus,
  SyncStore,
  TxnRow,
} from '@adapters/sync/store'
import type { InstrumentSpec, UnresolvedRecord } from '@adapters/resolution/resolve'
import { addDec, dec, ZERO_DEC, type Dec } from '@domain/numeric'
import type { Invoker } from './import'

const tauriInvoke: Invoker = (command, args) => invoke(command, args)

/** Where an exchange account's transactions and balances land. */
export interface ExchangeAccount {
  readonly id: string
  readonly providerId: ProviderId
  readonly label: string
  /** The account's reporting currency, not the currency any individual trade is quoted in. */
  readonly baseCurrency: string
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * The real transport: sign and send in the Rust core.
 *
 * `allowlist` and `hostUrl` are dropped rather than forwarded. The core keeps its own copy of
 * both and ignores anything the frontend sends, because a guard a compromised webview can widen
 * is not a guard - so sending them would only imply they mattered.
 *
 * `adapterId` and `accountId` are both forwarded and both are checked *against each other* over
 * there: the core reads the account's exchange from its own `account` table and refuses to sign
 * with a credential belonging to a different one. Nothing here can make that pair agree - an
 * adapter names its own id and receives the account id it was given - which is precisely why the
 * check lives on the other side of the boundary.
 */
export function createExchangeTransport(call: Invoker = tauriInvoke): Transport {
  return {
    send(request: TransportRequest): Promise<GuardedResponse> {
      return call<GuardedResponse>('exchange_send', {
        request: {
          adapterId: request.adapterId,
          accountId: request.accountId,
          host: request.host,
          method: request.method,
          path: request.path,
          query: request.query,
          body: request.body,
          signing: request.signing,
          userAgent: request.userAgent,
          credentialHandle: request.credentialHandle ?? null,
        },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Who an exchange account *is*, as opposed to which key currently opens it.
 *
 * An API key is a credential naming an account, not the account itself, and a user who rotates one
 * - which Misal's own sync report tells them to do when a key gains withdrawal permission - still
 * holds the same coins afterwards. Written into `account.identity_key`, whose unique index is what
 * turns that sentence into something the database enforces rather than something the connect
 * screen has to remember.
 *
 * `accountRef` is the exchange's own id for the account where the exchange will say. Binance will:
 * `uid` on `GET /api/v3/account`, already on both allowlists and already documented there as being
 * read for `permissions` and `uid`. CoinDCX will not, anywhere in its three allowlisted endpoints,
 * so its accounts are keyed on the exchange alone - one CoinDCX account per database. That is a
 * real limitation rather than an oversight and it is written down in docs/known-issues.md.
 */
export function exchangeIdentity(providerId: ProviderId, accountRef: string | null): string {
  return accountRef === null ? `exchange:${providerId}` : `exchange:${providerId}:uid:${accountRef}`
}

/**
 * Asks the exchange which account a staged key belongs to, or `null` if it will not say.
 *
 * Takes the staging handle rather than a credential: the probe has to run *before* the secret is
 * written, so it signs the way the connect probe does, with a handle that the core can sign with
 * and nothing can read back.
 */
export type IdentityProbe = (handle: string) => Promise<string | null>

/**
 * The OS keychain, reached only through the core.
 *
 * `stage` is memory-only and `commit` is the sole path to disk, which is what makes "nothing was
 * written on refusal" a property of the shape of this class rather than a promise about the order
 * its methods happen to be called in.
 */
export class KeychainVault implements CredentialVault {
  private readonly account: ExchangeAccount
  private readonly call: Invoker
  private readonly identify: IdentityProbe | null
  private filedUnder: string | null = null

  constructor(
    account: ExchangeAccount,
    call: Invoker = tauriInvoke,
    identify: IdentityProbe | null = null,
  ) {
    this.account = account
    this.call = call
    this.identify = identify
  }

  /**
   * The account the core actually filed the credential under, once `commit` has run.
   *
   * Not always the id that was asked for: a key that replaces another lands on the account that
   * already holds its balances, and syncing the id we proposed instead would sync nothing. Read
   * through a field rather than returned, because `CredentialVault.commit` returns `void` and the
   * connect flow that calls it belongs to the adapters, which know nothing about account rows.
   */
  get committedAccountId(): string | null {
    return this.filedUnder
  }

  stage(credential: { apiKey: string; apiSecret: string }): Promise<string> {
    return this.call<string>('exchange_stage_credential', {
      apiKey: credential.apiKey,
      apiSecret: credential.apiSecret,
    })
  }

  /**
   * Write the credential and record the account that owns it.
   *
   * The account row is created here rather than earlier so that a refused connect leaves nothing
   * at all behind - not a secret, and not an empty account waiting to confuse the user. The
   * identity is settled here for the same reason and in the same breath: it is the thing that
   * decides *which* row, and asking afterwards would mean the row already existed.
   */
  async commit(handle: string, accountId: string): Promise<void> {
    const accountRef = this.identify === null ? null : await this.identify(handle)
    this.filedUnder = await this.call<string>('exchange_commit_credential', {
      handle,
      account: {
        id: accountId,
        providerId: this.account.providerId,
        label: this.account.label,
        baseCurrency: this.account.baseCurrency,
        identityKey: exchangeIdentity(this.account.providerId, accountRef),
      },
    })
  }

  discard(handle: string): Promise<void> {
    return this.call('exchange_discard_credential', { handle })
  }

  /** Answers whether anything is stored. Never returns plaintext. */
  hasStoredCredential(accountId: string): Promise<boolean> {
    return this.call<boolean>('exchange_has_credential', { accountId })
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface QuantityRow {
  readonly instrumentId: string
  readonly quantity: string
}

export class TauriSyncStore implements SyncStore {
  private readonly call: Invoker

  constructor(call: Invoker = tauriInvoke) {
    this.call = call
  }

  // -- instruments ---------------------------------------------------------

  findInstrumentByAlias(
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<string | null> {
    return this.call('sync_find_instrument_by_alias', { scheme, value, providerId })
  }

  createInstrument(spec: InstrumentSpec): Promise<string> {
    return this.call<string>('sync_create_instrument', { spec })
  }

  addAlias(
    instrumentId: string,
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<void> {
    return this.call('sync_add_alias', { instrumentId, scheme, value, providerId })
  }

  recordUnresolved(record: UnresolvedRecord): Promise<void> {
    return this.call('sync_record_unresolved', { record })
  }

  // -- documents and runs --------------------------------------------------

  upsertDocument(descriptor: {
    providerId: ProviderId
    accountId: string
    kind: 'api-response'
    contentHash: string
    pageRef: string
    periodStart?: string
    periodEnd?: string
  }): Promise<DocumentRef> {
    return this.call<DocumentRef>('sync_upsert_document', { descriptor })
  }

  startRun(documentId: string): Promise<string> {
    return this.call<string>('sync_start_run', { documentId })
  }

  finishRun(runId: string, status: RunStatus, counts: RunCounts): Promise<void> {
    return this.call('sync_finish_run', { runId, status, counts })
  }

  recordIssue(runId: string, issue: AdapterIssue): Promise<void> {
    return this.call('sync_record_issue', {
      runId,
      issue: {
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        rowRef: issue.rowRef ?? null,
        rawPayload: issue.rawPayload ?? null,
      },
    })
  }

  // -- data ----------------------------------------------------------------

  commitPositions(
    accountId: string,
    asOf: string,
    rows: readonly PositionRow[],
    documentId: string,
  ): Promise<void> {
    return this.call('sync_commit_positions', { accountId, asOf, rows, documentId })
  }

  commitTransactions(
    rows: readonly TxnRow[],
  ): Promise<{ committed: number; duplicate: number }> {
    return this.call('sync_commit_transactions', { rows })
  }

  /**
   * Fold the ingested transactions per instrument.
   *
   * Summed here rather than in SQL. `sum(quantity)` over a TEXT column makes SQLite coerce to
   * REAL, and a float64 cannot hold an eighteen-decimal quantity - the coverage check would then
   * report a gap that was created by the check itself.
   */
  async foldQuantities(accountId: string): Promise<ReadonlyMap<string, Dec>> {
    const rows = await this.call<QuantityRow[]>('sync_transaction_quantities', { accountId })
    const folded = new Map<string, Dec>()
    for (const row of rows) {
      folded.set(
        row.instrumentId,
        addDec(folded.get(row.instrumentId) ?? ZERO_DEC, dec(row.quantity)),
      )
    }
    return folded
  }

  // -- sync state ----------------------------------------------------------

  readCursor(accountId: string, stream: string, scope: string): Promise<string | null> {
    return this.call('sync_read_cursor', { accountId, stream, scope })
  }

  writeCursor(
    accountId: string,
    stream: string,
    scope: string,
    cursor: string | null,
    meta: { lastSyncedAt: string; coverageNote?: string },
  ): Promise<void> {
    return this.call('sync_write_cursor', {
      accountId,
      stream,
      scope,
      cursor,
      lastSyncedAt: meta.lastSyncedAt,
      coverageNote: meta.coverageNote ?? null,
    })
  }

  readDiscoveredAssets(accountId: string): Promise<readonly string[]> {
    return this.call<string[]>('sync_read_discovered_assets', { accountId })
  }

  addDiscoveredAssets(accountId: string, codes: readonly string[]): Promise<void> {
    return this.call('sync_add_discovered_assets', { accountId, codes })
  }

  async readMarkets(
    providerId: ProviderId,
    asOfDate: string,
  ): Promise<readonly MarketSpec[] | null> {
    const raw = await this.call<string | null>('sync_read_markets', { providerId, asOfDate })
    return raw === null ? null : (JSON.parse(raw) as MarketSpec[])
  }

  writeMarkets(
    providerId: ProviderId,
    asOfDate: string,
    markets: readonly MarketSpec[],
  ): Promise<void> {
    return this.call('sync_write_markets', {
      providerId,
      asOfDate,
      markets: JSON.stringify(markets),
    })
  }

  setAccountStatus(
    accountId: string,
    status: SyncStatus,
    errorCode: string | null,
  ): Promise<void> {
    return this.call('sync_set_account_status', { accountId, status, errorCode })
  }

  touchCredential(accountId: string): Promise<void> {
    return this.call('sync_touch_credential', { accountId })
  }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/**
 * Which Binance account a staged key belongs to, or `null` if Binance would not say this time.
 *
 * `GET /api/v3/account` is on the allowlist already - in both copies of it - and its comment there
 * has always said it is read for `permissions` and `uid` and never for scope, because its
 * `canTrade`/`canWithdraw` describe the *account* rather than the key. This reads it for the `uid`
 * and nothing else. The scope decision is still made where it was, from
 * `/sapi/v1/account/apiRestrictions`, by the adapter, before this ever runs.
 *
 * Every failure answers `null`. A rate limit, a network drop or a body shaped differently than
 * expected must not cost the user a connect: without a uid the account is keyed on the exchange
 * alone, which is weaker but still an identity, and the core refuses to overwrite a uid it already
 * knows with that weaker one.
 */
export async function binanceAccountRef(options: {
  readonly handle: string
  readonly accountId: string
  readonly call: Invoker
  readonly now: () => Date
}): Promise<string | null> {
  try {
    const { adapter, limiter } = createAdapter('binance')
    const http = createGuardedHttp({
      adapterId: adapter.id,
      accountId: options.accountId,
      allowlist: adapter.requestAllowlist,
      hosts: adapter.hosts,
      transport: createExchangeTransport(options.call),
      limiter,
      userAgent: USER_AGENT,
      credentialHandle: options.handle,
    })
    const base: Omit<AdapterContext, 'clock'> = {
      accountId: options.accountId,
      http,
      discoveredAssets: [],
      log: () => undefined,
      report: () => undefined,
      now: options.now,
    }

    // Measured rather than assumed, exactly as the connect probe does it: a signed request with a
    // drifted timestamp comes back as an auth failure, which here would silently mean "no uid".
    const clock = new MeasuredClockOffset('0', async () => ({
      serverMs: await adapter.serverTime({ ...base, clock: fixedClockOffset('0') }),
      localMs: `${BigInt(options.now().getTime())}`,
    }))
    await clock.resync()

    const response = await signed({ ...base, clock }, {
      method: 'GET',
      path: '/api/v3/account',
      // The balances are read from getUserAsset during the sync; this call wants one field.
      params: [['omitZeroBalances', 'true']],
      weight: 20,
    })
    const uid = textOrNull(parseLossless(response.text), 'uid')
    return uid === null || uid === '' ? null : uid
  } catch {
    return null
  }
}

/** The connect outcome, plus the account the credential was actually filed under. */
export type ConnectResult = ConnectOutcome & { readonly accountId: string }

export interface ConnectExchangeOptions {
  readonly accountId: string
  readonly providerId: ProviderId
  readonly credential: { readonly apiKey: string; readonly apiSecret: string }
  /** Shown in the account list. Defaults to the exchange's own name. */
  readonly label?: string
  /**
   * The user has been shown what this key can do and has accepted it. Required whenever the key
   * can trade or transfer, or whenever the exchange cannot say what it can do - which is every
   * CoinDCX key, since the exchange issues no read-only ones.
   */
  readonly acknowledgedRisk?: boolean
  readonly now?: () => Date
  readonly call?: Invoker
}

/**
 * Connect an exchange account: verify the key's permissions, then store it.
 *
 * The order is the point. A key that can withdraw is refused outright and the secret is never
 * written - no override, no "I understand" checkbox - because it is the only permission that can
 * move funds off the exchange and a tracker has no use for it. A key that can trade is stored only
 * after an explicit acknowledgement, because refusing that would mean refusing CoinDCX entirely.
 *
 * The scope report is recorded alongside the credential so the account manager can show what the
 * key can do after a restart, rather than only in the session that connected it.
 *
 * `accountId` on the result is the account the credential was filed under, which is the one to
 * sync. It differs from the one passed in whenever this key replaces another on an account that
 * already exists - which is the ordinary case for a key rotation, and the case in which syncing
 * the proposed id instead would leave the user looking at two of everything.
 */
export async function connectExchangeAccount(
  options: ConnectExchangeOptions,
): Promise<ConnectResult> {
  const call = options.call ?? tauriInvoke
  const now = options.now ?? (() => new Date())
  const { adapter, limiter } = createAdapter(options.providerId)
  const vault = new KeychainVault(
    {
      id: options.accountId,
      providerId: options.providerId,
      label: options.label ?? adapter.displayName,
      baseCurrency: adapter.baseCurrency,
    },
    call,
    options.providerId === 'binance'
      ? (handle) => binanceAccountRef({ handle, accountId: options.accountId, call, now })
      : null,
  )

  const outcome = await connectAccount({
    adapter,
    accountId: options.accountId,
    credential: options.credential,
    vault,
    transport: createExchangeTransport(call),
    limiter,
    userAgent: USER_AGENT,
    now,
    ...(options.acknowledgedRisk === undefined
      ? {}
      : { acknowledgedRisk: options.acknowledgedRisk }),
  })

  if (outcome.status === 'connected') {
    // The core's answer, not ours. Recording the scope against the id we proposed would file it
    // against an account that does not exist whenever this key replaced another.
    const accountId = vault.committedAccountId ?? options.accountId
    await recordScope(call, accountId, outcome.scope, options.acknowledgedRisk === true)
    return { ...outcome, accountId }
  }
  // Nothing was stored, so nothing was filed anywhere: the id is the one that was asked for.
  return { ...outcome, accountId: options.accountId }
}

function recordScope(
  call: Invoker,
  accountId: string,
  scope: ScopeReport,
  acknowledged: boolean,
): Promise<void> {
  return call('exchange_record_scope', {
    accountId,
    verification: scope.verification,
    // 'unknown' is a value here and is never rounded to false. Reporting "withdrawals disabled"
    // when we simply cannot see is false reassurance, which is worse than saying nothing.
    flags: JSON.stringify({
      canRead: scope.canRead,
      canTrade: scope.canTrade,
      canWithdraw: scope.canWithdraw,
      canTransferInternally: scope.canTransferInternally,
      ipRestricted: scope.ipRestricted,
    }),
    acknowledged,
  })
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

export interface SyncExchangeOptions {
  readonly accountId: string
  readonly providerId: ProviderId
  /**
   * Called as the sync works through its phases. A first Binance sync sweeps a large symbol set
   * one call at a time; without this it looks hung for minutes.
   */
  readonly onProgress?: ProgressReporter
  readonly now?: () => Date
  readonly call?: Invoker
}

/**
 * Run one sync: balances first, then trade history, then the coverage check.
 *
 * Balances before the trade crawl so the user sees their net worth in seconds rather than after a
 * forty-thousand-trade walk, and the watermark after each committed page so a crash costs one
 * re-fetched page rather than a lost one.
 */
export function syncExchangeAccount(options: SyncExchangeOptions): Promise<SyncOutcome> {
  const call = options.call ?? tauriInvoke
  const { adapter, limiter } = createAdapter(options.providerId)

  return runSync({
    store: new TauriSyncStore(call),
    adapter,
    accountId: options.accountId,
    transport: createExchangeTransport(call),
    limiter,
    userAgent: USER_AGENT,
    now: options.now ?? (() => new Date()),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
}
