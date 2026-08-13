/**
 * The coverage meter, and the one rounding rule it is allowed to use.
 *
 * The meter's accessible name is the only figure a screen-reader user gets from this component —
 * the bar itself is `role="img"` and the fill is CSS width. So the name is held to the same
 * standard as the printed coverage line beside it: `100.0 percent` may be spoken only when the
 * metric genuinely spans the whole portfolio.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { dec } from '@domain/numeric'
import { CoverageMeter, coverageText } from './CoverageMeter'

describe('coverageText', () => {
  it('truncates rather than rounding, so 100.0 means complete', () => {
    // `historyCoveragePct` clamps to 99.99 precisely so 100.00 can only mean exact equality.
    // Rounding half-up at one decimal hands that clamped value straight back as "100.0".
    expect(coverageText(dec('99.99'))).toBe('99.9')
    expect(coverageText(dec('99.95'))).toBe('99.9')
    expect(coverageText(dec('99.9'))).toBe('99.9')
    expect(coverageText(dec('100.00'))).toBe('100.0')
  })

  it('truncates below the second decimal too, rather than rounding its way up', () => {
    expect(coverageText(dec('99.996'))).toBe('99.9')
    expect(coverageText(dec('71.98'))).toBe('71.9')
  })

  it('keeps the exact ends exact', () => {
    expect(coverageText(dec('0'))).toBe('0.0')
    expect(coverageText(dec('0.04'))).toBe('0.0')
    expect(coverageText(dec('50'))).toBe('50.0')
  })

  it('leaves a negative legible rather than malformed', () => {
    // Not reachable from `historyCoveragePct`, but a numeral like '-1.-2' would be worse than the
    // bug it came from.
    expect(coverageText(dec('-3.5'))).toBe('−3.5')
  })
})

describe('CoverageMeter', () => {
  it('speaks the truncated figure, so the name and the coverage line agree', () => {
    render(<CoverageMeter pct={dec('99.99')} of="net worth" />)
    expect(screen.getByLabelText('Coverage 99.9 percent of net worth')).toBeInTheDocument()
    expect(screen.queryByLabelText(/100\.0 percent/u)).toBeNull()
  })

  it('still says 100.0 percent when the metric covers everything', () => {
    render(<CoverageMeter pct={dec('100.00')} />)
    expect(
      screen.getByLabelText('Coverage 100.0 percent of portfolio value'),
    ).toBeInTheDocument()
  })

  it('carries the unrounded percentage on the element, for the assertion suite', () => {
    const { container } = render(<CoverageMeter pct={dec('99.99')} />)
    expect(container.querySelector('.meter')?.getAttribute('data-coverage-meter')).toBe('99.99')
  })
})
