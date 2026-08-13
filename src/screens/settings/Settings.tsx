/**
 * Screen 06 — Settings.
 *
 * There is no settings screen in the approved mockup, so nothing here is invented: the frame, the
 * panels, the labels, the buttons and the rules are the ones the other five screens already use.
 * What is new is only the arrangement.
 *
 * Six things live on this screen, and each is here for a reason the others are not.
 *
 *   **Preferences** are the four rows of `setting` the valuation engine reads. They are validated
 *   against definitions the core ships, so the bounds shown, the bounds checked here and the bounds
 *   enforced in Rust are one set rather than three.
 *
 *   **Provider keys** are entered and cleared, never displayed. The field is uncontrolled on
 *   purpose: with a ref rather than `useState`, the key is never a React state value at all, so
 *   there is no render tree, devtools snapshot or error boundary payload that could carry it. What
 *   the screen shows is the presence flag the core returns.
 *
 *   **Manual prices** are the only way to value an instrument no provider covers — a physical gold
 *   holding, an unlisted share, a fund whose registrar prints no code. Treated as a first-class
 *   input accordingly: the panel says what it outranks and what a refresh will not do to it.
 *
 *   **What leaves this machine** is the point of the whole product stated as a table. It is
 *   generated from `MARKET_DATA_HOSTS` — the allowlist the socket layer enforces — rather than
 *   written as copy, so it cannot describe a world the code has moved on from. Same discipline as
 *   H11 on the status line: read the fact, never assert it.
 *
 *   **The review queue** is every unresolved instrument still withholding value from net worth,
 *   whatever the user has done about it. Migration 0006 split `ignored_at` and `mapped_at` out of
 *   `resolved_at` precisely so a dismissal would stop the asking without deleting the disclosure;
 *   until this panel existed the split had nowhere to show. A dismissed entry therefore appears
 *   here, labelled dismissed, with its rupee figure still counted — and can be put back.
 *
 *   **Accounts** are here for the one thing nothing else could do: delete one. Before this, a
 *   single bad account could only be recovered from by deleting the encrypted database and every
 *   statement ever imported with it. Deletion is irreversible and there is no undo behind it, so
 *   the confirmation states what is lost — the label, the transactions, the holdings and the value —
 *   and asks the user to type the account's name. A bare "Are you sure?" is a question nobody reads.
 */

import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dec } from '@domain/numeric'
import type { Measured } from '@domain/measured'
import { REASON_TEXT } from '@domain/measured'
import type { Figure } from '@ui/figure'
import { CURRENCY_SYMBOL, Metric, formatFigure, formatQty } from '@ui/index'
import { dec } from '@domain/numeric'
import { listInstruments, loadPortfolioRows } from '../../data/client'
import {
  clearProviderKey,
  deleteAccount,
  deleteManualPrice,
  describeDateInput,
  describePriceInput,
  describeSettingInput,
  dismissReviewEntry,
  loadReviewQueue,
  loadSettings,
  previewAccountDeletion,
  restoreReviewEntry,
  setManualPrice,
  setProviderKey,
  settingValue,
  writeSetting,
} from '../../data/settings'
import type {
  AccountDeletionOutcome,
  AccountDeletionPreview,
  ManualPriceRow,
  NetworkDestination,
  ProviderKeyStatus,
  ReviewEntryState,
  ReviewQueueEntry,
  SettingDefinition,
  SettingsSnapshot,
} from '../../data/settings'
import { Badge, EmptyState, ErrorState, Panel, ScreenHead } from '../chrome'
import { buildPortfolioView } from '../view-model'
import {
  EMPTY_SUMMARY,
  STATE_LABEL,
  STATE_MEANING,
  STATE_ORDER,
  entriesInState,
  entryWithheld,
  formatWithheld,
  identifierLabel,
  identifierValue,
  summariseWithheld,
  withheldCaveat,
} from './review'
import './settings.css'

/** One instrument, as the override picker needs it. */
export interface InstrumentOption {
  readonly id: string
  readonly displayName: string
  readonly isin: string | null
  readonly currency: string
}

/**
 * One account as the delete panel needs it.
 *
 * `value` is the same `Measured<Figure>` the accounts screen renders, taken from the valuation
 * engine rather than recomputed — a second implementation of "what is this account worth" is a
 * second thing that can disagree with the dashboard, and the user is about to destroy it on the
 * strength of this number.
 *
 * When valuation could not run at all, `value` is null and `valueUnavailable` carries the reason as
 * a sentence. There is no `Measured` reason for "the engine refused", and inventing one would be a
 * worse lie than saying so plainly.
 */
export interface AccountSummary {
  readonly id: string
  readonly label: string
  readonly providerId: string
  readonly shortCode: string
  readonly capability: 'ledger' | 'snapshot'
  readonly value: Measured<Figure> | null
  readonly valueUnavailable: string | null
}

/** Everything this screen does to the outside world, in one place so a test can stand in for it. */
export interface SettingsRuntime {
  load: () => Promise<SettingsSnapshot>
  listInstruments: () => Promise<readonly InstrumentOption[]>
  writeSetting: (key: string, value: string) => Promise<unknown>
  setProviderKey: (providerId: string, secret: string) => Promise<ProviderKeyStatus>
  clearProviderKey: (providerId: string) => Promise<ProviderKeyStatus>
  /** `close` is a `Dec`, so only a value `describePriceInput` has already validated can be passed. */
  setManualPrice: (instrumentId: string, asOf: string, close: Dec) => Promise<unknown>
  deleteManualPrice: (instrumentId: string, asOf: string) => Promise<void>
  listAccounts: () => Promise<readonly AccountSummary[]>
  previewDeletion: (accountId: string) => Promise<AccountDeletionPreview>
  deleteAccount: (accountId: string) => Promise<AccountDeletionOutcome>
  loadReviewQueue: () => Promise<readonly ReviewQueueEntry[]>
  restoreReviewEntry: (entryId: string) => Promise<void>
  dismissReviewEntry: (entryId: string) => Promise<void>
}

/**
 * Accounts with the value the valuation engine attributes to each.
 *
 * `loadPortfolioRows` then `buildPortfolioView` is the same pair every other screen goes through,
 * so the figure beside "Delete" is the figure on the dashboard. If the view refuses to build, the
 * accounts are still listed — from the rows themselves — because being unable to value an account
 * must not be the reason a user cannot delete the account that broke valuation. That is the exact
 * situation this command exists for.
 */
async function accountsWithValue(): Promise<readonly AccountSummary[]> {
  const rows = await loadPortfolioRows()
  const view = buildPortfolioView(rows, new Date().toISOString())
  if (!view.ok) {
    return rows.accounts.map((row) => ({
      id: row.id,
      label: row.label,
      providerId: row.providerId,
      shortCode: row.providerShortCode,
      capability: row.capability,
      value: null,
      valueUnavailable: `Valuation could not run, so this account's value is unknown: ${view.message}`,
    }))
  }
  return view.data.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    providerId: account.providerId,
    shortCode: account.shortCode,
    capability: account.capability,
    value: account.value,
    valueUnavailable: null,
  }))
}

function defaultRuntime(): SettingsRuntime {
  return {
    load: () => loadSettings(),
    listInstruments: async () =>
      (await listInstruments()).map((row) => ({
        id: row.id,
        displayName: row.displayName,
        isin: row.isin,
        currency: row.currency,
      })),
    writeSetting: (key, value) => writeSetting(key, value),
    setProviderKey: (providerId, secret) => setProviderKey(providerId, secret),
    clearProviderKey: (providerId) => clearProviderKey(providerId),
    setManualPrice: (instrumentId, asOf, close) => setManualPrice({ instrumentId, asOf, close }),
    deleteManualPrice: (instrumentId, asOf) => deleteManualPrice(instrumentId, asOf),
    listAccounts: () => accountsWithValue(),
    previewDeletion: (accountId) => previewAccountDeletion(accountId),
    deleteAccount: (accountId) => deleteAccount(accountId),
    loadReviewQueue: () => loadReviewQueue(),
    restoreReviewEntry: (entryId) => restoreReviewEntry(entryId),
    dismissReviewEntry: (entryId) => dismissReviewEntry(entryId),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SettingsProps {
  readonly runtime?: SettingsRuntime
  /**
   * Called after anything that changes a stored figure — a base currency, a manual price.
   *
   * The shell uses it to invalidate the portfolio query. Without it a user sets an override, walks
   * to the dashboard and finds the holding still unpriced, which reads as the override having been
   * ignored.
   */
  readonly onChanged?: () => void
}

export function Settings(props: SettingsProps): ReactNode {
  const runtimeRef = useRef<SettingsRuntime | null>(props.runtime ?? null)
  runtimeRef.current ??= defaultRuntime()
  const runtime = runtimeRef.current

  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [instruments, setInstruments] = useState<readonly InstrumentOption[]>([])
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([])
  const [queue, setQueue] = useState<readonly ReviewQueueEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [next, catalogue, accountRows, queueRows] = await Promise.all([
        runtime.load(),
        runtime.listInstruments(),
        runtime.listAccounts(),
        runtime.loadReviewQueue(),
      ])
      setSnapshot(next)
      setInstruments(catalogue)
      setAccounts(accountRows)
      setQueue(queueRows)
      setLoadError(null)
    } catch (error) {
      setLoadError(describe(error))
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <>
      <ScreenHead
        title="Settings"
        note="Stored on this machine · nothing here is synced to anything"
      />

      {loadError !== null && (
        <ErrorState
          message={`Settings could not be read: ${loadError}`}
          onRetry={() => {
            void reload()
          }}
        />
      )}

      {snapshot === null ? (
        loadError === null && (
          <EmptyState headline="Reading settings…">
            The four preferences, the provider keys, every manual price, the accounts and the review
            queue are read together, so the screen never shows half a state.
          </EmptyState>
        )
      ) : (
        <div className="set-screen">
          <div className="dashgrid-2 set-grid">
            <Preferences
              snapshot={snapshot}
              runtime={runtime}
              onSaved={() => {
                void reload()
                props.onChanged?.()
              }}
            />
            <ProviderKeys
              providers={snapshot.providers}
              runtime={runtime}
              onChanged={() => {
                void reload()
              }}
            />
          </div>

          <ReviewQueue
            entries={queue}
            runtime={runtime}
            onChanged={() => {
              void reload()
            }}
          />

          <Accounts
            accounts={accounts}
            runtime={runtime}
            onDeleted={() => {
              void reload()
              props.onChanged?.()
            }}
          />

          <ManualPrices
            overrides={snapshot.overrides}
            instruments={instruments}
            runtime={runtime}
            onChanged={() => {
              void reload()
              props.onChanged?.()
            }}
          />

          <WhatLeaves network={snapshot.network} providers={snapshot.providers} />
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function Preferences({
  snapshot,
  runtime,
  onSaved,
}: {
  readonly snapshot: SettingsSnapshot
  readonly runtime: SettingsRuntime
  readonly onSaved: () => void
}): ReactNode {
  return (
    <Panel
      title="Preferences"
      meta={`${String(snapshot.definitions.length)} stored`}
      foot={
        <>
          Saved one at a time, and read back exactly as stored — the screen reports what was
          written rather than what was typed.{' '}
          <b>Only the cache lifetime changes behaviour today</b> — the refresh screen uses it to
          decide whether a price is due. Two more are recorded but not yet consulted: staleness is
          judged per asset class inside the valuation engine, and concentration is reported without
          a threshold. They are saved so nothing is lost when those parts start reading them.{' '}
          <b>The base currency offers INR alone</b>, because every total is computed in INR and a
          second choice would rename the totals without converting them — and would stop the
          exchange rates being fetched, leaving net worth moving on refreshed prices against a
          frozen rate. It becomes a real choice when the engine reads it.
        </>
      }
    >
      <div className="panel-body set-fields">
        {snapshot.definitions.map((definition) => (
          <SettingField
            key={definition.key}
            definition={definition}
            stored={settingValue(snapshot, definition.key)}
            runtime={runtime}
            onSaved={onSaved}
          />
        ))}
      </div>
    </Panel>
  )
}

function SettingField({
  definition,
  stored,
  runtime,
  onSaved,
}: {
  readonly definition: SettingDefinition
  readonly stored: string
  readonly runtime: SettingsRuntime
  readonly onSaved: () => void
}): ReactNode {
  const [draft, setDraft] = useState(stored)
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const fieldId = `set-${definition.key}`

  // The stored value wins whenever the core reports a new one: a save that was normalised — " usd "
  // to "USD" — must show what was stored rather than what was typed.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const checked = describeSettingInput(definition, draft)
    if (!checked.ok) {
      setFailed(true)
      setNote(checked.message)
      return
    }
    setBusy(true)
    runtime
      .writeSetting(definition.key, checked.value)
      .then(() => {
        setFailed(false)
        setNote(`Saved. ${definition.label} is ${checked.value}${unitSuffix(definition)}.`)
        onSaved()
      })
      .catch((error: unknown) => {
        setFailed(true)
        setNote(describe(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <form className="set-field" onSubmit={submit}>
      <label className="lab" htmlFor={fieldId}>
        {definition.label}
        {definition.unit === null ? '' : ` · ${definition.unit}`}
      </label>
      <div className="set-field-row">
        {definition.kind === 'currency' ? (
          // Disabled when the core offers one value, rather than rendered as a menu of one that
          // looks like a decision the user has made. The panel's footnote says why there is one.
          <select
            id={fieldId}
            value={draft}
            disabled={definition.choices.length < 2}
            onChange={(event) => {
              setDraft(event.target.value)
              setNote(null)
            }}
          >
            {definition.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={fieldId}
            type="text"
            inputMode="numeric"
            value={draft}
            aria-describedby={`${fieldId}-help`}
            onChange={(event) => {
              setDraft(event.target.value)
              setNote(null)
            }}
          />
        )}
        <button className="btn" type="submit" disabled={busy || draft === stored}>
          Save
        </button>
      </div>
      <p className="conf" id={`${fieldId}-help`}>
        {definition.help}
        {definition.min !== null && definition.max !== null
          ? ` Between ${String(definition.min)} and ${String(definition.max)}.`
          : ''}
      </p>
      {note !== null && (
        <p className={failed ? 'set-note set-note-bad' : 'set-note'} role="status">
          {note}
        </p>
      )}
    </form>
  )
}

function unitSuffix(definition: SettingDefinition): string {
  return definition.unit === null ? '' : ` ${definition.unit}`
}

// ---------------------------------------------------------------------------
// Provider keys
// ---------------------------------------------------------------------------

const KEY_STATUS: Record<ProviderKeyStatus['status'], { label: string; tone: 'ok' | 'warn' | 'crit' }> =
  {
    present: { label: 'Key stored', tone: 'ok' },
    absent: { label: 'No key', tone: 'warn' },
    unavailable: { label: 'Keychain unreadable', tone: 'crit' },
  }

function ProviderKeys({
  providers,
  runtime,
  onChanged,
}: {
  readonly providers: readonly ProviderKeyStatus[]
  readonly runtime: SettingsRuntime
  readonly onChanged: () => void
}): ReactNode {
  return (
    <Panel
      title="Provider keys"
      meta="Kept in the OS keychain"
      foot="A key is written to the operating system's keychain — Keychain on macOS, Credential Manager on Windows, Secret Service on Linux — and never to Misal's database, an export, or a log. Misal has no command that reads one back, so this screen can say whether a key is stored and nothing more."
    >
      <div className="panel-body">
        <div className="set-keyless">
          <span className="lab">Works with no key at all</span>
          <p>
            Indian mutual fund NAVs come from AMFI&rsquo;s official daily file, which is free,
            keyless and authoritative — the same numbers the registrars publish. Crypto spot prices
            come from CoinGecko&rsquo;s free tier, and Indian equity quotes from Yahoo&rsquo;s public
            endpoint. A key adds a supported provider; it is not what makes pricing work.
          </p>
        </div>

        {providers.map((provider) => (
          <ProviderKeyField
            key={provider.id}
            provider={provider}
            runtime={runtime}
            onChanged={onChanged}
          />
        ))}
      </div>
    </Panel>
  )
}

function ProviderKeyField({
  provider,
  runtime,
  onChanged,
}: {
  readonly provider: ProviderKeyStatus
  readonly runtime: SettingsRuntime
  readonly onChanged: () => void
}): ReactNode {
  // Deliberately uncontrolled. A `useState` holding the key would put it in the React tree, where a
  // devtools snapshot or a serialised error payload could carry it off the machine.
  const field = useRef<HTMLInputElement | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const fieldId = `set-key-${provider.id}`
  const badge = KEY_STATUS[provider.status]

  const finish = (message: string, bad: boolean): void => {
    setFailed(bad)
    setNote(message)
    setBusy(false)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const input = field.current
    if (input === null) return
    const secret = input.value
    setBusy(true)
    runtime
      .setProviderKey(provider.id, secret)
      .then(() => {
        // Cleared the instant the write returns, so the key is not sitting in the DOM behind a
        // password mask waiting for the next screenshot.
        input.value = ''
        finish(`Stored in the keychain. ${provider.displayName} will be used on the next refresh.`, false)
        onChanged()
      })
      .catch((error: unknown) => {
        finish(describe(error), true)
      })
  }

  const clear = (): void => {
    setBusy(true)
    runtime
      .clearProviderKey(provider.id)
      .then(() => {
        if (field.current !== null) field.current.value = ''
        finish(
          `Removed from the keychain. ${provider.displayName} will not be contacted again unless you enter another key.`,
          false,
        )
        onChanged()
      })
      .catch((error: unknown) => {
        finish(describe(error), true)
      })
  }

  return (
    <form className="set-provider" onSubmit={submit}>
      <div className="set-provider-head">
        <span className="set-provider-name">{provider.displayName}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="conf">{provider.covers}</p>
      <p className="conf">{provider.withoutKey}</p>
      {provider.status === 'unavailable' && (
        <p className="set-note set-note-bad" role="status">
          Misal could not read the keychain, so it cannot say whether a key is stored:{' '}
          {provider.detail ?? 'no reason given'}. Nothing was changed.
        </p>
      )}

      <label className="lab" htmlFor={fieldId}>
        API key
      </label>
      <div className="set-field-row">
        <input
          id={fieldId}
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.status === 'present' ? 'A key is stored — paste a new one to replace it' : 'Paste the key'}
          aria-describedby={`${fieldId}-note`}
        />
        <button className="btn btn-strong" type="submit" disabled={busy}>
          Store
        </button>
        <button className="btn" type="button" disabled={busy || provider.status !== 'present'} onClick={clear}>
          Clear
        </button>
      </div>
      <p className="conf" id={`${fieldId}-note`}>
        The key is never shown again after it is stored, here or anywhere else.
      </p>
      {note !== null && (
        <p className={failed ? 'set-note set-note-bad' : 'set-note'} role="status">
          {note}
        </p>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

const STATE_TONE: Record<ReviewEntryState, 'warn' | 'neutral' | 'snapshot'> = {
  open: 'warn',
  mapped: 'snapshot',
  dismissed: 'neutral',
}

/**
 * Every unresolved instrument still withholding value, in the three states it can be in.
 *
 * The total across all three is stated first, because that is the figure the dashboard's withheld
 * tile shows and this is the only screen that can explain it. Dismissed entries are inside that
 * total on purpose: dismissing stopped Misal asking, it did not put the money back.
 */
function ReviewQueue({
  entries,
  runtime,
  onChanged,
}: {
  readonly entries: readonly ReviewQueueEntry[]
  readonly runtime: SettingsRuntime
  readonly onChanged: () => void
}): ReactNode {
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const total = entries.length === 0 ? EMPTY_SUMMARY : summariseWithheld(entries)
  const caveat = withheldCaveat(total)

  const act = (
    entryId: string,
    run: (id: string) => Promise<void>,
    describeDone: (entry: ReviewQueueEntry) => string,
  ): void => {
    const entry = entries.find((candidate) => candidate.id === entryId)
    setBusyId(entryId)
    run(entryId)
      .then(() => {
        setFailed(false)
        setNote(entry === undefined ? 'Done.' : describeDone(entry))
        onChanged()
      })
      .catch((error: unknown) => {
        setFailed(true)
        setNote(describe(error))
      })
      .finally(() => {
        setBusyId(null)
      })
  }

  return (
    <Panel
      title="Review queue"
      meta={
        entries.length === 0
          ? 'nothing withheld'
          : `${String(entries.length)} entries · ${formatWithheld(total)} withheld`
      }
      className="set-panel"
      foot="An entry leaves this queue on one condition only: rows carrying it have landed in the ledger, so its value is in the totals rather than merely accounted for. Naming the instrument does not do that, and dismissing it certainly does not — which is why both are shown here as their own state rather than as an absence."
    >
      <div className="panel-body">
        <p className="set-lede">
          These are the identifiers no import could resolve to an instrument. Misal never guesses one
          from a name, so their value is held out of net worth, out of every asset-class total and out
          of every weight until you say what they are. This is the standing list; the import screen
          shows only what the file you just imported could not identify.
        </p>

        {entries.length === 0 ? (
          <EmptyState headline="Nothing is being withheld">
            Every identifier in every document imported on this machine resolves to an instrument, so
            no holding is missing from any total for want of a mapping.
          </EmptyState>
        ) : (
          <>
            <div className="set-withheld">
              <span className="lab">Held out of net worth</span>
              <div className="set-withheld-figure">{formatWithheld(total)}</div>
              <p className="conf">
                Across {String(entries.length)} {entries.length === 1 ? 'entry' : 'entries'}, in
                every state below. {caveat ?? ''}
              </p>
            </div>

            {STATE_ORDER.map((state) => (
              <ReviewGroup
                key={state}
                state={state}
                entries={entriesInState(entries, state)}
                busyId={busyId}
                onRestore={(id) => {
                  act(id, runtime.restoreReviewEntry, (entry) =>
                    `Put back. “${entry.rawName ?? identifierValue(entry.rawIdentifier)}” is open again — its value was withheld the whole time it was dismissed, and still is.`,
                  )
                }}
                onDismiss={(id) => {
                  act(id, runtime.dismissReviewEntry, (entry) =>
                    `Dismissed. “${entry.rawName ?? identifierValue(entry.rawIdentifier)}” stays on this list and its value stays out of every total; Misal will stop asking about it during imports.`,
                  )
                }}
              />
            ))}

            {note !== null && (
              <p className={failed ? 'set-note set-note-bad' : 'set-note'} role="status">
                {note}
              </p>
            )}

            <p className="conf">
              Mapping an entry to an instrument happens on the import screen, beside the document
              that raised it — that is where the units, the dates and the page reference are, and
              choosing an instrument without them is guesswork.
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}

function ReviewGroup({
  state,
  entries,
  busyId,
  onRestore,
  onDismiss,
}: {
  readonly state: ReviewEntryState
  readonly entries: readonly ReviewQueueEntry[]
  readonly busyId: string | null
  readonly onRestore: (entryId: string) => void
  readonly onDismiss: (entryId: string) => void
}): ReactNode {
  if (entries.length === 0) return null
  const summary = summariseWithheld(entries)
  const caveat = withheldCaveat(summary)

  return (
    <section className="set-queue-group" aria-label={STATE_LABEL[state]}>
      <div className="set-queue-group-head">
        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
        <span className="set-queue-group-count">
          {String(entries.length)} {entries.length === 1 ? 'entry' : 'entries'} ·{' '}
          {formatWithheld(summary)} withheld
        </span>
      </div>
      <p className="conf">
        {STATE_MEANING[state]} {caveat ?? ''}
      </p>

      {entries.map((entry) => (
        <ReviewEntry
          key={entry.id}
          entry={entry}
          busy={busyId === entry.id}
          onRestore={onRestore}
          onDismiss={onDismiss}
        />
      ))}
    </section>
  )
}

function ReviewEntry({
  entry,
  busy,
  onRestore,
  onDismiss,
}: {
  readonly entry: ReviewQueueEntry
  readonly busy: boolean
  readonly onRestore: (entryId: string) => void
  readonly onDismiss: (entryId: string) => void
}): ReactNode {
  const withheld = entryWithheld(entry)
  return (
    <div className="set-queue-item" data-queue-state={entry.state}>
      <div>
        <span className="lab">{identifierLabel(entry.rawIdentifier)}</span>
        <div className="set-mono">{identifierValue(entry.rawIdentifier)}</div>
        <div className="acct-prov">
          {entry.rawName === null || entry.rawName === '' ? 'no name printed' : `“${entry.rawName}”`}{' '}
          · {entry.accountLabel} · {entry.providerShortCode}
          {entry.observedQuantity === null ? '' : ` · ${quantityText(entry.observedQuantity)} units`}
        </div>
        {entry.state === 'mapped' && (
          <div className="acct-prov">
            Named as {entry.mappedInstrumentName ?? entry.mappedInstrumentId ?? 'an instrument'}
            {entry.mappedAt === null ? '' : ` on ${entry.mappedAt.slice(0, 10)}`}
          </div>
        )}
        {entry.state === 'dismissed' && entry.ignoredAt !== null && (
          <div className="acct-prov">Dismissed on {entry.ignoredAt.slice(0, 10)}</div>
        )}
      </div>

      <div className="set-queue-amount">
        {withheld === null ? (
          // Never a zero and never a dash: the value of this holding is unknown, which is not the
          // same fact as its being worth nothing.
          <span className="na" title="the source stated no value Misal can total">
            Amount unknown
          </span>
        ) : (
          <b>{withheld}</b>
        )}
        <span className="acct-prov">withheld from every total</span>
      </div>

      <div className="set-queue-actions">
        {entry.state === 'dismissed' ? (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              onRestore(entry.id)
            }}
          >
            Put back
          </button>
        ) : entry.state === 'open' ? (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              onDismiss(entry.id)
            }}
          >
            Dismiss
          </button>
        ) : (
          <span className="conf">Waiting for a statement carrying it</span>
        )}
      </div>
    </div>
  )
}

/** A stored quantity, grouped for display. Shown verbatim if it will not parse, never dropped. */
function quantityText(value: string): string {
  try {
    return formatQty(dec(value))
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// Accounts, and the only delete in the product
// ---------------------------------------------------------------------------

/**
 * The account list, and the only delete in the product.
 *
 * The value column carries `data-stamp-scope="derived"` on the table rather than a stamp per row:
 * every figure in it has the same provenance — stored positions valued at the latest stored price —
 * so declaring it once is the honest form and stamping each row would be noise. That is the
 * panel-scope exemption `ReadoutCell` uses for the same reason.
 */
function Accounts({
  accounts,
  runtime,
  onDeleted,
}: {
  readonly accounts: readonly AccountSummary[]
  readonly runtime: SettingsRuntime
  readonly onDeleted: () => void
}): ReactNode {
  const [openId, setOpenId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<AccountDeletionOutcome | null>(null)

  return (
    <Panel
      title="Accounts"
      meta={accounts.length === 0 ? 'none yet' : `${String(accounts.length)} stored`}
      className="set-panel"
      foot="Deleting an account removes its transactions, its holdings, its sync cursors, its credential reference and the API key in your operating system's keychain, in one transaction — it all happens or none of it does. The keychain entry goes first, so a failure leaves the account visibly present rather than silently credential-less. Statements shared with another account are kept and detached rather than deleted, because the rows they carry for that other account are not this account's to destroy."
    >
      <div className="panel-body">
        <p className="set-lede">
          Removing an account is the only destructive action in Misal and there is no undo behind it —
          no archive, no bin, no export written on the way out. If you want the history, export it
          first. Disconnecting an exchange, which removes the key and keeps everything imported, is
          on the exchanges screen and is what most situations actually call for.
        </p>

        {accounts.length === 0 ? (
          <EmptyState headline="No accounts yet">
            Import a statement or connect a read-only key, and the account it belongs to appears here.
          </EmptyState>
        ) : (
          <table className="dtable set-accounts" data-stamp-scope="derived">
            <caption className="vh">
              Accounts stored on this machine. Every value is derived from stored positions and the
              latest price held for each instrument.
            </caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Capability</th>
                <th scope="col" className="acct-num">
                  Value
                </th>
                <th scope="col">
                  <span className="vh">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <th scope="row">
                    {account.label}
                    <span className="acct-prov">
                      {account.providerId} · {account.shortCode}
                    </span>
                  </th>
                  <td>
                    {account.capability === 'ledger' ? (
                      <Badge>Full history</Badge>
                    ) : (
                      <Badge tone="snapshot">Snapshot only</Badge>
                    )}
                  </td>
                  <td className="acct-num">
                    {account.value === null ? (
                      <span className="na">{account.valueUnavailable ?? 'Value unknown'}</span>
                    ) : (
                      <Metric
                        value={account.value}
                        metric="value"
                        scope="account"
                        basis="derived"
                        size="cell"
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setOutcome(null)
                        setOpenId(openId === account.id ? null : account.id)
                      }}
                      aria-expanded={openId === account.id}
                    >
                      {openId === account.id ? 'Cancel' : 'Delete…'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {accounts.map(
          (account) =>
            openId === account.id && (
              <DeleteConfirmation
                key={account.id}
                account={account}
                runtime={runtime}
                onCancel={() => {
                  setOpenId(null)
                }}
                onDeleted={(result) => {
                  setOpenId(null)
                  setOutcome(result)
                  onDeleted()
                }}
              />
            ),
        )}

        {outcome !== null && (
          <p className="set-note" role="status">
            Deleted {outcome.label}: {String(outcome.transactions)}{' '}
            {outcome.transactions === 1 ? 'transaction' : 'transactions'},{' '}
            {String(outcome.positions)} {outcome.positions === 1 ? 'holding' : 'holdings'} and{' '}
            {String(outcome.documentsRemoved)}{' '}
            {outcome.documentsRemoved === 1 ? 'statement' : 'statements'} removed.{' '}
            {outcome.credentialForgotten
              ? 'The API key was deleted from your keychain.'
              : 'There was no stored key to delete.'}{' '}
            {outcome.documentsKeptShared > 0 &&
              `${String(outcome.documentsKeptShared)} shared ${outcome.documentsKeptShared === 1 ? 'statement was' : 'statements were'} kept, because other accounts' rows still cite them.`}
          </p>
        )}
      </div>
    </Panel>
  )
}

/**
 * The confirmation. It states the loss and then asks the user to type the account's name.
 *
 * Typing the label rather than clicking "Yes" is the whole point: a confirm button that is one
 * click from a delete button gets pressed by the same reflex that pressed the first one. Copying a
 * name from the sentence above it requires having read the sentence.
 */
function DeleteConfirmation({
  account,
  runtime,
  onCancel,
  onDeleted,
}: {
  readonly account: AccountSummary
  readonly runtime: SettingsRuntime
  readonly onCancel: () => void
  readonly onDeleted: (outcome: AccountDeletionOutcome) => void
}): ReactNode {
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    runtime
      .previewDeletion(account.id)
      .then((next) => {
        if (live) {
          setPreview(next)
          setPreviewError(null)
        }
      })
      .catch((error: unknown) => {
        if (live) setPreviewError(describe(error))
      })
    return () => {
      live = false
    }
  }, [runtime, account.id])

  const confirmed = typed.trim() === account.label
  const fieldId = `set-del-${account.id}`

  const remove = (event: FormEvent): void => {
    event.preventDefault()
    if (!confirmed) return
    setBusy(true)
    runtime
      .deleteAccount(account.id)
      .then((result) => {
        onDeleted(result)
      })
      .catch((error: unknown) => {
        setNote(describe(error))
        setBusy(false)
      })
  }

  return (
    <div className="set-danger" role="group" aria-label={`Delete ${account.label}`}>
      <div className="set-danger-head">
        <Badge tone="crit">Irreversible</Badge>
        <span className="set-danger-title">Delete {account.label}</span>
      </div>

      {previewError !== null && (
        <p className="set-note set-note-bad" role="status">
          Misal could not read what this would destroy, so it will not offer to destroy it:{' '}
          {previewError}. Nothing has been changed.
        </p>
      )}

      {preview === null ? (
        previewError === null && <p className="conf">Counting what this would remove…</p>
      ) : (
        <>
          <p className="set-danger-lede">
            This permanently deletes <b>{String(preview.transactions)}</b>{' '}
            {preview.transactions === 1 ? 'transaction' : 'transactions'} and{' '}
            <b>{String(preview.holdings)}</b>{' '}
            {preview.holdings === 1 ? 'holding' : 'holdings'}, currently valued at{' '}
            <b>{accountValueText(account)}</b>. There is no undo and no backup is taken.
          </p>

          <ul className="set-danger-list">
            <li>
              <b>{String(preview.documentsRemoved)}</b> imported{' '}
              {preview.documentsRemoved === 1 ? 'statement' : 'statements'} and their import history
              go with it. Re-importing the same file afterwards is how you would get this data back —
              if you still have the file.
            </li>
            {preview.documentsShared > 0 && (
              <li>
                <b>{String(preview.documentsShared)}</b>{' '}
                {preview.documentsShared === 1 ? 'statement is' : 'statements are'} shared with
                another account and {preview.documentsShared === 1 ? 'is' : 'are'} kept — the rows
                they carry for that account are not this account&rsquo;s to destroy.
              </li>
            )}
            {preview.queueEntries > 0 && (
              <li>
                <b>{String(preview.queueEntries)}</b> review-queue{' '}
                {preview.queueEntries === 1 ? 'entry' : 'entries'} raised by this account{' '}
                {preview.queueEntries === 1 ? 'disappears' : 'disappear'}. Their value stops being
                withheld because the holding itself is gone, so net worth may move.
              </li>
            )}
            {preview.hasCredential && (
              <li>
                The API key stored in your operating system&rsquo;s keychain is deleted first, before
                any row is removed. If the keychain refuses, nothing is deleted at all.
              </li>
            )}
            {preview.syncCursors > 0 && (
              <li>
                <b>{String(preview.syncCursors)}</b> sync{' '}
                {preview.syncCursors === 1 ? 'cursor goes' : 'cursors go'} with it, so reconnecting
                this exchange later re-walks its history from the beginning.
              </li>
            )}
            <li>
              Instruments, prices and exchange rates are kept. They are shared with your other
              accounts and are not this account&rsquo;s property.
            </li>
          </ul>

          <form className="set-danger-form" onSubmit={remove}>
            <label className="lab" htmlFor={fieldId}>
              Type <b>{account.label}</b> to confirm
            </label>
            <div className="set-field-row">
              <input
                id={fieldId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                placeholder={account.label}
                onChange={(event) => {
                  setTyped(event.target.value)
                  setNote(null)
                }}
              />
              <button className="btn btn-danger" type="submit" disabled={!confirmed || busy}>
                Delete this account permanently
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={onCancel}
              >
                Keep it
              </button>
            </div>
          </form>
        </>
      )}

      {note !== null && (
        <p className="set-note set-note-bad" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * The account's value as a sentence fragment for the warning.
 *
 * A metric that was not measured says why, in the engine's own words, rather than appearing as a
 * blank in the middle of a sentence about what is about to be destroyed.
 */
function accountValueText(account: AccountSummary): string {
  if (account.value === null) return account.valueUnavailable ?? 'a value Misal could not compute'
  if (!account.value.measured) return `a value Misal could not compute — ${REASON_TEXT[account.value.reason]}`
  return formatFigure(account.value.value)
}

// ---------------------------------------------------------------------------
// Manual prices
// ---------------------------------------------------------------------------

function ManualPrices({
  overrides,
  instruments,
  runtime,
  onChanged,
}: {
  readonly overrides: readonly ManualPriceRow[]
  readonly instruments: readonly InstrumentOption[]
  readonly runtime: SettingsRuntime
  readonly onChanged: () => void
}): ReactNode {
  const [instrumentId, setInstrumentId] = useState('')
  const [asOf, setAsOf] = useState('')
  const [close, setClose] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const chosen = instruments.find((instrument) => instrument.id === instrumentId)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (instrumentId === '') {
      setFailed(true)
      setNote('Choose the instrument this price is for.')
      return
    }
    const date = describeDateInput(asOf)
    if (!date.ok) {
      setFailed(true)
      setNote(date.message)
      return
    }
    const price = describePriceInput(close)
    if (!price.ok) {
      setFailed(true)
      setNote(price.message)
      return
    }

    setBusy(true)
    runtime
      .setManualPrice(instrumentId, date.value, price.value)
      .then(() => {
        setFailed(false)
        setNote(
          `Stored. ${chosen?.displayName ?? 'The instrument'} is valued at ${price.value} on ${date.value}, ` +
            'and this price now outranks anything a refresh fetches for that day.',
        )
        setClose('')
        onChanged()
      })
      .catch((error: unknown) => {
        setFailed(true)
        setNote(describe(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const remove = (row: ManualPriceRow): void => {
    setBusy(true)
    runtime
      .deleteManualPrice(row.instrumentId, row.asOf)
      .then(() => {
        setFailed(false)
        setNote(
          row.supersededSource === null
            ? `Removed. ${row.instrumentName} has no price for ${row.asOf} again, so its value is withheld from every total rather than estimated.`
            : `Removed. ${row.instrumentName} falls back to the ${row.supersededSource} price for ${row.asOf}.`,
        )
        onChanged()
      })
      .catch((error: unknown) => {
        setFailed(true)
        setNote(describe(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Panel
      title="Manual prices"
      meta={overrides.length === 0 ? 'none set' : `${String(overrides.length)} in force`}
      className="set-panel"
      foot="A manual price is stored beside any fetched price for the same day rather than replacing it, because the price table is keyed by source. Reads take the manual row first, and a refresh has no way to overwrite one — the fetched value stays underneath, and removing the override restores it."
    >
      <div className="panel-body">
        <p className="set-lede">
          Some holdings no provider covers: physical gold, an unlisted share, a fund whose registrar
          publishes no code, anything on a plan a key does not include. A price set here is how
          those enter net worth at all — it is the supported route, not a workaround.
        </p>

        <form className="set-price-form" onSubmit={submit}>
          <label className="set-field" htmlFor="set-price-instrument">
            <span className="lab">Instrument</span>
            <select
              id="set-price-instrument"
              value={instrumentId}
              onChange={(event) => {
                setInstrumentId(event.target.value)
                setNote(null)
              }}
            >
              <option value="">Choose an instrument…</option>
              {instruments.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.displayName}
                  {instrument.isin === null ? '' : ` — ${instrument.isin}`}
                </option>
              ))}
            </select>
          </label>

          <label className="set-field" htmlFor="set-price-date">
            <span className="lab">Date</span>
            <input
              id="set-price-date"
              type="date"
              value={asOf}
              onChange={(event) => {
                setAsOf(event.target.value)
                setNote(null)
              }}
            />
          </label>

          <label className="set-field" htmlFor="set-price-close">
            <span className="lab">
              Price per unit{chosen === undefined ? '' : ` · ${chosen.currency}`}
            </span>
            <input
              id="set-price-close"
              type="text"
              inputMode="decimal"
              value={close}
              placeholder="7412.00"
              onChange={(event) => {
                setClose(event.target.value)
                setNote(null)
              }}
            />
          </label>

          <button className="btn btn-strong" type="submit" disabled={busy}>
            Set price
          </button>
        </form>
        <p className="conf">
          Entered exactly as typed and stored as text, digit for digit. The currency is the
          instrument&rsquo;s own — a price in another currency would make the holding unpriceable
          rather than priced, so there is no field for it.
        </p>

        {note !== null && (
          <p className={failed ? 'set-note set-note-bad' : 'set-note'} role="status">
            {note}
          </p>
        )}

        {overrides.length === 0 ? (
          <EmptyState headline="No manual prices set">
            Nothing on this machine is priced by hand. Anything a provider cannot reach is reported
            as unpriced and held out of every total until a price is set here.
          </EmptyState>
        ) : (
          <table className="dtable set-overrides">
            <caption className="vh">Manual price overrides currently in force</caption>
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col">Date</th>
                <th scope="col" className="acct-num">
                  Price
                </th>
                <th scope="col">Supersedes</th>
                <th scope="col">Set</th>
                <th scope="col">
                  <span className="vh">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((row) => (
                <tr key={`${row.instrumentId}-${row.asOf}`}>
                  <th scope="row">
                    {row.instrumentName}
                    <span className="acct-prov">{row.assetClass.replace('_', ' ')}</span>
                  </th>
                  <td>{row.asOf}</td>
                  <td className="acct-num">{priceText(row.close, row.currency)}</td>
                  <td>
                    {row.supersededSource === null || row.supersededClose === null ? (
                      <span className="muted">no fetched price that day</span>
                    ) : (
                      <>
                        {priceText(row.supersededClose, row.currency)}
                        <span className="acct-prov">{row.supersededSource} · kept, not replaced</span>
                      </>
                    )}
                  </td>
                  <td>{row.recordedAt.slice(0, 10)}</td>
                  <td>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        remove(row)
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  )
}

/**
 * A stored price, shown digit for digit.
 *
 * Not rounded and not regrouped. This is the number the user typed and the number valuation will
 * multiply; displaying a tidier one would make the screen disagree with the database.
 */
function priceText(close: string, currency: string): string {
  const symbol =
    currency === 'INR' || currency === 'USD' ? CURRENCY_SYMBOL[currency] : `${currency} `
  return `${symbol}${close}`
}

// ---------------------------------------------------------------------------
// What leaves this machine
// ---------------------------------------------------------------------------

function WhatLeaves({
  network,
  providers,
}: {
  readonly network: readonly NetworkDestination[]
  readonly providers: readonly ProviderKeyStatus[]
}): ReactNode {
  // A keyed host is contacted only once some key is stored. Asked of the provider statuses rather
  // than of a provider id written here, so a second BYOK provider needs no change in this file.
  const anyKeyStored = providers.some((provider) => provider.status === 'present')
  const dormant = network.filter(
    (destination) => destination.requiresKey && !anyKeyStored,
  ).length

  return (
    <Panel
      title="What leaves this machine"
      meta={`${String(network.length)} hosts, generated from the allowlist`}
      className="set-panel"
      foot="This table is built from MARKET_DATA_HOSTS in the core — the same list the network layer checks every request against — rather than written as copy, so it cannot describe a version of Misal that no longer exists. A request to any other host is refused before a socket is opened, and redirects are refused outright rather than followed, because a followed redirect would leave the allowlist behind on the second hop."
    >
      <div className="panel-body">
        <p className="set-lede">
          Misal has no account, no sign-in, no server and no telemetry. Nothing is uploaded, and
          nothing is sent on a schedule. The only outbound requests are price and exchange-rate
          lookups, and they happen when you ask for a refresh. Here is every host that can be
          reached, and what is in the request.
        </p>

        <table className="dtable set-network">
          <caption className="vh">Hosts Misal may contact, and what each request contains</caption>
          <thead>
            <tr>
              <th scope="col">Host</th>
              <th scope="col">Path</th>
              <th scope="col">Why</th>
              <th scope="col">What is sent</th>
            </tr>
          </thead>
          <tbody>
            {network.map((destination) => (
              <tr key={destination.host}>
                <th scope="row">
                  {destination.host}
                  {destination.requiresKey && (
                    <span className="acct-prov">
                      {anyKeyStored ? 'key stored' : 'never contacted — no key'}
                    </span>
                  )}
                </th>
                <td className="set-mono">{destination.pathPrefix}</td>
                <td>{destination.purpose}</td>
                <td>{destination.sends}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="conf">
          {dormant === 0
            ? 'Every host above is reachable with the keys currently stored.'
            : `${String(dormant)} of these is contacted only when a provider key is stored, and none is.`}{' '}
          A connected exchange account is the one other door out: its requests go to that
          exchange&rsquo;s own host and are checked for withdrawal permission before they are sent.
          Statements you import are read from disk and never uploaded — only their checksum is kept.
        </p>
      </div>
    </Panel>
  )
}
