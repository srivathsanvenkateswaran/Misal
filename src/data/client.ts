/**
 * The typed boundary between the Rust core and the frontend.
 *
 * Every command here returns rows and nothing else. Portfolio metrics are computed in
 * `src/valuation/`, not in SQL and not in Rust, so this module deliberately has no notion of net
 * worth, coverage or gains.
 *
 * **Numeric fields are strings on both sides of this boundary, always.** The Rust queries cast
 * every INTEGER money column to TEXT before serialising, because a JSON number is an IEEE-754
 * double: a paise value beyond 2^53 would be silently rounded in transit, and an eighteen-decimal
 * crypto quantity would lose its tail. The types below therefore say `string`, and callers must
 * pass them through `minor()` or `dec()` rather than parsing them.
 */

import { invoke } from '@tauri-apps/api/core'

export interface StorageStatus {
  readonly databasePath: string
  readonly schemaVersion: number
  readonly encrypted: boolean
  readonly accountCount: number
}

export interface AccountRow {
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly externalRef: string | null
  readonly identityKey: string | null
  readonly capability: 'ledger' | 'snapshot'
  readonly baseCurrency: string
  readonly createdAt: string
  /** Three-letter code the UI source stamp displays, e.g. 'CAS', 'KIT', 'DCX'. */
  readonly providerShortCode: string
}

export interface InstrumentRow {
  readonly id: string
  readonly assetClass: string
  readonly taxRegime: string | null
  readonly displayName: string
  readonly isin: string | null
  readonly currency: string
  readonly precision: number
  /** Fair market value on 31 Jan 2018 for LTCG grandfathering. The day's high, not its close. */
  readonly fmv31Jan2018: string | null
}

export interface AliasRow {
  readonly instrumentId: string
  readonly scheme: string
  readonly value: string
  readonly providerId: string | null
}

export interface TxnRow {
  readonly id: string
  readonly accountId: string
  readonly instrumentId: string
  readonly type: string
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

export interface PriceRow {
  readonly instrumentId: string
  readonly asOf: string
  readonly close: string
  readonly currency: string
  readonly source: 'amfi' | 'twelvedata' | 'yahoo' | 'coingecko' | 'manual'
  readonly fetchedAt: string
}

export interface FxRateRow {
  readonly base: string
  readonly quote: string
  readonly asOf: string
  readonly rate: string
  readonly source: string
}

export interface UnresolvedRow {
  readonly id: string
  readonly accountId: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly assetClassHint: string | null
  readonly observedQuantity: string | null
  /** Held so the UI can state the exact amount withheld from totals rather than estimating it. */
  readonly observedValueMinor: string | null
  readonly currency: string | null
  readonly firstSeenAt: string
}

export const storageStatus = (): Promise<StorageStatus> => invoke<StorageStatus>('storage_status')
export const listAccounts = (): Promise<AccountRow[]> => invoke<AccountRow[]>('list_accounts')
export const listInstruments = (): Promise<InstrumentRow[]> =>
  invoke<InstrumentRow[]>('list_instruments')
export const listAliases = (): Promise<AliasRow[]> => invoke<AliasRow[]>('list_aliases')
export const listTransactions = (): Promise<TxnRow[]> => invoke<TxnRow[]>('list_transactions')
export const listPositions = (): Promise<PositionRow[]> => invoke<PositionRow[]>('list_positions')
export const listPrices = (): Promise<PriceRow[]> => invoke<PriceRow[]>('list_prices')
export const listFxRates = (): Promise<FxRateRow[]> => invoke<FxRateRow[]>('list_fx_rates')
export const listUnresolved = (): Promise<UnresolvedRow[]> =>
  invoke<UnresolvedRow[]>('list_unresolved')

export const getSettings = async (): Promise<ReadonlyMap<string, string>> =>
  new Map(await invoke<[string, string][]>('get_settings'))

/** Everything the valuation engine needs, fetched together. */
export interface PortfolioRows {
  readonly accounts: readonly AccountRow[]
  readonly instruments: readonly InstrumentRow[]
  readonly aliases: readonly AliasRow[]
  readonly transactions: readonly TxnRow[]
  readonly positions: readonly PositionRow[]
  readonly prices: readonly PriceRow[]
  readonly fxRates: readonly FxRateRow[]
  readonly unresolved: readonly UnresolvedRow[]
  readonly settings: ReadonlyMap<string, string>
}

/**
 * Load every table the dashboard depends on, in one pass.
 *
 * Fetched together rather than per component so the whole screen renders one consistent view of
 * the database. Staggered fetches would let a total and its constituent rows disagree on screen
 * during an import, which for a net-worth figure reads as a bug rather than as loading.
 */
export async function loadPortfolioRows(): Promise<PortfolioRows> {
  const [
    accounts,
    instruments,
    aliases,
    transactions,
    positions,
    prices,
    fxRates,
    unresolved,
    settings,
  ] =
    await Promise.all([
      listAccounts(),
      listInstruments(),
      listAliases(),
      listTransactions(),
      listPositions(),
      listPrices(),
      listFxRates(),
      listUnresolved(),
      getSettings(),
    ])
  return {
    accounts,
    instruments,
    aliases,
    transactions,
    positions,
    prices,
    fxRates,
    unresolved,
    settings,
  }
}
