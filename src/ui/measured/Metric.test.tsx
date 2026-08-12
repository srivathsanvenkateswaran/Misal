import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fullCoverage, measured, notMeasured, partialCoverage } from '@domain/measured'
import { dec, minor } from '@domain/numeric'
import { moneyFigure, pctFigure } from '../figure'
import { assertHonest, FORBIDDEN_PLACEHOLDER, honestyViolations } from '../testing/assert-honest'
import { Metric } from './Metric'

const NET_WORTH = minor('483215000')
const LEDGER = minor('347372200')
const COVERAGE = partialCoverage(LEDGER, NET_WORTH, ['etrade'])

describe('Metric — the measured branch', () => {
  it('formats the figure and carries its coverage with it (H2)', () => {
    const { container } = render(
      <Metric
        value={measured(moneyFigure(minor('282532900')), COVERAGE)}
        metric="cost-basis"
        scope="portfolio"
        basis="ledger"
      />,
    )
    const element = container.querySelector('[data-metric="cost-basis"]')
    expect(element).not.toBeNull()
    expect(element?.textContent).toBe('₹28,25,329')
    expect(element?.getAttribute('data-coverage-minor')).toBe(LEDGER)
    expect(element?.getAttribute('data-coverage-pct')).toBe('71.8')
    expect(element?.getAttribute('data-basis')).toBe('ledger')
    assertHonest(container)
  })

  it('reinforces the sign glyph with tone, never replaces it', () => {
    const { container } = render(
      <Metric
        value={measured(pctFigure(dec('-0.30'), { signed: true }), fullCoverage(NET_WORTH))}
        metric="day-change"
        scope="portfolio"
        basis="derived"
        tone
      />,
    )
    const element = container.querySelector('[data-metric="day-change"]')
    expect(element?.textContent).toBe('−0.30%')
    expect(element?.className).toContain('neg')
    assertHonest(container)
  })
})

describe('Metric — the not-measured branch (H3)', () => {
  it('renders the reason, never a zero, a dash or a blank', () => {
    const { container } = render(
      <Metric
        value={notMeasured('no_transaction_history', NET_WORTH)}
        metric="xirr"
        scope="portfolio"
        basis="snapshot"
      />,
    )
    expect(screen.getByText('Not measured')).toBeInTheDocument()
    expect(screen.getByText('no transaction history')).toBeInTheDocument()

    const element = container.querySelector('[data-not-measured]')
    expect(element?.getAttribute('data-not-measured')).toBe('no_transaction_history')
    expect(element?.getAttribute('data-excluded-minor')).toBe(NET_WORTH)
    expect(element?.textContent).not.toMatch(FORBIDDEN_PLACEHOLDER)
    expect(element?.textContent).not.toMatch(/^[₹0.,%\s—–-]*$/)
    assertHonest(container)
  })

  it('uses the fixed copy for each reason, and never invents its own', () => {
    const cases = [
      ['no_price', 'Not priced', 'no price available'],
      ['unresolved_instrument', 'Not counted', 'instrument not yet identified'],
      ['no_fx_rate', 'Not converted', 'no exchange rate for this date'],
    ] as const
    for (const [reason, headline, explanation] of cases) {
      const { container, unmount } = render(
        <Metric
          value={notMeasured(reason, minor('100'))}
          metric="value"
          scope="position"
          basis="snapshot"
        />,
      )
      expect(container.textContent).toContain(headline)
      expect(container.textContent).toContain(explanation)
      assertHonest(container)
      unmount()
    }
  })

  it('keeps the explanation available in a dense table, without printing it inline', () => {
    const { container } = render(
      <Metric
        value={notMeasured('no_transaction_history', NET_WORTH)}
        metric="unrealised"
        scope="position"
        basis="snapshot"
        size="table"
      />,
    )
    expect(container.querySelector('.na-reason')).toBeNull()
    expect(container.querySelector('.vh')?.textContent).toBe('no transaction history')
    assertHonest(container)
  })
})

describe('the honesty assertion itself', () => {
  it('catches a history-dependent metric rendered without coverage', () => {
    const container = document.createElement('div')
    container.innerHTML = '<span data-metric="xirr" data-scope="portfolio">18.42%</span>'
    expect(honestyViolations(container)).toHaveLength(1)
    expect(honestyViolations(container)[0]).toContain('H2')
  })

  it('catches a zero standing in for an unmeasurable metric', () => {
    const container = document.createElement('div')
    container.innerHTML =
      '<span data-metric="xirr" data-not-measured="no_transaction_history" data-excluded-minor="1">₹0</span>'
    expect(honestyViolations(container)[0]).toContain('H3')
  })

  it('catches a dash standing in for one', () => {
    const container = document.createElement('div')
    container.innerHTML =
      '<span data-metric="cost-basis" data-not-measured="no_price" data-excluded-minor="1">—</span>'
    expect(honestyViolations(container)[0]).toContain('H3')
  })

  it('catches a chart whose snapshot geometry is not hatched (H5)', () => {
    const container = document.createElement('div')
    container.innerHTML = '<svg><path data-basis="snapshot"></path></svg>'
    expect(honestyViolations(container)[0]).toContain('H5')
  })

  it('catches a figure-bearing row with no provenance (H6)', () => {
    const container = document.createElement('div')
    container.innerHTML =
      '<table><tbody><tr><td><span data-metric="value" data-scope="position">₹1</span></td></tr></tbody></table>'
    expect(honestyViolations(container)[0]).toContain('H6')
  })

  it('catches a stale price displayed without its age or an alert stamp (H7)', () => {
    const container = document.createElement('div')
    container.innerHTML =
      '<table><tbody><tr><td class="pmark"></td><td><span data-metric="price" data-scope="position" data-stale-days="15">₹11,173</span></td></tr></tbody></table>'
    const problems = honestyViolations(container)
    expect(problems.some((p) => p.includes('H7') && p.includes('age in words'))).toBe(true)
    expect(problems.some((p) => p.includes('H7') && p.includes('alert-variant'))).toBe(true)
  })
})
