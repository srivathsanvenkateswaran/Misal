/**
 * The seam between the adapters and the core, exercised end to end.
 *
 * The core is faked, but only at the command boundary: every command below behaves the way
 * `src-tauri/src/sync.rs` behaves, and the store commands are routed to `MemorySyncStore`, which
 * enforces the two constraints the sync semantics actually depend on - the unique index on
 * (natural_key, occurrence), and the atomicity of a balance commit. The transport is the fixture
 * replayer, so no test here can open a socket; the guard installed from tests/setup.ts fails the
 * test if anything tries.
 */

import { describe, expect, it } from 'vitest'
import type { MarketSpec, SyncProgress } from '@adapters/contract'
import { MemorySyncStore } from '@adapters/testing/memory-store'
import { createReplayTransport, loadFixtures } from '@adapters/testing/replay-transport'
import type { TransportRequest } from '@adapters/http'
import type { Invoker } from './import'
import {
  connectExchangeAccount,
  createExchangeTransport,
  syncExchangeAccount,
  TauriSyncStore,
  type ExchangeAccount,
} from './sync'

const NOW = new Date('2026-08-12T10:00:00.000Z')
const CREDENTIAL = { apiKey: 'test-key-not-a-real-key', apiSecret: 'test-secret-not-a-real-secret' }

/**
 * Everything a full Binance sync fetches through the real registry.
 *
 * This list goes through `createAdapter`, so it exercises the *production* backfill window counts
 * rather than a test-shrunk one - which is the point: those counts are chosen so that a sync's
 * whole backfill fits inside one minute of Binance's account budget, and a fixture set that
 * completes without the limiter ever sleeping is what demonstrates it.
 */
const BINANCE_HAPPY = [
  'api-restrictions-read-only',
  'time',
  'exchange-info',
  'user-asset',
  'deposit-hisrec',
  'withdraw-history',
  'convert-tradeflow',
  'mytrades-btctusd-empty',
  'mytrades-btcusdt-page-1',
  'mytrades-btcusdt-page-2',
  // Both discovered by a transfer and a conversion rather than by any balance.
  'mytrades-ethbtc-empty',
  'mytrades-wbtcbtc-empty',
]

/**
 * The commands `src-tauri/src/sync.rs` exposes, in memory.
 *
 * `staged` and `stored` are separate on purpose, exactly as they are in the core: staging is
 * memory-only, and `exchange_commit_credential` is the only thing that reaches the keychain. The
 * over-scoped-key test asserts against `stored`, because "nothing was written" is only a check if
 * something looks.
 */
function fakeCore(exchange: 'binance' | 'coindcx', fixtures: readonly string[]) {
  const store = new MemorySyncStore()
  const staged = new Map<string, { apiKey: string; apiSecret: string }>()
  const stored = new Map<string, unknown>()
  const transport = createReplayTransport(loadFixtures(exchange), { only: [...fixtures] })
  const commands: { command: string; args: Record<string, unknown> }[] = []
  let sequence = 0

  async function route(command: string, args: Record<string, unknown>): Promise<unknown> {
    commands.push({ command, args })
    const arg = <T,>(name: string): T => args[name] as T

    switch (command) {
      // -- credentials ----------------------------------------------------
      case 'exchange_stage_credential': {
        sequence += 1
        const handle = `staged-${sequence}`
        staged.set(handle, { apiKey: arg('apiKey'), apiSecret: arg('apiSecret') })
        return handle
      }
      case 'exchange_discard_credential':
        staged.delete(arg<string>('handle'))
        return undefined
      case 'exchange_commit_credential': {
        const handle = arg<string>('handle')
        const credential = staged.get(handle)
        if (credential === undefined) throw new Error(`no staged credential ${handle}`)
        const account = arg<ExchangeAccount>('account')
        staged.delete(handle)
        stored.set(account.id, { account, credential })
        return undefined
      }
      case 'exchange_has_credential':
        return stored.has(arg<string>('accountId'))
      case 'exchange_record_scope':
        return undefined

      // -- transport ------------------------------------------------------
      case 'exchange_send': {
        const request = arg<TransportRequest>('request')
        // The core reads the account's exchange from its own tables before it touches a stored
        // credential, and refuses a request that names a different one - a signed request carries
        // the user's API key, and pinning the origin without pinning the credential would only
        // decide which third party receives the secret. Mirrored here so no test in this file can
        // pass while sending one exchange's key to another.
        const owner = stored.get(request.accountId) as { account: ExchangeAccount } | undefined
        if (owner !== undefined && owner.account.providerId !== request.adapterId) {
          throw new Error(
            `${request.adapterId} refused the request: account ${request.accountId} ` +
              `belongs to ${owner.account.providerId}, not ${request.adapterId}`,
          )
        }
        return transport.send(request)
      }

      // -- store ----------------------------------------------------------
      case 'sync_find_instrument_by_alias':
        return store.findInstrumentByAlias(arg('scheme'), arg('value'), arg('providerId'))
      case 'sync_create_instrument':
        return store.createInstrument(arg('spec'))
      case 'sync_add_alias':
        return store.addAlias(
          arg('instrumentId'),
          arg('scheme'),
          arg('value'),
          arg('providerId'),
        )
      case 'sync_record_unresolved':
        return store.recordUnresolved(arg('record'))
      case 'sync_upsert_document':
        return store.upsertDocument(arg('descriptor'))
      case 'sync_start_run':
        return store.startRun(arg('documentId'))
      case 'sync_finish_run':
        return store.finishRun(arg('runId'), arg('status'), arg('counts'))
      case 'sync_record_issue':
        return store.recordIssue(arg('runId'), arg('issue'))
      case 'sync_commit_positions':
        return store.commitPositions(
          arg('accountId'),
          arg('asOf'),
          arg('rows'),
          arg('documentId'),
        )
      case 'sync_commit_transactions':
        return store.commitTransactions(arg('rows'))
      case 'sync_transaction_quantities':
        // Unsummed, exactly as the core returns them: the fold is TypeScript's job.
        return store.transactions
          .filter((t) => t.accountId === arg<string>('accountId'))
          .map((t) => ({ instrumentId: t.instrumentId, quantity: t.quantity }))
      case 'sync_read_cursor':
        return store.readCursor(arg('accountId'), arg('stream'), arg('scope'))
      case 'sync_write_cursor':
        return store.writeCursor(arg('accountId'), arg('stream'), arg('scope'), arg('cursor'), {
          lastSyncedAt: arg('lastSyncedAt'),
        })
      case 'sync_read_discovered_assets':
        return store.readDiscoveredAssets(arg('accountId'))
      case 'sync_add_discovered_assets':
        return store.addDiscoveredAssets(arg('accountId'), arg('codes'))
      case 'sync_read_markets': {
        const markets = await store.readMarkets(arg('providerId'), arg('asOfDate'))
        // TEXT in SQLite, parsed on the way back in.
        return markets === null ? null : JSON.stringify(markets)
      }
      case 'sync_write_markets':
        return store.writeMarkets(
          arg('providerId'),
          arg('asOfDate'),
          JSON.parse(arg<string>('markets')) as MarketSpec[],
        )
      case 'sync_set_account_status':
        return store.setAccountStatus(arg('accountId'), arg('status'), arg('errorCode'))
      case 'sync_touch_credential':
        return store.touchCredential(arg('accountId'))
      default:
        throw new Error(`the core has no command ${command}`)
    }
  }

  const call = (<T,>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
    route(command, args) as Promise<T>) as Invoker

  const sent = (): TransportRequest[] =>
    commands
      .filter((c) => c.command === 'exchange_send')
      .map((c) => c.args['request'] as TransportRequest)

  return { call, store, staged, stored, commands, sent }
}

const names = (core: ReturnType<typeof fakeCore>): string[] =>
  core.commands.map((c) => c.command)

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

describe('connecting a key that can withdraw', () => {
  /**
   * The refusal that has no override.
   *
   * Asserted by looking at what the core was asked to store, not at what `connectExchangeAccount`
   * returned. The commit command must never be reached: the secret is staged in memory, the probe
   * signs with a handle, and the scope check aborts before anything is written.
   */
  it('is refused before the secret reaches the keychain', async () => {
    const core = fakeCore('binance', ['time', 'api-restrictions-withdrawals'])

    await expect(
      connectExchangeAccount({
        accountId: 'account-1',
        providerId: 'binance',
        credential: CREDENTIAL,
        now: () => NOW,
        call: core.call,
      }),
    ).rejects.toMatchObject({ code: 'auth_over_scoped' })

    expect(names(core)).toContain('exchange_stage_credential')
    expect(names(core)).not.toContain('exchange_commit_credential')
    expect(core.stored.size).toBe(0)
    // And nothing is left in memory either, so the handle cannot be committed later.
    expect(core.staged.size).toBe(0)
  })

  it('cannot be stored by acknowledging the risk', async () => {
    const core = fakeCore('binance', ['time', 'api-restrictions-withdrawals'])
    await expect(
      connectExchangeAccount({
        accountId: 'account-1',
        providerId: 'binance',
        credential: CREDENTIAL,
        acknowledgedRisk: true,
        now: () => NOW,
        call: core.call,
      }),
    ).rejects.toMatchObject({ code: 'auth_over_scoped' })
    expect(core.stored.size).toBe(0)
  })
})

describe('connecting a read-only key', () => {
  it('stores it, with the account it belongs to and what the key can do', async () => {
    const core = fakeCore('binance', ['time', 'api-restrictions-read-only'])
    const outcome = await connectExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      credential: CREDENTIAL,
      now: () => NOW,
      call: core.call,
    })

    expect(outcome.status).toBe('connected')
    expect(core.stored.has('account-1')).toBe(true)

    const scope = core.commands.find((c) => c.command === 'exchange_record_scope')
    expect(scope?.args['verification']).toBe('introspected')
    expect(JSON.parse(scope?.args['flags'] as string)).toMatchObject({ canWithdraw: false })
  })

  it('probes with a staged handle, never with a stored credential', async () => {
    const core = fakeCore('binance', ['time', 'api-restrictions-read-only'])
    await connectExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      credential: CREDENTIAL,
      now: () => NOW,
      call: core.call,
    })

    const signed = core.sent().filter((r) => r.signing !== 'none')
    expect(signed.length).toBeGreaterThan(0)
    expect(signed.every((r) => r.credentialHandle !== null)).toBe(true)
    // The handle is opaque. Neither the key nor the secret crosses back out of the core.
    expect(JSON.stringify(core.sent())).not.toContain(CREDENTIAL.apiSecret)
  })
})

describe('an exchange with no permission model', () => {
  it('is not stored until the user has accepted what its keys can do', async () => {
    const core = fakeCore('coindcx', ['markets-details'])
    const pending = await connectExchangeAccount({
      accountId: 'account-2',
      providerId: 'coindcx',
      credential: CREDENTIAL,
      now: () => NOW,
      call: core.call,
    })

    expect(pending.status).toBe('needs_acknowledgement')
    expect(core.stored.size).toBe(0)
    expect(names(core)).not.toContain('exchange_commit_credential')
  })
})

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

describe('the transport', () => {
  /**
   * The other half of "a request cannot choose its origin": it cannot choose its credential
   * either.
   *
   * `adapterId` and `accountId` travel in one object, so an adapter that named someone else's
   * account would have its request signed with that account's key and sent to its own host. With
   * CoinDCX as `account-1`, that is a trade-and-withdrawal credential - the exchange issues no
   * read-only keys - landing in Binance's request log. The core refuses it; this asserts the
   * refusal survives the seam rather than being swallowed into a generic failure.
   */
  it('cannot aim one exchange at another account credential', async () => {
    const core = fakeCore('binance', ['time', 'api-restrictions-read-only'])
    await connectExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      credential: CREDENTIAL,
      now: () => NOW,
      call: core.call,
    })

    // Through the seam this module owns, so the refusal is read verbatim rather than after the
    // adapter's http layer has folded it into a generic 'network' error.
    await expect(
      createExchangeTransport(core.call).send({
        adapterId: 'coindcx',
        accountId: 'account-1',
        allowlist: [],
        hostUrl: 'https://api.coindcx.com',
        host: 'primary',
        method: 'POST',
        path: '/exchange/v1/users/balances',
        query: '',
        body: '{"timestamp":1786528800000}',
        signing: 'coindcx-body',
        userAgent: 'Misal/0.1 (test)',
      }),
    ).rejects.toThrow(/account account-1 belongs to binance/)

    // And a whole sync driven at the wrong exchange gets nowhere.
    const outcome = await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'coindcx',
      now: () => NOW,
      call: core.call,
    })
    expect(outcome.status).toBe('failed')
    expect(core.store.transactions).toHaveLength(0)
  })

  it('does not hand the core an allowlist or a host of its own choosing', async () => {
    // A guard a compromised webview can widen is not a guard. The core keeps its own copy of
    // both and ignores anything sent from here, so sending them would only imply they mattered.
    const core = fakeCore('binance', ['time', 'api-restrictions-read-only'])
    await connectExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      credential: CREDENTIAL,
      now: () => NOW,
      call: core.call,
    })

    for (const request of core.sent()) {
      expect(request).not.toHaveProperty('allowlist')
      expect(request).not.toHaveProperty('hostUrl')
      // The host is named, not addressed: the core looks the URL up.
      expect(['primary', 'public']).toContain(request.host)
    }
  })
})

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

describe('a sync driven through the core', () => {
  it('commits balances before the trade crawl, then the fills', async () => {
    const core = fakeCore('binance', BINANCE_HAPPY)
    const outcome = await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      now: () => NOW,
      call: core.call,
    })

    expect(outcome.status).toBe('completed')
    expect(core.store.positions.length).toBeGreaterThan(0)
    expect(core.store.transactions.length).toBeGreaterThan(0)

    const order = names(core)
    expect(order.indexOf('sync_commit_positions')).toBeLessThan(
      order.indexOf('sync_commit_transactions'),
    )
    // The watermark is written only after the page that produced it committed.
    expect(order.indexOf('sync_commit_transactions')).toBeLessThan(
      order.lastIndexOf('sync_write_cursor'),
    )
    expect(names(core)).toContain('sync_touch_credential')
  })

  it('reports the coverage gap as a warning and names the Convert gap', async () => {
    const core = fakeCore('binance', BINANCE_HAPPY)
    const outcome = await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      now: () => NOW,
      call: core.call,
    })

    expect(outcome.coverage.some((row) => !row.matches)).toBe(true)
    const issues = outcome.issues.filter((i) => i.severity === 'warning')
    expect(issues.some((i) => i.code === 'coverage_gap')).toBe(true)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Convert trades never appear/)
    // Written, not merely returned: a gap that exists only in a return value is gone by the time
    // the user opens the import report.
    expect(core.store.issues.some((i) => i.issue.code === 'coverage_gap')).toBe(true)
  })

  it('says what it is doing, including how much of the symbol sweep is left', async () => {
    const updates: SyncProgress[] = []
    const core = fakeCore('binance', BINANCE_HAPPY)
    await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      onProgress: (update) => updates.push(update),
      now: () => NOW,
      call: core.call,
    })

    expect(updates.map((u) => u.phase)).toEqual(
      expect.arrayContaining(['scope', 'clock', 'markets', 'balances', 'fills', 'coverage']),
    )
    // The slow part of a first sync: `myTrades` needs a symbol and there is no cross-symbol
    // endpoint, so the sweep must be able to say "17 of 180" rather than nothing at all.
    const sweep = updates.filter((u) => u.phase === 'fills' && u.total !== null)
    expect(sweep.length).toBeGreaterThan(1)
    expect(sweep[sweep.length - 1]?.done).toBe(sweep[sweep.length - 1]?.total)
  })

  it('is incremental the second time, and commits no duplicates', async () => {
    const core = fakeCore('binance', BINANCE_HAPPY)
    const first = await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      now: () => NOW,
      call: core.call,
    })
    expect(first.fillsCommitted).toBeGreaterThan(0)
    const committed = core.store.transactions.length

    // The stored watermark is read back, so the resumed sync asks only for what follows it.
    const resumed = fakeCore('binance', [
      'api-restrictions-read-only',
      'time',
      'exchange-info',
      'user-asset',
      'mytrades-btcusdt-exhausted',
    ])
    const second = await syncExchangeAccount({
      accountId: 'account-1',
      providerId: 'binance',
      now: () => NOW,
      // Same store, fresh transport: this is the next sync, not a replay of the first.
      call: (command, args) =>
        command === 'exchange_send' ? resumed.call(command, args) : core.call(command, args),
    })

    expect(second.status).toBe('completed')
    expect(second.fillsCommitted).toBe(0)
    expect(core.store.transactions).toHaveLength(committed)
    const keys = core.store.transactions.map((t) => `${t.naturalKey}|${t.occurrence}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

describe('the coverage fold', () => {
  it('adds eighteen-decimal quantities exactly', async () => {
    // Summed here rather than in SQL: sum() over a TEXT column coerces to SQLite's REAL, and a
    // float64 would invent a coverage gap that is an artefact of the check itself.
    const rows = [
      { instrumentId: 'i-1', quantity: '0.000000000000000001' },
      { instrumentId: 'i-1', quantity: '42.000000000000000001' },
      { instrumentId: 'i-2', quantity: '-0.00030000000000' },
    ]
    const call = (<T,>(): Promise<T> => Promise.resolve(rows as T)) as Invoker
    const folded = await new TauriSyncStore(call).foldQuantities('account-1')

    expect(folded.get('i-1')).toBe('42.000000000000000002')
    expect(folded.get('i-2')).toBe('-0.0003')
  })
})
