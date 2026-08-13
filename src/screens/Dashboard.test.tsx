/**
 * Screen 01 — Dashboard.
 *
 * Every test ends with `assertHonest`, which walks the rendered DOM for H2, H3, H5, H6, H7 and H9
 * against the `data-*` contract. That is the mechanism that keeps the promise from eroding: a
 * change that renders a figure without its coverage, or a zero where a metric was never measured,
 * fails here without anyone remembering to write an honesty test for it.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import { Dashboard } from './Dashboard'
import { buildPortfolioView } from './view-model'
import type { PortfolioData } from './view-model'
import {
  AS_OF,
  allLedgerRows,
  allSnapshotRows,
  nearlyFullCoverageRows,
  portfolioRows,
} from './testing/fixtures'

function data(rows = portfolioRows()): PortfolioData {
  const view = buildPortfolioView(rows, AS_OF)
  if (!view.ok) throw new Error(view.message)
  return view.data
}

describe('Dashboard', () => {
  it('leads with the calibration bar and states the split in words', () => {
    const { container } = render(<Dashboard data={data()} />)

    const bar = screen.getByLabelText('Calibration — history coverage')
    expect(within(bar).getByText(/LEDGER-BACKED/u)).toBeInTheDocument()
    expect(within(bar).getByText(/SNAPSHOT ONLY/u)).toBeInTheDocument()
    expect(
      within(bar).getByText(/Hatched fill = holdings snapshot only, no transaction history/u),
    ).toBeInTheDocument()

    assertHonest(container)
  })

  it('renders the readout with the net worth the engine computed', () => {
    const view = data()
    const { container } = render(<Dashboard data={view} />)

    const hero = container.querySelector('[data-metric="net-worth"]')
    expect(hero?.getAttribute('data-coverage-minor')).toBe(view.netWorthMinor)
    expect(hero?.textContent).toBe('₹10,33,869')

    assertHonest(container)
  })

  it('states what the cost basis covers, beside the cost basis', () => {
    const { container } = render(<Dashboard data={data()} />)

    const cell = container.querySelector('[data-cell-metric="cost-basis"]')
    expect(cell).not.toBeNull()
    const coverageLine = cell?.querySelector('[data-coverage-line="true"]')
    expect(coverageLine?.textContent).toMatch(/Covers ₹7,93,871 \/ 76\.7% of net worth/u)

    assertHonest(container)
  })

  it('withholds every history-dependent figure, with its reason, when nothing has history', () => {
    const { container } = render(<Dashboard data={data(allSnapshotRows())} />)

    for (const metric of ['cost-basis', 'unrealised', 'xirr', 'realised']) {
      const cell = container.querySelector(`[data-cell-metric="${metric}"] [data-metric]`)
      expect(cell?.getAttribute('data-not-measured')).toBe('no_transaction_history')
      expect(cell?.textContent).toContain('Not measured')
      // Never a zero, a dash or a blank in its place.
      expect(cell?.textContent).not.toMatch(/^[\s₹0.,%—–-]*$/u)
    }

    assertHonest(container)
  })

  it('shows coverage at 100% rather than hiding it when everything is measured', () => {
    const { container } = render(<Dashboard data={data(allLedgerRows())} />)
    expect(screen.getAllByText('100.0%').length).toBeGreaterThan(0)
    assertHonest(container)
  })

  it('never rounds a coverage percentage up to 100%', () => {
    const { container } = render(<Dashboard data={data(nearlyFullCoverageRows())} />)

    // The cost-basis row covers all but ₹39 of net worth. That is 99.99%, and 99.99% is not 100%.
    const row = screen.getByText('Cost basis · unrealised P&L').closest('tr')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('99.9%')
    expect(row?.textContent).not.toContain('100.0%')

    // The meter's accessible name is held to the same rule as the printed figure.
    const xirrCell = container.querySelector('[data-cell-metric="xirr"] .meter')
    expect(xirrCell?.getAttribute('aria-label')).toBe('Coverage 99.9 percent of portfolio value')

    // Net worth still reads 100.0%, because net worth genuinely covers itself.
    expect(screen.getByText('Net worth').closest('tr')?.textContent).toContain('100.0%')

    assertHonest(container)
  })

  it('names the withheld amount beside the unresolved count (H8)', () => {
    const { container } = render(<Dashboard data={data()} />)
    expect(screen.getByText('Unresolved instruments')).toBeInTheDocument()
    expect(screen.getByText(/₹3,94,200 withheld from every total/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('draws the twelve-month series and says what a gap means', () => {
    const { container } = render(<Dashboard data={data()} />)
    expect(
      screen.getByText(/A month with nothing stored is drawn as a gap/u),
    ).toBeInTheDocument()
    // The accessible table beside the chart lists every month, so twelve columns are readable.
    expect(screen.getByText('Net worth by asset class, month end')).toBeInTheDocument()
    assertHonest(container)
  })

  it('restates the calibration bar in plain English, and refuses to estimate the remainder', () => {
    const { container } = render(<Dashboard data={data()} />)
    expect(
      screen.getByText(
        /Partial metrics are computed on ledger-backed value only\. Misal does not estimate the remainder\./u,
      ),
    ).toBeInTheDocument()
    assertHonest(container)
  })
})
