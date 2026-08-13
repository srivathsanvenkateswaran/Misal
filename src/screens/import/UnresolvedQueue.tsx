/**
 * The unresolved-instrument review queue.
 *
 * **It never blocks.** There is no modal, no "resolve before continuing", and no gate on
 * navigation: the import already completed and these entries are a task, not a failure. What each
 * entry states is the exact amount its rows withhold from every total, because "some holdings
 * unresolved" is not a fact a user can act on and "₹1,18,640 withheld" is.
 *
 * Nothing here guesses. Misal never creates an instrument from a statement and never fuzzy-matches
 * a name, so the mapping control is a search over instruments the database already holds and the
 * confidence line says plainly when there is no candidate.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { dec, minor } from '@domain/numeric'
import { SourceStamp, formatMoney, formatQty, money } from '@ui/index'
import type { UnresolvedEntryRow } from '../../data/import'
import './import.css'

export interface InstrumentChoice {
  readonly id: string
  readonly displayName: string
  readonly isin: string | null
  readonly assetClass: string
}

export interface UnresolvedQueueProps {
  readonly entries: readonly UnresolvedEntryRow[]
  readonly instruments: readonly InstrumentChoice[]
  /** Provider short code for the gutter stamp, e.g. 'CAS'. */
  readonly stampCode: string
  readonly onMap: (entryId: string, instrumentId: string) => void
  readonly onIgnore: (entryId: string) => void
  /** The entry currently being written, if any. */
  readonly busyId?: string | null
  readonly foot?: ReactNode
}

const MAX_CANDIDATES = 25

export function UnresolvedQueue(props: UnresolvedQueueProps): ReactNode {
  const open = props.entries.length

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Unresolved instruments — review queue</span>
        <span className="panel-meta">
          {open === 0 ? 'nothing open' : `${String(open)} open · dismissible`}
        </span>
      </div>
      <div className="panel-body">
        {open === 0 ? (
          <p className="muted">
            Nothing unresolved — every identifier in this document is mapped to an instrument.
          </p>
        ) : (
          props.entries.map((entry) => (
            <QueueItem
              key={entry.id}
              entry={entry}
              instruments={props.instruments}
              stampCode={props.stampCode}
              busy={props.busyId === entry.id}
              onMap={props.onMap}
              onIgnore={props.onIgnore}
            />
          ))
        )}

        {open > 0 && (
          <p className="conf imp-queue-standing">
            Dismissed items stay in Settings → Review queue. The import stands either way.
          </p>
        )}
      </div>
      {props.foot !== undefined && <div className="foot">{props.foot}</div>}
    </div>
  )
}

function QueueItem({
  entry,
  instruments,
  stampCode,
  busy,
  onMap,
  onIgnore,
}: {
  readonly entry: UnresolvedEntryRow
  readonly instruments: readonly InstrumentChoice[]
  readonly stampCode: string
  readonly busy: boolean
  readonly onMap: (entryId: string, instrumentId: string) => void
  readonly onIgnore: (entryId: string) => void
}): ReactNode {
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState('')
  const candidates = filterInstruments(instruments, search, entry.assetClassHint).slice(
    0,
    MAX_CANDIDATES,
  )
  const searchId = `imp-q-search-${entry.id}`
  const selectId = `imp-q-select-${entry.id}`

  return (
    <div className="imp-queue-item">
      <div className="pgut">
        <SourceStamp
          code={stampCode}
          reference={referenceOf(entry)}
          variant="snapshot"
          alert
          description={`${entry.rawName ?? entry.rawIdentifier} is not identified yet, so its value is held out of every total.`}
        />
      </div>
      <div className="imp-queue-body">
        <div className="imp-queue-head">
          <div>
            <span className="lab">{identifierLabel(entry.rawIdentifier)}</span>
            <div className="imp-raw">{identifierValue(entry.rawIdentifier)}</div>
            <div className="sublab">{context(entry)}</div>
          </div>
          <span className="badge badge-warn">Needs mapping</span>
        </div>

        <div className="imp-map">
          <label className="imp-field" htmlFor={searchId}>
            <span className="lab">Search instruments</span>
            <input
              id={searchId}
              type="search"
              value={search}
              placeholder="Name or ISIN"
              onChange={(event) => {
                setSearch(event.target.value)
                setChosen('')
              }}
            />
          </label>

          <label className="imp-field" htmlFor={selectId}>
            <span className="lab">Map to</span>
            <select
              id={selectId}
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value)
              }}
            >
              <option value="">Choose an instrument…</option>
              {candidates.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.displayName}
                  {instrument.isin === null ? '' : ` — ${instrument.isin}`}
                </option>
              ))}
            </select>
          </label>

          <span className="conf">
            No confident match — Misal does not identify an instrument from a name, so this one is
            yours to choose.
          </span>

          <div className="imp-queue-actions">
            <button
              className="btn btn-strong"
              type="button"
              disabled={chosen === '' || busy}
              onClick={() => {
                onMap(entry.id, chosen)
              }}
            >
              Map
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                onIgnore(entry.id)
              }}
            >
              Dismiss for now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function filterInstruments(
  instruments: readonly InstrumentChoice[],
  search: string,
  assetClassHint: string | null,
): readonly InstrumentChoice[] {
  const needle = search.trim().toLowerCase()
  const hinted =
    assetClassHint === null
      ? instruments
      : [
          ...instruments.filter((i) => i.assetClass === assetClassHint),
          ...instruments.filter((i) => i.assetClass !== assetClassHint),
        ]
  if (needle === '') return hinted
  return hinted.filter(
    (instrument) =>
      instrument.displayName.toLowerCase().includes(needle) ||
      (instrument.isin !== null && instrument.isin.toLowerCase().includes(needle)),
  )
}

/** `isin:INF179K01YV8` → `Unrecognised ISIN`. The prefix is what the parser could read. */
function identifierLabel(rawIdentifier: string): string {
  const prefix = rawIdentifier.split(':')[0] ?? ''
  switch (prefix) {
    case 'isin':
      return 'Unrecognised ISIN'
    case 'amfi':
      return 'Unrecognised AMFI scheme code'
    case 'nse':
    case 'bse':
      return `Unrecognised ${prefix.toUpperCase()} symbol`
    case 'nasdaq':
    case 'nyse':
      return `Unrecognised ${prefix.toUpperCase()} ticker`
    case 'provider-local':
      return 'Unrecognised broker code'
    case 'name':
      return 'Unrecognised name — the source printed no identifier'
    default:
      return 'Unrecognised identifier'
  }
}

function identifierValue(rawIdentifier: string): string {
  const at = rawIdentifier.indexOf(':')
  return at === -1 ? rawIdentifier : rawIdentifier.slice(at + 1)
}

function referenceOf(entry: UnresolvedEntryRow): string {
  return entry.observedQuantity === null ? 'txn rows' : 'holding'
}

/**
 * The sub-line: what it is called, how much of it there is, and what that withholds.
 *
 * Where the source printed no value there is nothing honest to put here, so it says so rather than
 * showing a zero — a zero would read as "worth nothing" for a holding whose value is simply
 * unknown.
 */
function context(entry: UnresolvedEntryRow): string {
  const parts: string[] = []
  if (entry.rawName !== null && entry.rawName !== '') parts.push(`“${entry.rawName}”`)
  if (entry.observedQuantity !== null) parts.push(`${quantity(entry.observedQuantity)} units`)
  const value = withheldValue(entry)
  parts.push(
    value === null
      ? 'the source stated no value for it'
      : `${value} withheld from every total`,
  )
  return parts.join(' · ')
}

/** Minor units in, a string out. Nothing between the two is a number. */
export function withheldValue(entry: UnresolvedEntryRow): string | null {
  const raw = entry.observedValueMinor
  if (raw === null || raw === '') return null
  const currency = entry.currency
  // An unknown currency has no formatting rule here, and inventing one would misstate the figure.
  if (currency !== 'INR' && currency !== 'USD') return null
  try {
    return formatMoney(money(minor(raw), currency))
  } catch {
    return null
  }
}

/**
 * A stored quantity, grouped for display with its trailing zeros intact.
 *
 * The value is written by the pipeline and is canonical by construction, but a queue entry is the
 * one place a half-parsed number can reach the screen. Showing it verbatim beats throwing the
 * whole review away over a formatting detail.
 */
function quantity(value: string): string {
  try {
    return formatQty(dec(value))
  } catch {
    return value
  }
}
