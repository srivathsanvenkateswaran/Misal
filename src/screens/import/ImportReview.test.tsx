/**
 * The report's framing is the thing under test.
 *
 * A partial import is a completed import: if this component ever starts calling a run with failed
 * rows a failure, users will assume their data is in an unknown state and re-import, which is how
 * a correct ledger acquires duplicates by hand.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ImportCounters, Issue } from '@ingestion/index'
import type { UnresolvedEntryRow } from '../../data/import'
import { ImportReview, type ImportReviewProps } from './ImportReview'

const COUNTERS: ImportCounters = {
  read: 218,
  committed: 183,
  duplicate: 30,
  skipped: 3,
  failed: 2,
  withheld: 3,
}

const ISSUES: Issue[] = [
  {
    severity: 'error',
    code: 'E_DATE_PARSE',
    message: '“31-02-2025” is not a valid date',
    ref: 'p.11 r.3',
  },
  {
    severity: 'error',
    code: 'E_MISSING_REQUIRED_FIELD',
    message: 'the amount column was empty',
    ref: 'p.7 r.14',
  },
  {
    severity: 'warning',
    code: 'W_INCOMPLETE_HISTORY',
    message: 'a folio opened with a non-zero balance, so this account stays holdings-only',
    ref: 'p.4',
  },
]

const QUEUE: UnresolvedEntryRow[] = [
  {
    id: 'u1',
    sourceDocumentId: 'd1',
    accountId: 'a1',
    rawIdentifier: 'isin:INF179K01YV8',
    rawName: 'HDFC BALANCED ADVANTAGE FUND',
    assetClassHint: 'mutual_fund',
    observedQuantity: '412.882',
    observedValueMinor: '11864000',
    currency: 'INR',
    firstSeenAt: '2026-08-12T10:44:00Z',
  },
]

function renderReview(over: Partial<ImportReviewProps> = {}) {
  const props: ImportReviewProps = {
    file: { name: 'CAS_CAMS_KFIN_APR2023_JUL2026.pdf', byteLength: 2_411_724 },
    contentHash: '4f9c1122334455667788990011223344556677889900112233445566778899a713',
    documentId: 'd1',
    runId: 'r47',
    pluginId: 'cams-kfin-cas',
    parserLabel: 'CAMS / KFintech mutual fund CAS',
    stampCode: 'CAS',
    pageRef: 'p.1-13',
    unlockedWith: 'the password chosen when the statement was requested',
    counters: COUNTERS,
    issues: ISSUES,
    accountCount: 4,
    unresolved: QUEUE,
    instruments: [],
    onMap: vi.fn(),
    onIgnore: vi.fn(),
    ...over,
  }
  render(<ImportReview {...props} />)
  return props
}

describe('ImportReview', () => {
  it('calls a run with failed rows completed, and says nothing was rolled back', () => {
    renderReview()
    expect(
      screen.getByRole('heading', {
        name: 'Import completed — 183 rows applied, 1 instrument needs your input',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Nothing was rolled back/)).toBeInTheDocument()
    expect(screen.getByText(/2 rows could not be read/)).toBeInTheDocument()
  })

  it('shows counters that reconcile', () => {
    renderReview()
    expect(
      screen.getByText(
        /183 applied \+ 30 already present \+ 3 skipped \+ 2 failed = 218 read/,
      ),
    ).toBeInTheDocument()
  })

  it('lists every failed row with where it was and why it failed', () => {
    renderReview()
    const errors = screen.getByRole('table', { name: 'Rows this import could not read' })
    expect(within(errors).getAllByText('p.11 r.3').length).toBeGreaterThan(0)
    expect(within(errors).getByText('“31-02-2025” is not a valid date')).toBeInTheDocument()
    expect(within(errors).getByText('E_MISSING_REQUIRED_FIELD')).toBeInTheDocument()
  })

  it('separates warnings from failures', () => {
    renderReview()
    expect(screen.getByText('Notes — 1')).toBeInTheDocument()
    expect(screen.getByText('W_INCOMPLETE_HISTORY')).toBeInTheDocument()
  })

  it('records the checksum and states that the file was not copied', () => {
    renderReview()
    expect(screen.getByText(/sha256 4f9c…a713/)).toBeInTheDocument()
    expect(screen.getByText(/not copied — Misal recorded the checksum only/)).toBeInTheDocument()
    // D4: no storage path, because Misal never stores the bytes.
    expect(screen.queryByText(/Application Support/)).not.toBeInTheDocument()
  })

  it('names how the file was unlocked without repeating what was typed', () => {
    renderReview({ unlockedWith: 'PAN + date of birth' })
    expect(screen.getByText(/PAN \+ date of birth/)).toBeInTheDocument()
    expect(screen.getByText(/not stored/)).toBeInTheDocument()
  })

  it('states how many rows the queue is holding back, and that mapping is not urgent', () => {
    renderReview()
    expect(screen.getByText(/3 rows are withheld from every total/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says plainly when nothing is being withheld', () => {
    renderReview({ unresolved: [], counters: { ...COUNTERS, withheld: 0 } })
    expect(
      screen.getByText('Nothing is being withheld from your totals by this import.'),
    ).toBeInTheDocument()
  })

  it('reads as a clean run when nothing failed', () => {
    renderReview({
      issues: [],
      unresolved: [],
      counters: { read: 12, committed: 12, duplicate: 0, skipped: 0, failed: 0, withheld: 0 },
    })
    expect(
      screen.getByRole('heading', { name: 'Import completed — 12 rows applied' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Every row was read and applied\./)).toBeInTheDocument()
    expect(screen.getByText('Every row parsed.')).toBeInTheDocument()
  })
})
