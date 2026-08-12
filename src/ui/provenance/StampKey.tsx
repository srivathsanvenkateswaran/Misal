/**
 * The stamp key — D2.
 *
 * In the mockup the key is a fixed block under the masthead. Permanent chrome that teaches is
 * chrome that shouts after week one, and it competes for the top of the screen with the
 * calibration bar, which must own it. So here it is a help affordance: a `?` button in the status
 * line, `Shift + /` from anywhere, and an inline expansion on first run.
 *
 * The content is the mockup's two key rows verbatim.
 */

import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import './SourceStamp.css'

interface KeyEntry {
  readonly code: string
  readonly variant: 'ledger' | 'snapshot' | 'derived' | 'alert'
  readonly text: string
}

const CODES: readonly KeyEntry[] = [
  { code: 'CAS', variant: 'ledger', text: 'CAMS / KFin consolidated statement' },
  { code: 'KIT', variant: 'ledger', text: 'Zerodha Kite tradebook' },
  { code: 'GRW', variant: 'ledger', text: 'Groww CSV export' },
  { code: 'DCX', variant: 'ledger', text: 'CoinDCX read-only API' },
  { code: 'ETR', variant: 'snapshot', text: 'E*TRADE snapshot' },
  { code: 'DRV', variant: 'derived', text: 'Derived from ledger rows' },
]

const BORDERS: readonly KeyEntry[] = [
  { code: 'Abc', variant: 'ledger', text: 'Solid — ledger-backed and current' },
  { code: 'Abc', variant: 'snapshot', text: 'Dashed — snapshot only, no transaction history' },
  { code: 'Abc', variant: 'derived', text: 'Dotted — derived rather than observed' },
  {
    code: 'Abc',
    variant: 'alert',
    text: 'Alert ink — stale, estimated or unresolved. Colour is spent on nothing else.',
  },
]

const CLASS_FOR: Record<KeyEntry['variant'], string> = {
  ledger: 'pmark-ledger',
  snapshot: 'pmark-snapshot',
  derived: 'pmark-derived',
  alert: 'pmark-alert',
}

function Sample({ entry }: { readonly entry: KeyEntry }): ReactNode {
  return (
    <span className={`ki ${CLASS_FOR[entry.variant]}`}>
      <span className="pcode">{entry.code}</span>
      {entry.text}
    </span>
  )
}

/** The key's content, without any chrome. Reused by the popover and by the first-run expansion. */
export function StampKeyContent(): ReactNode {
  return (
    <>
      <div className="stampkey-row">
        {CODES.map((entry) => (
          <Sample key={`${entry.code}-${entry.variant}`} entry={entry} />
        ))}
        <span className="ki muted">
          Second line under each code is the page, row or key — p.12 · r.318 · api key
        </span>
      </div>
      <div className="stampkey-row">
        {BORDERS.map((entry) => (
          <Sample key={entry.variant} entry={entry} />
        ))}
      </div>
    </>
  )
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export interface StampKeyProps {
  /** Rendered expanded and inline, until dismissed, on first run (`prefs.stampKeySeen`). */
  readonly defaultOpen?: boolean
  readonly onDismiss?: () => void
}

/**
 * The `?` button and its dialog. Also bound to `Shift + /` from anywhere, which is why the key
 * handler is on the document rather than on the button.
 */
export function StampKeyButton({ defaultOpen = false, onDismiss }: StampKeyProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const dialog = useRef<HTMLDivElement | null>(null)
  const labelId = useId()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        setOpen(true)
      }
    }
    globalThis.document.addEventListener('keydown', onKeyDown)
    return () => {
      globalThis.document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const first = dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
  }, [open])

  const close = (): void => {
    setOpen(false)
    onDismiss?.()
    trigger.current?.focus()
  }

  return (
    <span className="pmark-wrap">
      <button
        ref={trigger}
        type="button"
        className="stampkey-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((wasOpen) => !wasOpen)
        }}
      >
        ? <span className="vh">What the source stamps mean</span>
      </button>
      {open && (
        <div
          ref={dialog}
          role="dialog"
          aria-modal="false"
          aria-labelledby={labelId}
          className="stampkey"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              close()
              return
            }
            if (event.key !== 'Tab') return
            const nodes = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
            if (nodes === undefined || nodes.length === 0) return
            const first = nodes[0]
            const last = nodes[nodes.length - 1]
            if (first === undefined || last === undefined) return
            if (event.shiftKey && globalThis.document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && globalThis.document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }}
        >
          <div className="stampkey-lab" id={labelId}>
            Marginal source stamp
            <span>Every figure carries, in the margin of its row, the document it came from</span>
            <button className="btn" type="button" onClick={close}>
              Close
            </button>
          </div>
          <StampKeyContent />
        </div>
      )}
    </span>
  )
}
