/**
 * Screen 06 — Settings.
 *
 * There is no settings screen in the approved mockup, so nothing here is invented: the frame, the
 * panels, the labels, the buttons and the rules are the ones the other five screens already use.
 * What is new is only the arrangement.
 *
 * Four things live on this screen, and each is here for a reason the others are not.
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
 */

import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dec } from '@domain/numeric'
import { CURRENCY_SYMBOL } from '@ui/index'
import { listInstruments } from '../../data/client'
import {
  clearProviderKey,
  deleteManualPrice,
  describeDateInput,
  describePriceInput,
  describeSettingInput,
  loadSettings,
  setManualPrice,
  setProviderKey,
  settingValue,
  writeSetting,
} from '../../data/settings'
import type {
  ManualPriceRow,
  NetworkDestination,
  ProviderKeyStatus,
  SettingDefinition,
  SettingsSnapshot,
} from '../../data/settings'
import { Badge, EmptyState, ErrorState, Panel, ScreenHead } from '../chrome'
import './settings.css'

/** One instrument, as the override picker needs it. */
export interface InstrumentOption {
  readonly id: string
  readonly displayName: string
  readonly isin: string | null
  readonly currency: string
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
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [next, catalogue] = await Promise.all([runtime.load(), runtime.listInstruments()])
      setSnapshot(next)
      setInstruments(catalogue)
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
            The four preferences, the provider keys and every manual price are read together, so the
            screen never shows half a state.
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
          decide whether a price is due. The other three are recorded but not yet consulted:
          staleness is judged per asset class inside the valuation engine, concentration is
          reported without a threshold, and the base currency is fixed to INR. They are saved so
          nothing is lost when those parts start reading them.
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
          <select
            id={fieldId}
            value={draft}
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
