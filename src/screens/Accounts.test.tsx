/**
 * Screen 03 — Accounts.
 *
 * The invariant with teeth here is H12: capability is displayed and explained, and the screen
 * offers no control that changes it. The only way to raise coverage is to import a document with
 * transactions, and the screen has to say so in rupees.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import { Accounts } from './Accounts'
import { buildPortfolioView } from './view-model'
import type { PortfolioData } from './view-model'
import { AS_OF, allLedgerRows, portfolioRows, unpricedSnapshotRows } from './testing/fixtures'

function data(rows = portfolioRows()): PortfolioData {
  const view = buildPortfolioView(rows, AS_OF)
  if (!view.ok) throw new Error(view.message)
  return view.data
}

describe('Accounts', () => {
  it('lists every account with its provider, capability, value and holdings count', () => {
    const { container } = render(<Accounts data={data()} />)

    expect(screen.getByText('Zerodha Coin')).toBeInTheDocument()
    expect(screen.getByText(/cams-cas · CAS/u)).toBeInTheDocument()
    expect(screen.getAllByText('Full history').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Holdings only').length).toBeGreaterThan(0)

    assertHonest(container)
  })

  it('offers no control that would change an account’s capability (H12)', () => {
    const { container } = render(<Accounts data={data()} />)

    const controls = [...container.querySelectorAll('button, select, input')]
    const labels = controls.map((control) => control.textContent?.toLowerCase() ?? '')
    expect(labels.some((label) => label.includes('capability'))).toBe(false)
    expect(container.querySelectorAll('select')).toHaveLength(0)
    // The two doors and the stamps are the only controls on the screen.
    expect(labels.filter((label) => label.includes('…'))).toHaveLength(2)

    assertHonest(container)
  })

  it('computes what importing a transaction history would unlock, to the rupee', () => {
    const { container } = render(<Accounts data={data()} />)
    expect(
      screen.getByText(
        /Importing a transaction history for the snapshot accounts would move ₹2,39,999 across the calibration line/u,
      ),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('says so plainly when there is nothing left to unlock', () => {
    const { container } = render(<Accounts data={data(allLedgerRows())} />)
    expect(
      screen.getByText(/Every account supplies transaction history, so nothing on this screen is withheld\./u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not deny a snapshot account listed three rows above it', () => {
    /*
     * The foot used to be chosen by a rupee quantity: `coverageOpportunity` is null both when
     * there is no snapshot account and when there is one whose holdings could not be priced. In
     * the second case the panel printed "Every account supplies transaction history, so nothing on
     * this screen is withheld" directly beneath a row badged "Holdings only · 1 not priced".
     *
     * It is an account question, so it is asked of the accounts. The rupee figure only decides how
     * much can be promised.
     */
    const { container } = render(<Accounts data={data(unpricedSnapshotRows())} />)
    expect(
      screen.queryByText(/Every account supplies transaction history/u),
    ).toBeNull()
    expect(screen.getByText(/supplies holdings only/u)).toBeInTheDocument()
    expect(screen.getByText(/None of those holdings could be priced/u)).toBeInTheDocument()
    // And the row it would have been denying is right there, saying the same thing.
    expect(screen.getAllByText('Holdings only').length).toBeGreaterThan(0)
    expect(screen.getByText(/1 not priced/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not answer ₹0 for the value of holdings it has just said it cannot price', () => {
    /*
     * The count was right and the arithmetic was not: the view-model summed the unpriced holding
     * in as `ZERO_MINOR` and published the total as measured, so this row read a confident ₹0 one
     * column from its own "1 not priced" badge.
     */
    const { container } = render(<Accounts data={data(unpricedSnapshotRows())} />)
    const row = [...container.querySelectorAll('[data-row-scope="account"]')].find(
      (candidate) => candidate.textContent?.includes('E*TRADE') === true,
    )
    const value = row?.querySelector('[data-metric="value"]')
    expect(value?.getAttribute('data-not-measured')).toBe('no_fx_rate')
    expect(value?.textContent).toContain('Not converted')
    expect(value?.textContent).not.toMatch(/^[\s₹0.,%—–-]*$/u)
    assertHonest(container)
  })

  it('reports the data date it actually has, rather than inventing a sync time', () => {
    const { container } = render(<Accounts data={data()} />)
    expect(screen.getAllByText('Latest transaction date').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Latest holdings statement date').length).toBeGreaterThan(0)
    assertHonest(container)
  })

  it('renders the capability matrix with Not measured, never a zero or a dash', () => {
    const { container } = render(<Accounts data={data()} />)
    const notMeasured = screen.getAllByText('Not measured')
    expect(notMeasured).toHaveLength(4)
    assertHonest(container)
  })
})
