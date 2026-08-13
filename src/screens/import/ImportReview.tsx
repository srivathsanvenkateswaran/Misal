/**
 * The import report (screen 4 of the approved design).
 *
 * The framing is fixed and it is the whole point of the screen: **a partial import is a completed
 * import.** The banner is the good-status rule, the failures are a list, and the second line says
 * outright that nothing was rolled back — because a user who has just handed a financial
 * application a statement and been shown a warning will otherwise assume their data is in an
 * unknown state.
 *
 * Two deviations from the mockup, both from the specs rather than from taste:
 *   D4 — no "Stored at" row. Misal records the checksum and the metadata, never the bytes, and a
 *        storage path would be a false claim about where the user's PDF is.
 *   The mockup's per-instrument match confidences are not shown, because v1 has no instrument
 *        master to compute one from and a fabricated 0.96 is worse than no number.
 */

import type { ReactNode } from 'react'
import { DataTable, formatIndianGroups, type DataTableRow } from '@ui/index'
import type { ImportCounters, Issue } from '@ingestion/index'
import type { UnresolvedEntryRow } from '../../data/import'
import { UnresolvedQueue, type InstrumentChoice } from './UnresolvedQueue'
import './import.css'

export interface ImportedFile {
  readonly name: string
  readonly byteLength: number
}

export interface ImportReviewProps {
  readonly file: ImportedFile
  readonly contentHash: string
  readonly documentId: string
  readonly runId: string
  readonly pluginId: string
  readonly parserLabel: string
  /** 'CAS' | 'NSD' | 'KIT' … the provider's stamp code. */
  readonly stampCode: string
  readonly pageRef: string
  /** How the file was opened, in words. Never the value. */
  readonly unlockedWith: string
  readonly counters: ImportCounters
  readonly issues: readonly Issue[]
  readonly accountCount: number
  readonly unresolved: readonly UnresolvedEntryRow[]
  readonly instruments: readonly InstrumentChoice[]
  readonly onMap: (entryId: string, instrumentId: string) => void
  readonly onIgnore: (entryId: string) => void
  readonly busyId?: string | null
  readonly onImportAnother?: () => void
}

interface ReadRow {
  readonly label: string
  readonly count: number
  readonly note: ReactNode
  readonly stamp: { readonly code: string; readonly reference: string; readonly alert: boolean }
}

export function ImportReview(props: ImportReviewProps): ReactNode {
  const { counters } = props
  const errors = props.issues.filter((issue) => issue.severity === 'error')
  const warnings = props.issues.filter((issue) => issue.severity === 'warning')
  const openQueue = props.unresolved.length

  return (
    <section className="imp-review" aria-labelledby="imp-result">
      <div className="imp-banner">
        <span className="lab">Result</span>
        <h2 id="imp-result" className="imp-banner-line" tabIndex={-1}>
          {headline(counters, openQueue)}
        </h2>
        <p className="imp-banner-sub">
          Nothing was rolled back. {rolledBackDetail(counters, openQueue)}
        </p>
      </div>

      <div className="imp-grid">
        <div>
          <div className="panel imp-panel">
            <div className="panel-head">
              <span className="panel-title">Source document</span>
              <span className="panel-meta">Provenance</span>
            </div>
            <div className="panel-body">
              <dl className="imp-kv">
                <dt>File</dt>
                <dd>
                  {props.file.name} <span className="muted">· {kilobytes(props.file.byteLength)}</span>
                </dd>
                <dt>Parser</dt>
                <dd>
                  {props.parserLabel} <span className="muted">· {props.pluginId}</span>
                </dd>
                <dt>Unlocked with</dt>
                <dd>
                  {props.unlockedWith} <span className="muted">· not stored</span>
                </dd>
                <dt>Checksum</dt>
                <dd>sha256 {shortHash(props.contentHash)}</dd>
                {/* D4: the file itself is not copied anywhere, so there is no path to show. */}
                <dt>Read from</dt>
                <dd>
                  {props.file.name}{' '}
                  <span className="muted">· not copied — Misal recorded the checksum only</span>
                </dd>
                <dt>Import run</dt>
                <dd>{props.runId}</dd>
              </dl>
            </div>
          </div>

          <div className="panel imp-panel">
            <div className="panel-head">
              <span className="panel-title">What was read</span>
              <span className="panel-meta">Row-level</span>
            </div>
            <DataTable<ReadRow>
              caption="What this import read and what it did with it"
              columns={[
                { id: 'label', header: 'Measure', cell: (row) => row.label },
                { id: 'count', header: 'Rows', align: 'right', cell: (row) => String(row.count) },
                { id: 'note', header: 'Detail', cell: (row) => row.note },
              ]}
              rows={readRows(props, openQueue).map(
                (row): DataTableRow<ReadRow> => ({
                  kind: 'data',
                  key: row.label,
                  row,
                  stamp: {
                    code: row.stamp.code,
                    reference: row.stamp.reference,
                    variant: row.stamp.code === 'DRV' ? 'derived' : 'ledger',
                    alert: row.stamp.alert,
                    description: `${row.label}: ${String(row.count)} rows, read from ${props.file.name}.`,
                  },
                }),
              )}
              foot={
                <>
                  Every count above reconciles: {String(counters.committed)} applied +{' '}
                  {String(counters.duplicate)} already present + {String(counters.skipped)} skipped +{' '}
                  {String(counters.failed)} failed = {String(counters.read)} read.
                </>
              }
            />
          </div>

          <div className="panel imp-panel">
            <div className="panel-head">
              <span className="panel-title">Row errors — {String(errors.length)}</span>
              <span className="panel-meta">Skipped, not lost</span>
            </div>
            <DataTable<Issue>
              caption="Rows this import could not read"
              state={errors.length === 0 ? 'empty' : 'ready'}
              emptyMessage="Every row parsed."
              columns={[
                { id: 'where', header: 'Location', cell: (issue) => issue.ref ?? 'document' },
                { id: 'code', header: 'Code', cell: (issue) => issue.code },
                { id: 'why', header: 'Reason', cell: (issue) => issue.message },
              ]}
              rows={errors.map(
                (issue, index): DataTableRow<Issue> => ({
                  kind: 'data',
                  key: `${issue.code}-${String(index)}`,
                  row: issue,
                  stamp: {
                    code: props.stampCode,
                    reference: issue.ref ?? props.pageRef,
                    variant: 'ledger',
                    alert: true,
                    description: `${issue.code} at ${issue.ref ?? 'document level'}: ${issue.message}`,
                  },
                }),
              )}
              foot={
                <>
                  Skipped rows do not affect the {String(counters.committed)} applied. Fix them by
                  importing a corrected statement — Misal skips everything it already has.
                </>
              }
            />
          </div>

          {warnings.length > 0 && (
            <div className="panel imp-panel">
              <div className="panel-head">
                <span className="panel-title">Notes — {String(warnings.length)}</span>
                <span className="panel-meta">Nothing failed</span>
              </div>
              <ul className="imp-warnings">
                {warnings.map((issue, index) => (
                  <li key={`${issue.code}-${String(index)}`}>
                    <span className="badge badge-warn">{issue.code}</span> {issue.message}
                    {issue.ref === undefined ? null : <span className="muted"> · {issue.ref}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <UnresolvedQueue
            entries={props.unresolved}
            instruments={props.instruments}
            stampCode={props.stampCode}
            onMap={props.onMap}
            onIgnore={props.onIgnore}
            busyId={props.busyId ?? null}
            foot={queueFoot(counters, openQueue)}
          />

          {props.onImportAnother !== undefined && (
            <div className="imp-next">
              <button className="btn" type="button" onClick={props.onImportAnother}>
                Import another statement
              </button>
              <span className="conf">
                Each file is its own run, and order does not matter — anything already stored is
                recognised and skipped.
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function readRows(props: ImportReviewProps, openQueue: number): readonly ReadRow[] {
  const { counters, stampCode, pageRef } = props
  const errors = props.issues.filter((issue) => issue.severity === 'error').length
  return [
    {
      label: 'Accounts named',
      count: props.accountCount,
      note: <span className="muted">folios and demat accounts this file declared</span>,
      stamp: { code: stampCode, reference: pageRef, alert: false },
    },
    {
      label: 'Rows read',
      count: counters.read,
      note: <span className="muted">transactions and holdings the parser recognised</span>,
      stamp: { code: stampCode, reference: pageRef, alert: false },
    },
    {
      label: 'Applied',
      count: counters.committed,
      note: <span className="badge badge-ok">Applied</span>,
      stamp: { code: 'DRV', reference: 'ledger', alert: false },
    },
    {
      label: 'Already present',
      count: counters.duplicate,
      note: <span className="muted">recognised by natural key from an earlier import</span>,
      stamp: { code: 'DRV', reference: 'sha256', alert: false },
    },
    {
      label: 'Skipped',
      count: counters.skipped,
      note: (
        <span className="muted">
          non-financial rows, plus {String(counters.withheld)} withheld pending an instrument
        </span>
      ),
      stamp: { code: stampCode, reference: pageRef, alert: counters.withheld > 0 },
    },
    {
      label: 'Rows with errors',
      count: counters.failed,
      note:
        counters.failed === 0 ? (
          <span className="muted">none</span>
        ) : (
          <span className="badge badge-warn">Skipped</span>
        ),
      stamp: { code: stampCode, reference: `${String(errors)} rows`, alert: counters.failed > 0 },
    },
    {
      label: 'Unresolved instruments',
      count: openQueue,
      note:
        openQueue === 0 ? (
          <span className="muted">every identifier is mapped</span>
        ) : (
          <span className="badge badge-warn">Queued</span>
        ),
      stamp: { code: stampCode, reference: 'queue', alert: openQueue > 0 },
    },
  ]
}

function headline(counters: ImportCounters, openQueue: number): string {
  const applied = `${String(counters.committed)} rows applied`
  if (openQueue === 0) return `Import completed — ${applied}`
  const needs =
    openQueue === 1
      ? '1 instrument needs your input'
      : `${String(openQueue)} instruments need your input`
  return `Import completed — ${applied}, ${needs}`
}

function rolledBackDetail(counters: ImportCounters, openQueue: number): string {
  const parts: string[] = []
  if (counters.failed > 0) {
    parts.push(
      `${String(counters.failed)} rows could not be read and are listed below; the rest committed`,
    )
  }
  if (openQueue > 0) {
    parts.push(
      `the ${String(openQueue)} unidentified instruments are parked in the queue and can be mapped whenever you like`,
    )
  }
  if (parts.length === 0) return 'Every row was read and applied.'
  return `${parts.join(', and ')}.`
}

function queueFoot(counters: ImportCounters, openQueue: number): ReactNode {
  if (openQueue === 0) {
    return 'Nothing is being withheld from your totals by this import.'
  }
  return `${String(counters.withheld)} rows are withheld from every total until these are mapped. Mapping one teaches Misal the identifier, so the next statement carrying it resolves without asking; the rows already withheld are released when a document containing them is imported again.`
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 4)}…${hash.slice(-4)}`
}

/**
 * A file size, rounded up to whole kilobytes.
 *
 * Integer arithmetic even though a byte count is not money: the float ban is blanket outside the
 * two exempt directories, and a size is one of the places a reviewer should not have to stop and
 * decide whether an exception was justified.
 */
function kilobytes(byteLength: number): string {
  const kb = (BigInt(byteLength) + 1023n) / 1024n
  return `${formatIndianGroups(kb.toString())} kB`
}
