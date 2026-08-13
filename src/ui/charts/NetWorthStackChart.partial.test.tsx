/**
 * A partially priced month, in the chart that draws it.
 *
 * The gap case had a fixture from the start; this one had none, and it is the more dangerous of
 * the two. A month with nothing stored draws nothing and reads as nothing. A month with *some* of
 * its holdings priced draws a column of the same shape, the same height rule and the same exact
 * rupee figure in the accessible table as a month that was measured whole — so the one column a
 * reader has no way to distinguish is the one that is understating the portfolio.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import * as fx from '../gallery/fixtures'
import { assertHonest } from '../testing/assert-honest'
import { NetWorthStackChart } from './NetWorthStackChart'
import type { StackMonth } from './NetWorthStackChart'

/** July priced only in part: two instruments held that month have no stored price. */
const MONTHS_PARTLY_PRICED: readonly StackMonth[] = fx.TWELVE_MONTHS.map((month) =>
  month.label === 'JUL' ? { ...month, unpricedCount: 2 } : month,
)

function julyRow(): HTMLElement {
  return screen.getByRole('row', { name: /JUL 26/u })
}

describe('NetWorthStackChart — a month priced in part', () => {
  it('marks the column rather than drawing it as an ordinary one', () => {
    const { container } = render(<NetWorthStackChart months={MONTHS_PARTLY_PRICED} />)
    const marked = container.querySelectorAll('[data-incomplete="true"]')
    // One in the plot, one in the accessible table — the same month, said both ways.
    expect(marked).toHaveLength(2)
    const column = container.querySelector('svg [data-incomplete="true"]')
    expect(column?.getAttribute('data-unpriced-count')).toBe('2')
    expect(column?.querySelector('[data-incomplete-cap="true"]')).not.toBeNull()
    assertHonest(container)
  })

  it('leaves every complete month unmarked, so the mark means something', () => {
    const { container } = render(<NetWorthStackChart months={fx.TWELVE_MONTHS} />)
    expect(container.querySelectorAll('[data-incomplete="true"]')).toHaveLength(0)
    expect(container.querySelector('[data-incomplete-note="true"]')).toBeNull()
    assertHonest(container)
  })

  it('states the month as a floor in the accessible table, never as a total', () => {
    render(<NetWorthStackChart months={MONTHS_PARTLY_PRICED} />)
    const row = julyRow()
    expect(within(row).getByText(/^At least ₹44,21,000 — incomplete$/u)).toBeInTheDocument()
    // The bare figure a complete month prints is exactly what this one must not print.
    expect(within(row).queryByText('₹44,21,000')).toBeNull()
    expect(row.textContent).toContain('2 instruments held that month had no stored price')
    expect(row.textContent).toContain('floor and not a total')
  })

  it('names the mark on the chart and in the chart’s own accessible name', () => {
    const { container } = render(<NetWorthStackChart months={MONTHS_PARTLY_PRICED} />)
    expect(container.querySelector('[data-incomplete-note="true"]')?.textContent).toMatch(
      /HOLDINGS WITH NO STORED PRICE ARE NOT DRAWN/u,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      '1 month is marked incomplete',
    )
  })

  it('labels an incomplete final column as a floor rather than as the month’s value', () => {
    const months = fx.TWELVE_MONTHS.map((month) =>
      month.label === 'AUG' ? { ...month, unpricedCount: 1 } : month,
    )
    const { container } = render(<NetWorthStackChart months={months} />)
    expect(container.querySelector('.dlab')?.textContent).toBe('≥ ₹48.32L')

    const { container: whole } = render(<NetWorthStackChart months={fx.TWELVE_MONTHS} />)
    expect(whole.querySelector('.dlab')?.textContent).toBe('₹48.32L')
  })

  it('keeps a gap a gap: an unpriced count says nothing about a month with no rows at all', () => {
    const months = fx.MONTHS_WITH_GAPS.map((month) =>
      month.segments === null ? { ...month, unpricedCount: 3 } : month,
    )
    const { container } = render(<NetWorthStackChart months={months} historyBegins="FEB 2026" />)
    expect(container.querySelectorAll('[data-gap="true"]')).toHaveLength(5)
    expect(container.querySelectorAll('[data-incomplete="true"]')).toHaveLength(0)
    expect(screen.getAllByText('No history — not drawn')).toHaveLength(5)
    assertHonest(container)
  })
})
