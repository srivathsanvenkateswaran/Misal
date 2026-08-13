/**
 * Screen 02 — Holdings.
 *
 * The load-bearing assertion is the snapshot row: its cost and P&L cells must say why they are
 * empty, in the cell, and must never render a zero, a dash or a blank there.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import { Holdings } from './Holdings'
import { buildPortfolioView } from './view-model'
import type { PortfolioData } from './view-model'
import { AS_OF, latestFxOnlyRows, nearlyFullCoverageRows, portfolioRows } from './testing/fixtures'

function data(rows = portfolioRows()): PortfolioData {
  const view = buildPortfolioView(rows, AS_OF)
  if (!view.ok) throw new Error(view.message)
  return view.data
}

/** The position row whose instrument cell names `instrument` — not the account column. */
function rowFor(container: HTMLElement, instrument: string): HTMLTableRowElement {
  for (const row of container.querySelectorAll('tbody tr')) {
    const cell = row.querySelector('td .inst')
    if (cell?.textContent?.startsWith(instrument) === true) return row as HTMLTableRowElement
  }
  throw new Error(`No position row for ${instrument}`)
}

describe('Holdings', () => {
  it('groups by asset class and labels each group with its capability', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)

    expect(screen.getByText(/Mutual funds · 1 position/u)).toBeInTheDocument()
    // Both snapshot classes say so in words, not only by hatch or hue.
    expect(screen.getAllByText('Snapshot — no transaction history')).toHaveLength(2)

    assertHonest(container)
  })

  it('withholds cost and P&L on a snapshot row, with a stated reason and never a zero', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)
    const row = rowFor(container, 'Augmont Digital Gold')

    for (const metric of ['avg-cost', 'unrealised', 'unrealised-pct']) {
      const cell = row.querySelector(`[data-metric="${metric}"]`)
      expect(cell?.getAttribute('data-not-measured')).toBe('no_transaction_history')
      expect(cell?.textContent).toContain('Not measured')
      expect(cell?.getAttribute('data-excluded-minor')).not.toBe(null)
      expect(cell?.textContent).not.toMatch(/^[\s₹0.,%—–-]*$/u)
    }
    // And the value it *can* measure is still there.
    expect(row.querySelector('[data-metric="value"]')?.textContent).toBe('2,39,999')

    assertHonest(container)
  })

  it('states a stale price in words and stamps the row (H7)', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)
    const row = rowFor(container, 'Augmont Digital Gold')

    expect(row.querySelector('[data-stale-days]')?.getAttribute('data-stale-days')).toBe('15')
    expect(row.textContent).toMatch(/15 d old/u)
    expect(row.querySelector('[data-stamp-alert="true"]')).not.toBeNull()

    assertHonest(container)
  })

  it('says a dollar holding is not converted rather than converting it at a guess', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)
    const row = rowFor(container, 'Caterpillar Inc')

    const value = row.querySelector('[data-metric="value"]')
    expect(value?.getAttribute('data-not-measured')).toBe('no_fx_rate')
    expect(value?.textContent).toContain('Not converted')

    assertHonest(container)
  })

  it('labels the total row’s cost column as the ledger-scope subtotal it is', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)
    const total = container.querySelector('tr.tot')
    expect(total).not.toBeNull()
    expect(total?.textContent).toContain('total cost · ledger')
    // Portfolio scope, so H2 demands the coverage attributes — and gets them.
    const cost = total?.querySelector('[data-metric="cost-basis"]')
    expect(cost?.getAttribute('data-coverage-minor')).toBe(data().ledgerBackedMinor)
    expect(cost?.getAttribute('data-scope')).toBe('portfolio')

    assertHonest(container)
  })

  it('regroups by account without changing a figure', () => {
    const byClass = render(<Holdings data={data()} group="asset_class" />)
    const classTotal = byClass.container.querySelector('tr.tot [data-metric="value"]')?.textContent
    byClass.unmount()

    const byAccount = render(<Holdings data={data()} group="account" />)
    expect(screen.getByText(/Zerodha Coin · 1 position/u)).toBeInTheDocument()
    expect(byAccount.container.querySelector('tr.tot [data-metric="value"]')?.textContent).toBe(
      classTotal,
    )

    assertHonest(byAccount.container)
  })

  it('restates in the foot how much of the cost column is real', () => {
    const { container } = render(<Holdings data={data()} group="asset_class" />)
    expect(
      screen.getByText(/Cost, unrealised P&L and the total above cover ₹7,93,871 of ₹10,33,869/u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('takes the foot’s rupees and its percentage from the same population', () => {
    /*
     * Today's dollar rate stored and the acquisition dates' absent — the state of every install
     * before `backfillFxHistory` finishes. Caterpillar is then inside net worth and inside the
     * ledger/snapshot capability split, and outside the cost metric, because its lots cannot be
     * converted.
     *
     * The foot took its rupees from the first and its percentage from the second and read
     * "₹19,13,066 of ₹21,53,064 (36.8%)" — a fraction of 88.85%, overstating what the cost column
     * covers by ₹11.19 lakh. Both figures now come from the cost metric, so the sentence divides.
     */
    const { container } = render(<Holdings data={data(latestFxOnlyRows())} group="asset_class" />)
    const foot = screen.getByText(/Cost, unrealised P&L and the total above cover/u)
    expect(foot.textContent).toContain('cover ₹7,93,871 of ₹21,53,064 (36.8%)')
    expect(foot.textContent).not.toContain('₹19,13,066')
    assertHonest(container)
  })

  it('refuses to round the foot’s coverage up to a completeness it has not got', () => {
    // ₹39 of gold with no history against ₹7.9 lakh that has it. The engine clamps this to 99.99%
    // so that 100% can only ever mean exact equality; rounding half-up at the display boundary
    // gives that guarantee straight back.
    const { container } = render(
      <Holdings data={data(nearlyFullCoverageRows())} group="asset_class" />,
    )
    const foot = screen.getByText(/Cost, unrealised P&L and the total above cover/u)
    expect(foot.textContent).toContain('(99.9%)')
    expect(foot.textContent).not.toContain('100.0%')
    assertHonest(container)
  })

  it('offers an invitation rather than a zero when there are no positions', () => {
    const { container } = render(
      <Holdings
        data={data(portfolioRows({ transactions: [], positions: [], prices: [] }))}
        group="asset_class"
      />,
    )
    expect(screen.getByText(/No positions yet/u)).toBeInTheDocument()
    expect(container.querySelector('tr.tot')).toBeNull()
    assertHonest(container)
  })
})
