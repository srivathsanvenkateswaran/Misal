import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { assertHonest } from '../testing/assert-honest'
import { SourceStamp, StampGutter } from './SourceStamp'
import { StampKeyButton } from './StampKey'

const BASE = {
  code: 'CAS',
  reference: 'p.4-9',
  description:
    'Source: CAMS/KFintech consolidated statement, pages 4–9. Full transaction history since April 2023.',
} as const

describe('SourceStamp', () => {
  it('is a real button, in the gutter, carrying a sentence as its accessible name', () => {
    const { container } = render(<SourceStamp {...BASE} variant="ledger" />)
    const button = screen.getByRole('button', { name: BASE.description })
    expect(button.tagName).toBe('BUTTON')
    expect(button.querySelector('.pcode')?.textContent).toBe('CAS')
    expect(button.querySelector('.pref')?.textContent).toBe('p.4-9')
    assertHonest(container)
  })

  it('encodes data health in the border style, not in colour', () => {
    const { container: ledger } = render(<SourceStamp {...BASE} variant="ledger" />)
    expect(ledger.querySelector('.pmark')?.className).toContain('pmark-ledger')

    const { container: snapshot } = render(
      <SourceStamp {...BASE} variant="snapshot" description="Snapshot only." />,
    )
    expect(snapshot.querySelector('.pmark')?.className).toContain('pmark-snapshot')

    const { container: derived } = render(
      <SourceStamp {...BASE} variant="derived" description="Derived from ledger rows." />,
    )
    expect(derived.querySelector('.pmark')?.className).toContain('pmark-derived')
  })

  it('spends alert ink only on the stale, estimated or unresolved variant', () => {
    const { container: plain } = render(<SourceStamp {...BASE} variant="snapshot" />)
    expect(plain.querySelector('[data-stamp-alert]')).toBeNull()

    const { container: alerting } = render(
      <SourceStamp {...BASE} variant="snapshot" alert description="15 days old." />,
    )
    expect(alerting.querySelector('[data-stamp-alert="true"]')).not.toBeNull()
    expect(alerting.querySelector('.pmark')?.className).toContain('pmark-alert')
  })

  it('describes itself as a sentence rather than as a three-letter code', () => {
    render(<SourceStamp {...BASE} variant="ledger" />)
    const button = screen.getByRole('button', { name: BASE.description })
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(BASE.description)
  })

  it('opens a provenance popover naming the document, its checksum and its import', () => {
    render(
      <SourceStamp
        {...BASE}
        variant="ledger"
        document={{
          id: 'doc-11',
          name: 'CAS_JUL2026.pdf',
          hashShort: 'sha256:9f2a…c108',
          importedAt: '12 Aug 2026 10:44',
          runId: '47',
        }}
        onOpenImportRun={() => undefined}
      />,
    )
    const button = screen.getByRole('button', { name: BASE.description })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog')).toHaveTextContent('CAS_JUL2026.pdf')
    expect(screen.getByRole('dialog')).toHaveTextContent('sha256:9f2a…c108')
    expect(screen.getByRole('button', { name: 'Open import #47' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
  })

  it('does not open a popover when there is no document behind the figure', () => {
    render(<SourceStamp {...BASE} variant="derived" description="Derived from ledger rows." />)
    const button = screen.getByRole('button', { name: 'Derived from ledger rows.' })
    expect(button).not.toHaveAttribute('aria-expanded')
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('StampGutter', () => {
  it('renders the 56px gutter with the mark in it', () => {
    const { container } = render(<StampGutter stamp={{ ...BASE, variant: 'ledger' }} />)
    expect(container.querySelector('.pgut .pmark')).not.toBeNull()
  })

  it('renders an aria-hidden spacer where D1 applies, so the left edge still aligns', () => {
    const { container } = render(<StampGutter />)
    const spacer = container.querySelector('.pgut-empty')
    expect(spacer).not.toBeNull()
    expect(spacer).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('StampKeyButton — D2, a help affordance rather than permanent chrome', () => {
  it('is closed until asked for', () => {
    render(<StampKeyButton />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /what the source stamps mean/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('opens on the ? button and explains all four border styles', () => {
    render(<StampKeyButton />)
    fireEvent.click(screen.getByRole('button', { name: /what the source stamps mean/i }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Solid — ledger-backed and current')
    expect(dialog).toHaveTextContent('Dashed — snapshot only, no transaction history')
    expect(dialog).toHaveTextContent('Dotted — derived rather than observed')
    expect(dialog).toHaveTextContent('Alert ink — stale, estimated or unresolved')
  })

  it('opens on Shift + / from anywhere and closes on Escape, returning focus', () => {
    render(<StampKeyButton />)
    fireEvent.keyDown(document, { key: '/', shiftKey: true })
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /what the source stamps mean/i })).toHaveFocus()
  })

  it('can be shown expanded on first run and dismissed once', () => {
    let dismissed = 0
    render(
      <StampKeyButton
        defaultOpen
        onDismiss={() => {
          dismissed += 1
        }}
      />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dismissed).toBe(1)
  })
})
