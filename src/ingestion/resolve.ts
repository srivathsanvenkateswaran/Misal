/**
 * Resolve — attach an account id and an instrument id, and queue what does not resolve.
 *
 * Two resolutions happen here and they fail in opposite directions on purpose. An unknown account
 * is *created*, because an account is just a container and the statement is authority enough for
 * one. An unknown instrument is *never* created and never guessed: it goes to the review queue
 * with the exact rupee value it withholds from totals, so the UI can say what is missing rather
 * than quietly reporting a smaller net worth.
 */

import { ZERO_MINOR, type Minor, addMinor, isZeroMinor, negMinor } from '@domain/numeric'
import type { AccountRow, AliasScheme, IngestionReader } from './store'
import type {
  Capability,
  NormalizedAccount,
  NormalizedPosition,
  NormalizedTransaction,
  RawInstrumentRef,
} from './types'

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface CapabilityDecision {
  readonly capability: Capability
  /** True when an existing `ledger` account was pulled down to `snapshot` by this document. */
  readonly downgraded: boolean
}

/**
 * Capability is monotonic upward, and a downgrade is never silent.
 *
 * A folio first seen in a Summary statement and later in a Detailed one is upgraded to `ledger`.
 * The reverse does not happen merely because a snapshot-only source mentions the same folio — an
 * NSDL eCAS naming a folio says nothing about whether the registrar's history is complete. Only a
 * document that *tried* to be a ledger and failed its own checks (`downgradedFrom`) may pull the
 * account down, and that always writes a warning naming the document.
 */
export function decideCapability(
  existing: Capability | null,
  declared: Capability,
  downgradedFrom: Capability | undefined,
): CapabilityDecision {
  if (existing === null) return { capability: declared, downgraded: false }
  if (declared === 'ledger') return { capability: 'ledger', downgraded: false }
  if (existing === 'ledger' && downgradedFrom === 'ledger') {
    return { capability: 'snapshot', downgraded: true }
  }
  return { capability: existing, downgraded: false }
}

export interface ResolvedAccount {
  readonly id: string
  readonly row: AccountRow
  readonly created: boolean
  readonly capabilityChanged: boolean
  readonly downgraded: boolean
}

/**
 * Resolve an account by its realm-qualified identity key, ignoring the provider entirely.
 *
 * The provider recorded on the row is whichever document created it first. That is deliberate:
 * the account is the folio, not the paperwork that described it.
 */
export async function resolveAccount(
  reader: IngestionReader,
  account: NormalizedAccount,
  providerId: string,
  now: string,
  newId: () => string,
): Promise<ResolvedAccount> {
  const existing = await reader.findAccountByIdentityKey(account.accountKey)
  const decision = decideCapability(
    existing?.capability ?? null,
    account.capability,
    account.downgradedFrom,
  )

  if (existing === null) {
    const row: AccountRow = {
      id: newId(),
      providerId,
      label: account.label,
      externalRef: account.externalRef,
      identityKey: account.accountKey,
      capability: decision.capability,
      baseCurrency: account.baseCurrency,
      createdAt: now,
    }
    return { id: row.id, row, created: true, capabilityChanged: false, downgraded: false }
  }

  return {
    id: existing.id,
    row: { ...existing, capability: decision.capability },
    created: false,
    capabilityChanged: decision.capability !== existing.capability,
    downgraded: decision.downgraded,
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * The resolution order from the core schema, stopping at the first hit.
 *
 * ISIN -> AMFI scheme code -> exchange+symbol -> provider-local alias. A symbol without an
 * exchange never matches, which is the entire point of the alias table's composite key: it keeps
 * E*TRADE's `INFY` (the US ADR) away from Zerodha's `INFY` (the NSE line).
 */
export async function resolveInstrument(
  reader: IngestionReader,
  ref: RawInstrumentRef,
  providerId: string,
): Promise<string | null> {
  if (ref.isin !== undefined && ref.isin !== '') {
    const instrument = await reader.findInstrumentByIsin(ref.isin)
    if (instrument !== null) return instrument.id
    const alias = await reader.findAliasTarget('isin', ref.isin, null)
    if (alias !== null) return alias
  }

  if (ref.amfiCode !== undefined && ref.amfiCode !== '') {
    const alias = await reader.findAliasTarget('amfi', ref.amfiCode, null)
    if (alias !== null) return alias
  }

  if (ref.exchange !== undefined && ref.symbol !== undefined && ref.symbol !== '') {
    const scheme = exchangeScheme(ref.exchange)
    const alias = await reader.findAliasTarget(scheme, ref.symbol, null)
    if (alias !== null) return alias
  }

  if (ref.providerLocalId !== undefined && ref.providerLocalId !== '') {
    const alias = await reader.findAliasTarget('provider-local', ref.providerLocalId, providerId)
    if (alias !== null) return alias
  }

  return null
}

function exchangeScheme(exchange: NonNullable<RawInstrumentRef['exchange']>): AliasScheme {
  switch (exchange) {
    case 'NSE':
      return 'nse'
    case 'BSE':
      return 'bse'
    case 'NASDAQ':
    case 'NYSE':
      // The schema has no per-US-exchange scheme, and a US ticker is unique across the two in
      // practice. `ticker` is the schema's own catch-all for exactly this.
      return 'ticker'
  }
}

/**
 * The identifier the review queue shows and matches on.
 *
 * Deliberately the strongest identifier the source printed, not the name: resolving one alias
 * must release every row that referenced the same identifier, and names vary between rows of the
 * same statement while identifiers do not.
 */
export function rawIdentifierOf(ref: RawInstrumentRef): string {
  if (ref.isin !== undefined && ref.isin !== '') return `isin:${ref.isin}`
  if (ref.amfiCode !== undefined && ref.amfiCode !== '') return `amfi:${ref.amfiCode}`
  if (ref.exchange !== undefined && ref.symbol !== undefined && ref.symbol !== '') {
    return `${ref.exchange.toLowerCase()}:${ref.symbol}`
  }
  if (ref.providerLocalId !== undefined && ref.providerLocalId !== '') {
    return `provider-local:${ref.providerLocalId}`
  }
  return `name:${ref.name}`
}

// ---------------------------------------------------------------------------
// The unresolved queue
// ---------------------------------------------------------------------------

export interface UnresolvedEntry {
  readonly accountId: string
  readonly rawIdentifier: string
  readonly rawName: string
  readonly assetClassHint: string | null
  readonly currency: string
  /** Units held, when a position stated them. */
  observedQuantity: string | null
  /** A stated holding value, which always beats a derived one. */
  observedFromPosition: Minor | null
  /** Net rupees put into the thing by the transactions in this document. */
  netInvested: Minor
  rowCount: number
}

/**
 * Accumulates one entry per distinct instrument per account.
 *
 * `observed_value_minor` is what lets the UI say "₹1,24,300 withheld from totals" instead of
 * "some holdings unresolved". Where a statement prints a market value that figure is used
 * verbatim. Where it does not — a broker tradebook has no valuation column — the fallback is the
 * net of the money that went in and came back out, which is the best available statement of what
 * the user has at stake in an instrument Misal cannot yet name. Income rows are excluded from
 * that net, because a dividend is not capital at risk.
 */
export class UnresolvedQueue {
  private readonly entries = new Map<string, UnresolvedEntry>()

  addTransaction(txn: NormalizedTransaction, accountId: string): void {
    const entry = this.entryFor(txn.instrument, accountId, txn.currency)
    entry.rowCount += 1
    const amount = txn.amountMinor
    if (amount === undefined) return
    if (txn.txnType === 'buy' || txn.txnType === 'transfer_in') {
      entry.netInvested = addMinor(entry.netInvested, absoluteOf(amount))
    } else if (txn.txnType === 'sell' || txn.txnType === 'transfer_out') {
      entry.netInvested = addMinor(entry.netInvested, negMinor(absoluteOf(amount)))
    }
  }

  addPosition(position: NormalizedPosition, accountId: string): void {
    const entry = this.entryFor(position.instrument, accountId, position.currency)
    entry.rowCount += 1
    entry.observedQuantity = position.quantity.value
    if (position.marketValueMinor !== undefined) {
      entry.observedFromPosition = position.marketValueMinor
    }
  }

  all(): readonly UnresolvedEntry[] {
    return [...this.entries.values()]
  }

  /** The value the UI reports as withheld, or null when the source gave nothing to report. */
  static observedValue(entry: UnresolvedEntry): Minor | null {
    if (entry.observedFromPosition !== null) return entry.observedFromPosition
    return isZeroMinor(entry.netInvested) ? null : entry.netInvested
  }

  private entryFor(ref: RawInstrumentRef, accountId: string, currency: string): UnresolvedEntry {
    const rawIdentifier = rawIdentifierOf(ref)
    const key = `${accountId} ${rawIdentifier}`
    const found = this.entries.get(key)
    if (found !== undefined) return found
    const created: UnresolvedEntry = {
      accountId,
      rawIdentifier,
      rawName: ref.name,
      assetClassHint: ref.assetClassHint ?? null,
      currency,
      observedQuantity: null,
      observedFromPosition: null,
      netInvested: ZERO_MINOR,
      rowCount: 0,
    }
    this.entries.set(key, created)
    return created
  }
}

function absoluteOf(value: Minor): Minor {
  return value.startsWith('-') ? (value.slice(1) as Minor) : value
}
