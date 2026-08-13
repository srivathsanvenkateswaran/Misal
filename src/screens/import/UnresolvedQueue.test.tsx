/**
 * The queue's promises, asserted.
 *
 * Three of them are product rules rather than component behaviour: the exact withheld amount is
 * stated, nothing is guessed on the user's behalf, and no control blocks.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { UnresolvedEntryRow } from '../../data/import'
import { UnresolvedQueue, withheldValue, type InstrumentChoice } from './UnresolvedQueue'

const INSTRUMENTS: InstrumentChoice[] = [
  {
    id: 'i-hdfc',
    displayName: 'HDFC Balanced Advantage Fund — Direct Growth',
    isin: 'INF179K01YV8',
    assetClass: 'mutual_fund',
  },
  { id: 'i-infy', displayName: 'Infosys', isin: 'INE009A01021', assetClass: 'indian_equity' },
]

function entry(over: Partial<UnresolvedEntryRow> = {}): UnresolvedEntryRow {
  return {
    id: 'u1',
    sourceDocumentId: 'd1',
    accountId: 'a1',
    rawIdentifier: 'isin:INF179K01YV8',
    rawName: 'HDFC BALANCED ADVANTAGE FUND - DIRECT PLAN - GROWTH',
    assetClassHint: 'mutual_fund',
    observedQuantity: '412.882',
    observedValueMinor: '11864000',
    currency: 'INR',
    firstSeenAt: '2026-08-12T10:44:00Z',
    ...over,
  }
}

function renderQueue(over: Partial<UnresolvedEntryRow>[] = [{}]) {
  const onMap = vi.fn()
  const onIgnore = vi.fn()
  render(
    <UnresolvedQueue
      entries={over.map((patch, index) => entry({ id: `u${String(index + 1)}`, ...patch }))}
      instruments={INSTRUMENTS}
      stampCode="CAS"
      onMap={onMap}
      onIgnore={onIgnore}
    />,
  )
  return { onMap, onIgnore }
}

describe('UnresolvedQueue', () => {
  it('states the exact amount its rows withhold', () => {
    renderQueue()
    expect(screen.getByText(/₹1,18,640 withheld from every total/)).toBeInTheDocument()
    expect(screen.getByText(/412\.882 units/)).toBeInTheDocument()
  })

  it('says the value is unknown rather than showing a zero', () => {
    renderQueue([{ observedValueMinor: null, observedQuantity: null }])
    expect(screen.getByText(/the source stated no value for it/)).toBeInTheDocument()
    expect(screen.queryByText(/₹0/)).not.toBeInTheDocument()
  })

  it('offers no guess, and says so', () => {
    renderQueue()
    expect(
      screen.getByText(/Misal does not identify an instrument from a name/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Map' })).toBeDisabled()
  })

  it('maps once the user has chosen an instrument', () => {
    const { onMap } = renderQueue()
    fireEvent.change(screen.getByLabelText('Map to'), { target: { value: 'i-hdfc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Map' }))
    expect(onMap).toHaveBeenCalledWith('u1', 'i-hdfc')
  })

  it('filters candidates by name or ISIN', () => {
    renderQueue()
    fireEvent.change(screen.getByLabelText('Search instruments'), { target: { value: 'INE009' } })
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('Infosys — INE009A01021')
    expect(options).not.toContain('HDFC Balanced Advantage Fund — Direct Growth — INF179K01YV8')
  })

  it('can be dismissed, and never blocks', () => {
    const { onIgnore } = renderQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for now' }))
    expect(onIgnore).toHaveBeenCalledWith('u1')
    // No modal, no gate: nothing in the queue traps focus or demands an answer.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByText(/Dismissed items stay in Settings → Review queue/),
    ).toBeInTheDocument()
  })

  it('names what could not be read, per identifier kind', () => {
    renderQueue([
      { rawIdentifier: 'provider-local:532540' },
      { rawIdentifier: 'name:SOME FUND', observedQuantity: null },
    ])
    expect(screen.getByText('Unrecognised broker code')).toBeInTheDocument()
    expect(screen.getByText('532540')).toBeInTheDocument()
    expect(
      screen.getByText('Unrecognised name — the source printed no identifier'),
    ).toBeInTheDocument()
  })

  it('is empty when there is nothing to do', () => {
    render(
      <UnresolvedQueue
        entries={[]}
        instruments={INSTRUMENTS}
        stampCode="CAS"
        onMap={vi.fn()}
        onIgnore={vi.fn()}
      />,
    )
    expect(screen.getByText(/every identifier in this document is mapped/)).toBeInTheDocument()
  })
})

describe('withheldValue', () => {
  it('carries a paise value past 2^53 through to the figure intact', () => {
    // 9007199254740993 paise. The string never becomes a number on the way to the screen; through
    // a double the last digit would already be gone before any rounding was asked for.
    expect(withheldValue(entry({ observedValueMinor: '9007199254740993' }))).toBe(
      '₹9,00,71,99,25,47,410',
    )
    expect(withheldValue(entry({ observedValueMinor: '11864000' }))).toBe('₹1,18,640')
  })

  it('declines to format a currency it has no rule for', () => {
    expect(withheldValue(entry({ currency: 'AED' }))).toBeNull()
    expect(withheldValue(entry({ observedValueMinor: null }))).toBeNull()
  })
})
