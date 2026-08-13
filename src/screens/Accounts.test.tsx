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
import {
  AS_OF,
  allLedgerRows,
  connectedNoHoldingsRows,
  portfolioRows,
  unpricedSnapshotRows,
  zeroQuantitySnapshotRows,
} from './testing/fixtures'

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
    const view = data(unpricedSnapshotRows())
    const { container } = render(<Accounts data={view} />)
    expect(
      screen.queryByText(/Every account supplies transaction history/u),
    ).toBeNull()
    expect(screen.getByText(/supplies holdings only/u)).toBeInTheDocument()
    // The cause is stated only to the extent the screen holds evidence for it: the count of
    // holdings with no stored price, which is the same number the row above prints.
    expect(screen.getByText(/1 of its holdings has no stored price/u)).toBeInTheDocument()
    expect(view.unpricedCount).toBe(1)
    const snapshot = view.accounts.filter((account) => account.capability === 'snapshot')
    expect(snapshot.map((account) => account.unpriced)).toEqual([1])
    expect(snapshot.map((account) => account.holdings)).toEqual([1])
    // And the row it would have been denying is right there, saying the same thing.
    expect(screen.getAllByText('Holdings only').length).toBeGreaterThan(0)
    expect(screen.getByText(/1 not priced/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not blame pricing for a snapshot account that has no holdings to price', () => {
    /*
     * `upsert_exchange_account` inserts `capability = 'snapshot'` when the credential is committed,
     * before any balances sync runs, and `list_accounts` lists it immediately. So an exchange whose
     * first sync has not landed — or threw, or found nothing — is on this screen holding nothing.
     * `coverageOpportunity` is null there for the same reason it is null for an unpriced holding,
     * and the foot used to read that one null as proof that pricing had failed.
     */
    const view = data(connectedNoHoldingsRows())
    const { container } = render(<Accounts data={view} />)

    const snapshot = view.accounts.filter((account) => account.capability === 'snapshot')
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.holdings).toBe(0)
    expect(snapshot[0]?.unpriced).toBe(0)
    // Nothing failed to price, and the view-model says so in the same session.
    expect(view.unpricedCount).toBe(0)
    expect(view.coverageOpportunity).toBeNull()

    expect(screen.queryByText(/no stored price/u)).toBeNull()
    expect(screen.queryByText(/could be priced/u)).toBeNull()
    expect(screen.queryByText(/Every account supplies transaction history/u)).toBeNull()
    expect(screen.getByText(/with no holding recorded yet/u)).toBeInTheDocument()
    // The row itself carries the same statement, rather than a date it does not have.
    expect(screen.getByText('No rows yet')).toBeInTheDocument()
    expect(screen.getByText('No rows imported for this account yet')).toBeInTheDocument()
    assertHonest(container)
  })

  it('claims no cause when holdings exist, all price, and the value is still zero', () => {
    /*
     * A fully sold holding whose row is retained. Every holding prices, so pricing has not failed;
     * the account still contributes nothing, so there is no rupee figure to promise. The foot is
     * allowed to say only that — naming a cause here would be the third false statement out of this
     * one branch.
     */
    const view = data(zeroQuantitySnapshotRows())
    const { container } = render(<Accounts data={view} />)

    const snapshot = view.accounts.filter((account) => account.capability === 'snapshot')
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.holdings).toBe(1)
    expect(snapshot[0]?.unpriced).toBe(0)
    expect(snapshot[0]?.valueMinor).toBe('0')
    expect(view.unpricedCount).toBe(0)
    expect(view.coverageOpportunity).toBeNull()

    expect(screen.queryByText(/no stored price/u)).toBeNull()
    expect(screen.queryByText(/no holdings recorded yet/u)).toBeNull()
    expect(screen.queryByText(/Every account supplies transaction history/u)).toBeNull()
    expect(
      screen.getByText(
        /supplies holdings only\. How much a transaction history would move across the calibration line is not a figure Misal can state/u,
      ),
    ).toBeInTheDocument()
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
