/**
 * Screen 05 — the instrument index and the instrument detail.
 *
 * The detail screen is where FIFO becomes inspectable, and where a snapshot-backed instrument has
 * to *replace* its lots and cost panels with a statement rather than render them empty or zeroed.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import { InstrumentDetail, InstrumentIndex } from './Instruments'
import { buildPortfolioView } from './view-model'
import type { PortfolioData } from './view-model'
import { AS_OF, portfolioRows } from './testing/fixtures'

function data(rows = portfolioRows()): PortfolioData {
  const view = buildPortfolioView(rows, AS_OF)
  if (!view.ok) throw new Error(view.message)
  return view.data
}

describe('InstrumentIndex', () => {
  it('lists every instrument held, with a link into its detail', () => {
    const { container } = render(<InstrumentIndex data={data()} />)

    const link = screen.getByRole('link', { name: 'Parag Parikh Flexi Cap' })
    expect(link.getAttribute('href')).toBe('#/instruments/i-ppfc')

    assertHonest(container)
  })

  it('admits that exited instruments are not reachable yet', () => {
    const { container } = render(<InstrumentIndex data={data()} />)
    expect(screen.getByText(/Instruments fully exited are not listed yet/u)).toBeInTheDocument()
    assertHonest(container)
  })
})

describe('InstrumentDetail — a ledger-backed instrument', () => {
  it('shows the position, its lots and its transactions, each stamped', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-ppfc" />)

    expect(screen.getByText('Parag Parikh Flexi Cap')).toBeInTheDocument()
    expect(screen.getByText('Position by account')).toBeInTheDocument()
    expect(screen.getByText(/Open lots — FIFO cost basis/u)).toBeInTheDocument()
    expect(screen.getByText('Transactions')).toBeInTheDocument()

    // Every figure-bearing row traces to a document (H6) — asserted generically below too.
    const rows = [...container.querySelectorAll('tbody tr')].filter(
      (row) => row.querySelector('[data-metric]') !== null,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.querySelector('.pmark')).not.toBeNull()

    assertHonest(container)
  })

  it('measures the FIFO cost and the XIRR, and says what they cover', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-ppfc" />)

    const cost = container.querySelector('[data-metric="cost-basis"]')
    expect(cost?.getAttribute('data-not-measured')).toBe(null)
    const xirr = container.querySelector('[data-metric="xirr"]')
    expect(xirr?.getAttribute('data-not-measured')).toBe(null)

    assertHonest(container)
  })

  it('truncates long lists rather than pretending they are complete', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-ppfc" />)
    expect(screen.getByText(/more open lots not shown/u)).toBeInTheDocument()
    expect(screen.getByText(/earlier transactions not shown/u)).toBeInTheDocument()
    assertHonest(container)
  })
})

describe('InstrumentDetail — a snapshot-backed instrument', () => {
  it('replaces the lots panel with a statement naming the account and the reason', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-gold" />)

    expect(screen.getByText('Not measured — no transaction history')).toBeInTheDocument()
    expect(screen.getByText(/Augmont Digital Gold supplies holdings only/u)).toBeInTheDocument()
    // No zeroed lot table in its place.
    expect(screen.queryByText('Acquired')).toBeNull()

    assertHonest(container)
  })

  it('withholds cost and XIRR while still stating the value it does know', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-gold" />)

    expect(container.querySelector('[data-metric="cost-basis"]')?.getAttribute('data-not-measured')).toBe(
      'no_transaction_history',
    )
    expect(container.querySelector('[data-metric="xirr"]')?.getAttribute('data-not-measured')).toBe(
      'no_transaction_history',
    )
    expect(container.querySelector('[data-metric="value"]')?.textContent).toBe('2,39,999')

    assertHonest(container)
  })
})

describe('InstrumentDetail — an unknown identifier', () => {
  it('is a stated not-found with a way back, not a blank screen', () => {
    const { container } = render(<InstrumentDetail data={data()} instrumentId="i-nope" />)
    expect(
      screen.getByText('No instrument with that identifier is currently held.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the instrument index' })).toBeInTheDocument()
    assertHonest(container)
  })
})
