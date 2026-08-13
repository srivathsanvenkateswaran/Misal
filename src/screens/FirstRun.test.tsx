/**
 * First run.
 *
 * The assertion that matters most is a negative one: no numeral anywhere. A net-worth tracker
 * showing ₹0 to a new user is claiming a measurement it has not made.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import { FirstRun } from './FirstRun'

const STATUS = {
  databasePath: '/Users/x/Library/Application Support/Misal/misal.db',
  schemaVersion: 3,
  encrypted: true,
  accountCount: 0,
}

describe('FirstRun', () => {
  it('is an invitation, not an error', () => {
    const { container } = render(<FirstRun status={STATUS} />)

    expect(screen.getByText(/nothing leaves the device/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add key…' })).toBeInTheDocument()
    expect(container.querySelector('[role="alert"]')).toBeNull()

    assertHonest(container)
  })

  it('teaches the ledger/snapshot distinction at the moment it is decided', () => {
    const { container } = render(<FirstRun status={STATUS} />)
    expect(screen.getByText(/This choice decides what Misal can tell you\./u)).toBeInTheDocument()
    expect(
      screen.getByText(/A holdings-only file gives a snapshot: current value only, no cost basis/u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('names the database it will create, from the real handle', () => {
    const { container } = render(<FirstRun status={STATUS} />)
    expect(screen.getByText(new RegExp(STATUS.databasePath, 'u'))).toBeInTheDocument()
    expect(screen.getByText(/encrypted SQLite database/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not claim a path before the handle has answered', () => {
    const { container } = render(<FirstRun status={undefined} />)
    expect(screen.queryByText(/misal\.db/u)).toBeNull()
    assertHonest(container)
  })

  it('draws the calibration bar empty rather than filling it with zeros', () => {
    const { container } = render(<FirstRun status={STATUS} />)

    const bar = screen.getByLabelText('Calibration — history coverage')
    expect(bar.getAttribute('data-state')).toBe('empty')
    expect(screen.getByText('Nothing measured yet')).toBeInTheDocument()
    // The ruler is drawn; no segment, no caret, no total mark.
    expect(bar.querySelectorAll('[data-basis]')).toHaveLength(0)
    expect(bar.querySelector('.boundary')).toBeNull()

    assertHonest(container)
  })

  it('renders no figure at all — not even a zero', () => {
    const { container } = render(<FirstRun status={STATUS} />)
    expect(container.querySelectorAll('[data-metric]:not([data-metric="coverage"])')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/₹\s*0\b/u)
    assertHonest(container)
  })

  it('puts focus on the first door, so a keyboard user starts where the work is', () => {
    render(<FirstRun status={STATUS} />)
    expect(screen.getByRole('button', { name: 'Choose file…' })).toHaveFocus()
  })
})
