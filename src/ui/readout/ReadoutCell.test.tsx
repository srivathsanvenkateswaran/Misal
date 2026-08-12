import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { dec } from '@domain/numeric'
import * as fx from '../gallery/fixtures'
import { assertHonest, FORBIDDEN_PLACEHOLDER } from '../testing/assert-honest'
import { ReadoutCell, ReadoutGrid } from './ReadoutCell'

describe('ReadoutCell — the measured branch', () => {
  it('renders label, figure and note, and states coverage beside the figure (H2)', () => {
    const { container } = render(
      <ReadoutCell
        label="Invested — cost basis"
        metric="cost-basis"
        scope="portfolio"
        basis="ledger"
        value={fx.costBasisValue}
        stamp={fx.DRV_STAMP}
        note="Ledger accounts only"
      />,
    )
    expect(screen.getByText('Invested — cost basis')).toBeInTheDocument()
    expect(container.querySelector('[data-metric="cost-basis"]')?.textContent).toBe('₹28,25,329')

    const coverage = container.querySelector('[data-coverage-line]')
    expect(coverage?.textContent).toContain('₹34,73,722')
    expect(coverage?.textContent).toContain('71.8%')
    expect(screen.getByText('Ledger accounts only')).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not attach a coverage line to a metric that does not depend on history', () => {
    const { container } = render(
      <ReadoutCell
        label="Net worth · all accounts"
        metric="net-worth"
        scope="portfolio"
        basis="derived"
        value={fx.netWorthValue}
        hero
      />,
    )
    expect(container.querySelector('[data-coverage-line]')).toBeNull()
    expect(container.querySelector('.metric-hero')?.textContent).toBe('₹48,32,150')
    assertHonest(container)
  })

  it('renders sub-rows, the coverage meter and the split bar from their decimal strings', () => {
    const { container } = render(
      <ReadoutCell
        label="XIRR — annualised"
        metric="xirr"
        scope="portfolio"
        basis="ledger"
        value={fx.xirrValue}
        meter={{ pct: dec('71.90') }}
        split={{ aPct: dec('76.85'), bPct: dec('23.15'), aLabel: 'INR', bLabel: 'USD' }}
      />,
    )
    expect(container.querySelector('.meter-fill')).toHaveStyle({ width: '71.90%' })
    expect(container.querySelector('.split-a')).toHaveStyle({ width: '76.85%' })
    expect(screen.getByText('USD 23.15%')).toBeInTheDocument()
    assertHonest(container)
  })
})

describe('ReadoutCell — the not-measured branch', () => {
  it('renders the reason and the excluded amount, never a zero (H3, H8)', () => {
    const { container } = render(
      <ReadoutCell
        label="XIRR — annualised"
        metric="xirr"
        scope="portfolio"
        basis="snapshot"
        value={fx.notMeasuredXirr}
      />,
    )
    expect(screen.getByText('Not measured')).toBeInTheDocument()
    expect(container.querySelector('[data-coverage-line]')?.textContent).toBe(
      'Excludes ₹48,32,150 of net worth',
    )
    // The figure's own slot says why, and says nothing that could be read as an amount.
    const figure = container.querySelector('[data-not-measured]')
    expect(figure?.textContent).toBe('Not measuredno transaction history')
    expect(figure?.textContent).not.toMatch(FORBIDDEN_PLACEHOLDER)
    assertHonest(container)
  })
})

describe('ReadoutCell — the other states', () => {
  it('loads with a layout-preserving skeleton and no fake numeral', () => {
    const { container } = render(
      <ReadoutCell
        label="Invested — cost basis"
        metric="cost-basis"
        scope="portfolio"
        basis="ledger"
        value={fx.costBasisValue}
        state="loading"
      />,
    )
    expect(container.querySelector('.skel')).not.toBeNull()
    expect(container.querySelector('[data-metric]')).toBeNull()
    expect(container.textContent).not.toContain('28,25,329')
    assertHonest(container)
  })

  it('keeps the previous value visible while refreshing', () => {
    const { container } = render(
      <ReadoutCell
        label="Unrealised P&L"
        metric="unrealised"
        scope="portfolio"
        basis="ledger"
        value={fx.unrealisedValue}
        state="refreshing"
        tone
      />,
    )
    expect(container.querySelector('[data-refreshing="true"]')).not.toBeNull()
    expect(container.querySelector('[data-metric="unrealised"]')?.textContent).toBe('+₹6,48,393')
    assertHonest(container)
  })
})

describe('ReadoutGrid — D1', () => {
  it('states the derivation once at panel level and covers the unstamped gutters (H6)', () => {
    const { container } = render(
      <ReadoutGrid statement="Derived from 6 accounts · nothing observed directly">
        <ReadoutCell
          hero
          label="Net worth · all accounts"
          metric="net-worth"
          scope="portfolio"
          basis="derived"
          value={fx.netWorthValue}
          stamp={fx.DRV_STAMP}
        />
        <ReadoutCell
          label="Invested — cost basis"
          metric="cost-basis"
          scope="portfolio"
          basis="ledger"
          value={fx.costBasisValue}
        />
      </ReadoutGrid>,
    )
    expect(
      screen.getByText('Derived from 6 accounts · nothing observed directly'),
    ).toBeInTheDocument()
    expect(container.querySelector('[data-stamp-scope="derived"]')).not.toBeNull()
    // Exactly one stamp for two cells: the gutter rhythm survives, the noise does not.
    expect(container.querySelectorAll('.pmark')).toHaveLength(1)
    expect(container.querySelectorAll('.pgut-empty')).toHaveLength(1)
    assertHonest(container)
  })

  it('replaces the whole grid with one named error, keeping its head', () => {
    render(
      <ReadoutGrid
        statement="Derived from 6 accounts"
        state="error"
        errorMessage="Valuation failed: no exchange rate for 12 Aug 2026 (E_FX_MISSING)."
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('E_FX_MISSING')
    expect(screen.getByText('Portfolio readout')).toBeInTheDocument()
  })
})
