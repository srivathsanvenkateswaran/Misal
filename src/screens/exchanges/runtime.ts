/**
 * Everything this screen does to the outside world, in one place so a test can stand in for it.
 *
 * The same seam `ImportRuntime` and `SettingsRuntime` use, for the same reason: the screen is then
 * driven end to end in a test without a Tauri runtime, and — since `tests/setup.ts` installs a
 * socket guard that fails any test which reaches for the network — without any possibility of a
 * real exchange being contacted with a real key.
 *
 * Nothing here decides anything. `connect` and `sync` are `src/data/sync.ts` verbatim, which is
 * itself the seam onto `src/adapters/` and the Rust core; the screen's job is to ask, to show what
 * came back, and to keep the secret out of everything in between.
 *
 * **One command in here does not exist in the core yet**: `exchange_disconnect_account`. See
 * `DISCONNECT_COMMAND` below. Until it is added, disconnecting fails loudly and the screen says
 * that the key is still in the keychain, which is the truth. It does not report a success it did
 * not have.
 */

import { invoke } from '@tauri-apps/api/core'
import { ADAPTER_IDS, type ProgressReporter, type ProviderId, type SyncOutcome } from '@adapters/index'
import { listAccounts, listInstruments, listPositions } from '../../data/client'
import {
  KeychainVault,
  connectExchangeAccount,
  syncExchangeAccount,
  type ConnectResult,
} from '../../data/sync'

/**
 * The command that removes a stored exchange credential.
 *
 * Deleting the `credential_ref` row without deleting the keychain entry would leave a live API key
 * in the user's keychain that Misal no longer lists and no longer shows — a quiet security failure
 * rather than a visible bug, which `src-tauri/src/secrets.rs` already names in the doc comment on
 * `delete_secret`. So disconnect is one command in the core, not a sequence issued from here: the
 * frontend has no path to the keychain and must not be given one.
 */
export const DISCONNECT_COMMAND = 'exchange_disconnect_account'

/** One connected exchange account, as the list needs it. */
export interface ConnectionView {
  readonly accountId: string
  readonly providerId: ProviderId
  readonly label: string
  readonly baseCurrency: string
  readonly capability: 'ledger' | 'snapshot'
  /** Whether a credential is stored. Answered by the core; never a plaintext read. */
  readonly credentialStored: boolean
  /**
   * The `as_of` of the most recent balance set committed for this account.
   *
   * Deliberately not called "last sync". `exchange_account_state.last_synced_at` is written by the
   * sync and is not exposed by any read command, so this is the latest *data* the account carries
   * rather than the last time Misal spoke to the exchange. A sync that failed before committing
   * anything does not move it, and the screen says so rather than implying a clock it cannot read.
   */
  readonly balancesAsOf: string | null
}

export interface ConnectRequest {
  /**
   * The account this key is for. The id of the account already connected to this exchange when
   * there is one — a new key for an exchange Misal already knows is a *replacement*, and minting a
   * fresh id for it would leave the old account's balances standing beside the new one's, each the
   * newest row for its own instruments and both counted. The core has the final say; see
   * `ConnectResult.accountId`.
   */
  readonly accountId: string
  readonly providerId: ProviderId
  readonly label: string
  readonly credential: { readonly apiKey: string; readonly apiSecret: string }
  readonly acknowledgedRisk: boolean
}

export interface ExchangeRuntime {
  listConnections: () => Promise<readonly ConnectionView[]>
  /** id → display name, for the coverage table. Coverage rows carry instrument ids only. */
  instrumentNames: () => Promise<ReadonlyMap<string, string>>
  /** Answers with the account the credential was filed under, which is the one to sync. */
  connect: (request: ConnectRequest) => Promise<ConnectResult>
  sync: (
    accountId: string,
    providerId: ProviderId,
    onProgress: ProgressReporter,
  ) => Promise<SyncOutcome>
  disconnect: (accountId: string) => Promise<void>
  /**
   * A id for an exchange Misal has never seen a key for. Injected so a test is deterministic and
   * the screen never reaches for a generator directly.
   *
   * Only ever called on a *first* connect. A uuid cannot collide with an existing row, so calling
   * it for a key that replaces another is precisely how one account becomes two.
   */
  newAccountId: () => string
  now: () => Date
}

export function isProviderId(value: string): value is ProviderId {
  return (ADAPTER_IDS as readonly string[]).includes(value)
}

async function loadConnections(): Promise<readonly ConnectionView[]> {
  const [accounts, positions] = await Promise.all([listAccounts(), listPositions()])

  const latest = new Map<string, string>()
  for (const row of positions) {
    const held = latest.get(row.accountId)
    // ISO dates, so a lexical comparison is a chronological one and no date is parsed to do it.
    if (held === undefined || row.asOf > held) latest.set(row.accountId, row.asOf)
  }

  const exchanges = accounts.filter((account) => isProviderId(account.providerId))
  return Promise.all(
    exchanges.map(async (account): Promise<ConnectionView> => {
      const providerId = account.providerId as ProviderId
      const vault = new KeychainVault({
        id: account.id,
        providerId,
        label: account.label,
        baseCurrency: account.baseCurrency,
      })
      return {
        accountId: account.id,
        providerId,
        label: account.label,
        baseCurrency: account.baseCurrency,
        capability: account.capability,
        credentialStored: await vault.hasStoredCredential(account.id),
        balancesAsOf: latest.get(account.id) ?? null,
      }
    }),
  )
}

export function defaultRuntime(): ExchangeRuntime {
  return {
    listConnections: () => loadConnections(),
    instrumentNames: async () =>
      new Map((await listInstruments()).map((row) => [row.id, row.displayName])),
    connect: (request) =>
      connectExchangeAccount({
        accountId: request.accountId,
        providerId: request.providerId,
        credential: request.credential,
        label: request.label,
        acknowledgedRisk: request.acknowledgedRisk,
      }),
    sync: (accountId, providerId, onProgress) =>
      syncExchangeAccount({ accountId, providerId, onProgress }),
    disconnect: (accountId) => invoke(DISCONNECT_COMMAND, { accountId }),
    newAccountId: () => crypto.randomUUID(),
    now: () => new Date(),
  }
}
