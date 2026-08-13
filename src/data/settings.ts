/**
 * The settings half of the IPC boundary: preferences, provider keys, manual price overrides,
 * account deletion and the standing review queue.
 *
 * `client.ts` reads portfolio rows; this module reads and writes the things the settings screen
 * owns. Three rules shape it.
 *
 * **A secret travels one way.** `setProviderKey` takes a key and returns a status. There is no
 * command that reads one back, no field on any type below that could hold one, and therefore no
 * React state that could serialise one into a devtools snapshot or an error report. The Rust side
 * writes it to the OS keychain and the database never sees it.
 *
 * **A price is validated here as well as in Rust.** Not for safety — Rust validates independently
 * and is authoritative — but because a round trip to be told about a comma is a worse experience
 * than being told immediately. `dec()` from `@domain/numeric` is the arbiter in both places, and
 * `describePriceInput` turns its refusal into a sentence naming the problem rather than restating
 * that one exists.
 *
 * **Bounds come from the core, not from here.** `SettingDefinition` is shipped by
 * `settings_snapshot`, so the minimum, the maximum and the currency list have exactly one
 * definition and the two validators cannot drift apart.
 */

import { invoke } from '@tauri-apps/api/core'
import { type Dec, dec } from '@domain/numeric'

/** The commands this module speaks. Injectable so tests need no Tauri runtime. */
export type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const tauriInvoke: Invoker = (command, args) => invoke(command, args)

export interface SettingRow {
  readonly key: string
  readonly value: string
  readonly updatedAt: string
}

export interface SettingDefinition {
  readonly key: string
  readonly label: string
  readonly help: string
  readonly kind: 'currency' | 'integer'
  readonly unit: string | null
  readonly min: number | null
  readonly max: number | null
  readonly choices: readonly string[]
}

/**
 * Whether a provider key is held — and never what it is.
 *
 * `unavailable` is a third state on purpose: a keychain that will not answer is not the same fact
 * as no key, and reporting one as the other would tell a user their key had vanished.
 */
export interface ProviderKeyStatus {
  readonly id: string
  readonly displayName: string
  readonly covers: string
  readonly withoutKey: string
  readonly status: 'present' | 'absent' | 'unavailable'
  readonly detail: string | null
}

export interface ManualPriceRow {
  readonly instrumentId: string
  readonly instrumentName: string
  readonly assetClass: string
  readonly asOf: string
  /** A canonical decimal string. Never a number, at any point in its life. */
  readonly close: string
  readonly currency: string
  readonly recordedAt: string
  /** The fetched row this override outranks for the same day, when there is one. */
  readonly supersededSource: string | null
  readonly supersededClose: string | null
}

export interface NetworkDestination {
  readonly host: string
  readonly pathPrefix: string
  readonly purpose: string
  readonly sends: string
  readonly requiresKey: boolean
}

export interface SettingsSnapshot {
  readonly settings: readonly SettingRow[]
  readonly definitions: readonly SettingDefinition[]
  readonly providers: readonly ProviderKeyStatus[]
  readonly overrides: readonly ManualPriceRow[]
  readonly network: readonly NetworkDestination[]
}

export const loadSettings = (call: Invoker = tauriInvoke): Promise<SettingsSnapshot> =>
  call('settings_snapshot')

export const writeSetting = (
  key: string,
  value: string,
  call: Invoker = tauriInvoke,
): Promise<SettingRow> => call('settings_write', { key, value })

/**
 * Store a provider key.
 *
 * The argument is the only place the secret exists on this side of the boundary. It is passed
 * straight through and is deliberately not kept, echoed, or returned.
 */
export const setProviderKey = (
  providerId: string,
  secret: string,
  call: Invoker = tauriInvoke,
): Promise<ProviderKeyStatus> => call('settings_set_provider_key', { providerId, secret })

export const clearProviderKey = (
  providerId: string,
  call: Invoker = tauriInvoke,
): Promise<ProviderKeyStatus> => call('settings_clear_provider_key', { providerId })

export interface ManualPriceInput {
  readonly instrumentId: string
  readonly asOf: string
  readonly close: Dec
}

export const setManualPrice = (
  input: ManualPriceInput,
  call: Invoker = tauriInvoke,
): Promise<ManualPriceRow> => call('settings_set_manual_price', { input })

export const deleteManualPrice = (
  instrumentId: string,
  asOf: string,
  call: Invoker = tauriInvoke,
): Promise<void> => call('settings_delete_manual_price', { instrumentId, asOf })

// ---------------------------------------------------------------------------
// Deleting an account
// ---------------------------------------------------------------------------

/**
 * What deleting an account would destroy, counted by the core before anything is destroyed.
 *
 * Read separately from the delete, and shown before it, because deletion is irreversible and
 * "this will delete your data" is not a sentence anyone can weigh. Every field here appears on
 * screen; none of them is decorative.
 *
 * No secret and no keychain reference is in this type. `hasCredential` is a boolean, which is the
 * most the screen is allowed to know.
 */
export interface AccountDeletionPreview {
  readonly accountId: string
  readonly label: string
  readonly providerId: string
  readonly capability: 'ledger' | 'snapshot'
  readonly transactions: number
  /** Distinct instruments held. A holding restated on four dates is one holding, not four. */
  readonly holdings: number
  readonly positionRows: number
  readonly queueEntries: number
  /** Imported statements that go with the account, because nothing else references them. */
  readonly documentsRemoved: number
  /** Statements other accounts' rows still cite. Kept, and detached from this account. */
  readonly documentsShared: number
  readonly hasCredential: boolean
  readonly syncCursors: number
}

/** What was actually removed, so the screen reports an outcome rather than repeating a warning. */
export interface AccountDeletionOutcome {
  readonly label: string
  readonly transactions: number
  readonly positions: number
  readonly queueEntries: number
  readonly documentsRemoved: number
  readonly documentsKeptShared: number
  readonly credentialForgotten: boolean
}

export const previewAccountDeletion = (
  accountId: string,
  call: Invoker = tauriInvoke,
): Promise<AccountDeletionPreview> => call('account_deletion_preview', { accountId })

/**
 * Delete an account, its rows and its keychain entry.
 *
 * Irreversible, and there is no undo anywhere behind it: the core removes the transactions, the
 * positions, the sync cursors, the credential reference and the stored secret in one transaction.
 * The caller is responsible for having shown `previewAccountDeletion` first.
 */
export const deleteAccount = (
  accountId: string,
  call: Invoker = tauriInvoke,
): Promise<AccountDeletionOutcome> => call('account_delete', { accountId })

// ---------------------------------------------------------------------------
// The standing review queue
// ---------------------------------------------------------------------------

/**
 * What the user has done about an entry — never whether the money has come back.
 *
 * `open` — nobody has looked at it yet.
 * `dismissed` — the user asked not to be asked again. Still withheld from every total.
 * `mapped` — the instrument has been named, so the next statement resolves without asking, but the
 * rows this import withheld are still not in the ledger. Still withheld.
 *
 * There is no fourth state here, because the fourth state leaves the queue: `resolved_at` means the
 * rows landed, and only then does the disclosure stop.
 */
export type ReviewEntryState = 'open' | 'dismissed' | 'mapped'

export interface ReviewQueueEntry {
  readonly id: string
  readonly accountId: string
  readonly accountLabel: string
  readonly providerShortCode: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly assetClassHint: string | null
  readonly observedQuantity: string | null
  /** Minor units as a string. The one figure in the product meant to be believed literally. */
  readonly observedValueMinor: string | null
  readonly currency: string | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string | null
  readonly ignoredAt: string | null
  readonly mappedAt: string | null
  readonly mappedInstrumentId: string | null
  readonly mappedInstrumentName: string | null
  readonly state: ReviewEntryState
}

export const loadReviewQueue = (call: Invoker = tauriInvoke): Promise<readonly ReviewQueueEntry[]> =>
  call('review_queue_list')

/** Undo a dismissal. Clears `ignored_at` and nothing else — the sighting date is not rewritten. */
export const restoreReviewEntry = (entryId: string, call: Invoker = tauriInvoke): Promise<void> =>
  call('review_queue_restore', { entryId })

export const dismissReviewEntry = (entryId: string, call: Invoker = tauriInvoke): Promise<void> =>
  call('review_queue_dismiss', { entryId })

// ---------------------------------------------------------------------------
// Validation at the boundary
// ---------------------------------------------------------------------------

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

const quoted = (value: string): string => `“${value}”`

/**
 * A typed price, or a sentence naming what is wrong with the input.
 *
 * `dec()` is the arbiter — this function does not re-implement the grammar, it explains the
 * refusal. The order of the checks is the order a person makes the mistakes: a pasted figure with
 * separators first, a currency symbol next, and only then the shapes nobody types by accident.
 */
export function describePriceInput(raw: string): Validation<Dec> {
  const value = raw.trim()
  if (value === '') {
    return { ok: false, message: 'Enter a price per unit — the field is empty.' }
  }
  if (value.includes(',')) {
    return {
      ok: false,
      message: `${quoted(value)} contains a comma. Enter the price without grouping separators, as 152000.50.`,
    }
  }
  if (/[^\d.-]/u.test(value)) {
    return {
      ok: false,
      message: `${quoted(value)} contains something that is not a digit. Enter the number alone — no currency symbol, no unit, no spaces.`,
    }
  }
  if (value.startsWith('-')) {
    return { ok: false, message: 'A price per unit cannot be negative.' }
  }
  try {
    return { ok: true, value: dec(value) }
  } catch {
    return {
      ok: false,
      message: `${quoted(value)} is not a plain decimal number. Use digits and at most one decimal point, as 1512.50.`,
    }
  }
}

/** `YYYY-MM-DD`, and a day that exists. A 31 February override would never be selected. */
export function describeDateInput(raw: string): Validation<string> {
  const value = raw.trim()
  if (value === '') return { ok: false, message: 'Choose the date this price is for.' }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return { ok: false, message: `${quoted(value)} is not a date written as YYYY-MM-DD.` }
  }
  // `new Date` accepts 2026-02-31 and silently rolls it to 3 March, so the round trip is the check.
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return { ok: false, message: `${quoted(value)} is not a day that exists.` }
  }
  return { ok: true, value }
}

/**
 * A setting value, checked against the definition the core shipped.
 *
 * Every message names the problem. "Must be a whole number of minutes" is something a user can act
 * on; "invalid value" sends them guessing.
 */
export function describeSettingInput(
  definition: SettingDefinition,
  raw: string,
): Validation<string> {
  const value = raw.trim()
  if (definition.kind === 'currency') {
    const upper = value.toUpperCase()
    if (!definition.choices.includes(upper)) {
      return {
        ok: false,
        message: `${definition.label} must be one of ${definition.choices.join(', ')}.`,
      }
    }
    return { ok: true, value: upper }
  }

  const unit = definition.unit ?? ''
  if (value === '') {
    return { ok: false, message: `${definition.label} needs a value in ${unit}.` }
  }
  if (!/^-?\d+$/u.test(value)) {
    return {
      ok: false,
      message: `${definition.label} must be a whole number of ${unit}; ${quoted(value)} is not.`,
    }
  }
  // BigInt rather than Number: these are counts, and the float ban applies to every one of them.
  const number = BigInt(value)
  const belowMin = definition.min !== null && number < BigInt(definition.min)
  const aboveMax = definition.max !== null && number > BigInt(definition.max)
  if (belowMin || aboveMax) {
    return {
      ok: false,
      message: `${definition.label} must be between ${String(definition.min)} and ${String(definition.max)} ${unit}.`,
    }
  }
  return { ok: true, value: number.toString() }
}

/** The stored value for a key, or the empty string when the row is missing. */
export function settingValue(snapshot: SettingsSnapshot, key: string): string {
  return snapshot.settings.find((row) => row.key === key)?.value ?? ''
}
