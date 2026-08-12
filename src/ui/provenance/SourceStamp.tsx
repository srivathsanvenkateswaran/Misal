/**
 * `SourceStamp` — the marginal source mark (spec §8.2).
 *
 * Every figure traceable to a document carries one of these in the margin of its row (H6). The
 * mark is a `<button>`, never a `div` with a click handler, and it never sits inline in a data
 * cell: the gutter is what ties five different layouts together.
 *
 * Border style — not colour — carries data health, which is what frees alert ink to mean exactly
 * one thing everywhere else in the product:
 *
 *   solid   ledger-backed and current
 *   dashed  snapshot only, no transaction history
 *   dotted  derived rather than observed
 *   alert   stale, estimated or unresolved — the only colour variant
 *
 * The three-letter code is not the accessible name. A screen reader gets the full sentence
 * (`description`), because "CAS" is a lookup and a sentence is an answer.
 */

import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import './SourceStamp.css'

export type StampVariant = 'ledger' | 'snapshot' | 'derived'

export interface StampDocument {
  readonly id: string
  readonly name: string
  readonly hashShort: string
  readonly importedAt: string
  readonly pageRef?: string
  readonly runId?: string
}

export interface SourceStampProps {
  /** 'CAS' | 'KIT' | 'GRW' | 'DCX' | 'ETR' | 'DRV' — from `provider.short_code` when it exists. */
  readonly code: string
  /** The page, row or key the figure came from: 'p.4-9', 'r.318', 'api key', 'fifo'. */
  readonly reference: string
  readonly variant: StampVariant
  /** Stale, estimated or unresolved. The one place alert ink is spent on a stamp (H7, H9). */
  readonly alert?: boolean
  /** A full sentence. Used as the accessible name and shown on hover or focus after 400 ms. */
  readonly description: string
  readonly document?: StampDocument
  readonly onOpenImportRun?: (runId: string) => void
}

const HOVER_DELAY_MS = 400

const VARIANT_CLASS: Record<StampVariant, string> = {
  ledger: 'pmark-ledger',
  snapshot: 'pmark-snapshot',
  derived: 'pmark-derived',
}

export function SourceStamp(props: SourceStampProps): ReactNode {
  const { code, reference, variant, description, document: doc } = props
  const alert = props.alert === true
  const descriptionId = useId()
  const [tipShown, setTipShown] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const openTipAfterDelay = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setTipShown(true)
    }, HOVER_DELAY_MS)
  }

  const closeTip = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    setTipShown(false)
  }

  const close = (): void => {
    closeTip()
    setPopoverOpen(false)
    button.current?.focus()
  }

  return (
    <span
      className="pmark-wrap"
      onMouseEnter={openTipAfterDelay}
      onMouseLeave={closeTip}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (popoverOpen || tipShown)) {
          event.stopPropagation()
          close()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`pmark ${VARIANT_CLASS[variant]}${alert ? ' pmark-alert' : ''}`}
        data-stamp-variant={variant}
        data-stamp-alert={alert ? 'true' : undefined}
        aria-label={description}
        aria-describedby={descriptionId}
        aria-expanded={doc === undefined ? undefined : popoverOpen}
        onFocus={openTipAfterDelay}
        onBlur={closeTip}
        onClick={() => {
          if (doc !== undefined) setPopoverOpen((open) => !open)
        }}
      >
        <span className="pcode">{code}</span>
        <span className="pref">{reference}</span>
      </button>

      {/* The sentence is in the DOM whether or not it is visible, so it is available to assistive
          technology without waiting on a hover that a keyboard user will never perform. */}
      <span id={descriptionId} className="vh">
        {description}
      </span>

      {tipShown && !popoverOpen && (
        <span role="tooltip" className="pmark-tip">
          {description}
        </span>
      )}

      {popoverOpen && doc !== undefined && (
        <ProvenancePopover
          document={doc}
          onClose={close}
          onOpenImportRun={props.onOpenImportRun}
        />
      )}
    </span>
  )
}

function ProvenancePopover({
  document: doc,
  onClose,
  onOpenImportRun,
}: {
  readonly document: StampDocument
  readonly onClose: () => void
  readonly onOpenImportRun: ((runId: string) => void) | undefined
}): ReactNode {
  const runId = doc.runId
  const pageRef = doc.pageRef
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`Source of this figure: ${doc.name}`}
      className="pmark-pop"
    >
      <dl>
        <dt>Document</dt>
        <dd>{doc.name}</dd>
        <dt>Checksum</dt>
        <dd>{doc.hashShort}</dd>
        {pageRef !== undefined && (
          <>
            <dt>Reference</dt>
            <dd>{pageRef}</dd>
          </>
        )}
        <dt>Imported</dt>
        <dd>{doc.importedAt}</dd>
      </dl>
      <div className="pmark-pop-actions">
        {runId !== undefined && onOpenImportRun !== undefined && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              onOpenImportRun(runId)
            }}
          >
            Open import #{runId}
          </button>
        )}
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

/**
 * The 56px gutter itself.
 *
 * Rendering it with no stamp is deliberate and is used only where D1 applies — the dashboard
 * readout, where seven identical `DRV` marks would say nothing seven times. The spacer keeps the
 * left edge aligned, which is what ties the readout to the tables beneath it.
 */
export function StampGutter({
  stamp,
  className,
}: {
  readonly stamp?: SourceStampProps | undefined
  readonly className?: string | undefined
}): ReactNode {
  const classes = className === undefined ? 'pgut' : `pgut ${className}`
  if (stamp === undefined) {
    return (
      <div className={classes}>
        <span className="pgut-empty" aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className={classes}>
      <SourceStamp {...stamp} />
    </div>
  )
}
