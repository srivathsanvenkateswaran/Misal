/**
 * The app frame: the bar, the nav, the status line and the four generic states.
 *
 * Two rules from the spec live here rather than in each screen:
 *
 *  - **The status line is a factual readout, not marketing copy** (H11). "Local · <path>" is read
 *    from the real database handle, so it breaks visibly if the fact ever changes. When the handle
 *    cannot be read the line says so; it does not fall back to the claim.
 *  - **Route change moves focus to the screen's `<h1>`** and updates the document title, so a
 *    screen-reader user is told where they are and focus is never lost to `<body>`.
 */

import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import type { StorageStatus } from '../data/client'
import { NAV, hrefFor } from './route'
import type { Route } from './route'
import './screens.css'
import '@ui/base.css'

export interface AppBarProps {
  readonly route: Route
  readonly status: StorageStatus | undefined
  readonly statusError: boolean
  readonly extra?: ReactNode
}

export function AppBar({ route, status, statusError, extra }: AppBarProps): ReactNode {
  return (
    <div className="appbar">
      <nav className="nav" aria-label="Primary">
        {NAV.map((item) => {
          const current = item.kind === route.kind || (item.kind === 'instruments' && route.kind === 'instrument')
          return (
            <a
              key={item.kind}
              href={item.href}
              {...(current ? { 'aria-current': 'page' as const } : {})}
            >
              {item.label}
            </a>
          )
        })}
      </nav>
      <div className="statusline">
        {statusError ? (
          <span>Database handle unreadable — the local-only claim cannot be verified</span>
        ) : status === undefined ? (
          <span>Opening the local database…</span>
        ) : (
          <>
            <span>
              <span className="dot-local" aria-hidden="true" />
              Local · <b>{status.databasePath}</b>
            </span>
            <span>
              Encrypted at rest <b>{status.encrypted ? 'yes' : 'no'}</b>
            </span>
            <span>
              Schema <b>v{status.schemaVersion}</b>
            </span>
          </>
        )}
        {extra}
      </div>
    </div>
  )
}

export interface ScreenHeadProps {
  readonly title: string
  readonly note: string
  readonly actions?: ReactNode
}

/**
 * The screen heading. It takes focus on mount, which is what makes every route change announce
 * itself and what keeps focus off `<body>` after navigation.
 */
export function ScreenHead({ title, note, actions }: ScreenHeadProps): ReactNode {
  const heading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    globalThis.document.title = `${title} · Misal`
    heading.current?.focus()
  }, [title])

  return (
    <div className="screen-head">
      <h1 className="screen-title" tabIndex={-1} ref={heading}>
        {title}
      </h1>
      <span className="screen-note">{note}</span>
      {actions}
    </div>
  )
}

export function Panel({
  title,
  meta,
  children,
  foot,
  className,
}: {
  readonly title?: string
  readonly meta?: string
  readonly children: ReactNode
  readonly foot?: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <section className={className === undefined ? 'panel' : `panel ${className}`} aria-label={title}>
      {title !== undefined && (
        <div className="panel-head">
          <span className="panel-title">{title}</span>
          {meta !== undefined && <span className="panel-meta">{meta}</span>}
        </div>
      )}
      {children}
      {foot !== undefined && <div className="foot">{foot}</div>}
    </section>
  )
}

/** A sentence naming what is absent and the action that would fill it. Never a zero-valued screen. */
export function EmptyState({
  headline,
  children,
}: {
  readonly headline: string
  readonly children?: ReactNode
}): ReactNode {
  return (
    <div className="emptystate">
      <b>{headline}</b>
      {children}
    </div>
  )
}

/**
 * The panel head persists above this, so the user knows *what* failed. Data errors are never
 * toasts: a toast vanishes and the wrong number does not.
 */
export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string
  readonly onRetry?: () => void
}): ReactNode {
  return (
    <div className="errorstate" role="alert">
      <p style={{ margin: '0 0 10px' }}>{message}</p>
      {onRetry !== undefined && (
        <button className="btn" type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'snapshot' | 'ok' | 'warn' | 'crit'
  readonly children: ReactNode
}): ReactNode {
  const classes: Record<string, string> = {
    neutral: 'badge',
    snapshot: 'badge badge-snap',
    ok: 'badge badge-ok',
    warn: 'badge badge-warn',
    crit: 'badge badge-crit',
  }
  return <span className={classes[tone] ?? 'badge'}>{children}</span>
}

/** 8px, `aria-hidden`, always adjacent to the class name in text (§11.4). */
export function ClassDot({ series }: { readonly series: string }): ReactNode {
  return <span className={`classdot cd-${series}`} aria-hidden="true" />
}

export function InstrumentLink({
  instrumentId,
  children,
}: {
  readonly instrumentId: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <a className="linkish" href={hrefFor({ kind: 'instrument', instrumentId })}>
      {children}
    </a>
  )
}
