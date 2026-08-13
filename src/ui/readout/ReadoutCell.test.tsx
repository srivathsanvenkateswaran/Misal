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

  it('binds the meter to the metric it covers, and to that metric’s own coverage', () => {
    const { container } = render(
      <ReadoutCell
        label="XIRR — annualised"
        metric="xirr"
        scope="portfolio"
        basis="ledger"
        value={fx.xirrValue}
        meter={{ pct: dec('71.90') }}
      />,
    )
    const meter = container.querySelector('[data-coverage-meter]')
    expect(meter?.getAttribute('data-metric')).toBe('xirr')
    expect(meter?.getAttribute('data-scope')).toBe('portfolio')
    // The figure's coverage, not a second number invented for the bar.
    const figure = container.querySelector('.metric[data-metric="xirr"]')
    expect(meter?.getAttribute('data-coverage-minor')).toBe(
      figure?.getAttribute('data-coverage-minor'),
    )
    expect(meter?.getAttribute('data-coverage-pct')).toBe(figure?.getAttribute('data-coverage-pct'))
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

  it('draws no coverage meter for a figure that was never computed', () => {
    /*
     * The defect: the meter rendered on `state === 'ready' && meter !== undefined`, without ever
     * consulting the figure. The percentage comes from pair *eligibility*, the figure is solved
     * over the scope as a whole and refused outright if any part of it is missing, so the two
     * disagree exactly when it matters. The cell read "Not priced / no price available", then
     * "Excludes ₹5,53,950 of net worth", then a bar labelled "Coverage 56.6 percent of portfolio
     * value" — a coverage figure for something nothing covered.
     */
    const { container } = render(
      <ReadoutCell
        label="XIRR — annualised"
        metric="xirr"
        scope="portfolio"
        basis="ledger"
        value={fx.notPriced}
        meter={{ pct: dec('56.60') }}
      />,
    )
    expect(container.querySelector('[data-coverage-meter]')).toBeNull()
    expect(container.querySelector('.meter-fill')).toBeNull()
    expect(container.textContent).not.toContain('56.6')
    // The honest half of the pair survives: the cell still says what it cannot speak for.
    expect(container.querySelector('[data-coverage-line]')?.textContent).toBe(
      'Excludes ₹2,40,000 of net worth',
    )
    assertHonest(container)
  })

  it('draws no meter at 100%, the reading that asserts the opposite of the truth', () => {
    // The variant the reviewers hit second: the unpriced pair contributes to neither side of the
    // fraction, so eligibility comes out at exactly 100.00 — documented as meaning "complete" —
    // beside a figure that does not exist.
    const { container } = render(
      <ReadoutCell
        label="XIRR — annualised"
        metric="xirr"
        scope="portfolio"
        basis="ledger"
        value={fx.notMeasuredXirr}
        meter={{ pct: dec('100.00') }}
      />,
    )
    expect(container.querySelector('.meter')).toBeNull()
    expect(screen.queryByRole('img', { name: /Coverage/u })).toBeNull()
    expect(container.textContent).not.toContain('100.0')
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
