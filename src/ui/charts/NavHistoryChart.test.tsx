/**
 * The price history, and the four ways it can be wrong.
 *
 * Every assertion here is about something the chart must *refuse* to draw: a line across a period
 * with no stored price, a trend through two points, an empty rug where there is no transaction
 * history, and a label derived from the pixel coordinate rather than from the stored string.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { dec } from '@domain/numeric'
import { assertHonest, honestyViolations } from '../testing/assert-honest'
import { HATCH_ID } from './HatchPattern'
import { NavHistoryChart } from './NavHistoryChart'
import type { NavPoint, RugMark } from './NavHistoryChart'

function monthly(from: string, closes: readonly string[]): readonly NavPoint[] {
  const [yearText = '2025', monthText = '01'] = from.split('-')
  return closes.map((close, index) => {
    const month = BigInt(monthText) - 1n + BigInt(index)
    const year = BigInt(yearText) + month / 12n
    const inYear = month % 12n
    return {
      asOf: `${year.toString()}-${(inYear + 1n).toString().padStart(2, '0')}-28`,
      close: dec(close),
    }
  })
}

const TWELVE = monthly('2025-09', [
  '60.9100', '61.5200', '62.9900', '63.2400', '64.6100', '63.8800',
  '65.1400', '66.5200', '65.9400', '68.1600', '69.2200', '69.7670',
])

const MARKS: readonly RugMark[] = [
  { key: 'b1', on: '2025-10-07', direction: 'buy', label: 'Purchase' },
  { key: 'b2', on: '2025-11-07', direction: 'buy', label: 'Purchase' },
  { key: 'b3', on: '2026-06-07', direction: 'buy', label: 'Purchase' },
  { key: 's1', on: '2026-05-12', direction: 'sell', label: 'Redemption' },
]

describe('NavHistoryChart — the line', () => {
  it('draws one path per unbroken run and labels the end from the stored string', () => {
    const { container } = render(
      <NavHistoryChart points={TWELVE} marks={MARKS} instrumentName="Parag Parikh Flexi Cap" />,
    )
    expect(container.querySelectorAll('.line-s2')).toHaveLength(1)
    expect(container.querySelector('.dlab')?.textContent).toBe('₹69.7670')
    assertHonest(container)
  })

  it('chooses a gridline step from the data and labels it in rupees, not in pixels', () => {
    const { container } = render(
      <NavHistoryChart points={TWELVE} marks={MARKS} instrumentName="Parag Parikh Flexi Cap" />,
    )
    const axis = [...container.querySelectorAll('.ax')].map((node) => node.textContent)
    // A whole-rupee step chosen from the span, and no ₹60.0000: the four-decimal NAVs do not put
    // their stored precision on an axis, because a tick is a scale marker rather than a figure.
    expect(axis.filter((text) => text?.startsWith('₹'))).toEqual([
      '₹60',
      '₹62',
      '₹64',
      '₹66',
      '₹68',
      '₹70',
    ])
  })

  it('keeps a four-figure quote on a legible step rather than five hundred gridlines', () => {
    const { container } = render(
      <NavHistoryChart
        points={monthly('2025-09', [
          '2688.40', '2712.55', '2745.90', '2760.20', '2802.35', '2778.60',
          '2811.90', '2856.45', '2833.70', '2894.15', '2908.60', '2908.60',
        ])}
        marks={[]}
        instrumentName="Reliance Industries"
        series="s1"
      />,
    )
    const axis = [...container.querySelectorAll('.ax')].map((node) => node.textContent)
    const rupees = axis.filter((text) => text.startsWith('₹'))
    expect(rupees.length).toBeLessThanOrEqual(7)
    expect(rupees[0]).toBe('₹2,650')
    expect(container.querySelectorAll('.line-s1')).toHaveLength(1)
  })
})

describe('NavHistoryChart — gaps', () => {
  const WITH_A_HOLE: readonly NavPoint[] = [
    { asOf: '2026-01-31', close: dec('60.1000') },
    { asOf: '2026-02-28', close: dec('61.2000') },
    { asOf: '2026-03-31', close: dec('62.3000') },
    // Five months with nothing stored.
    { asOf: '2026-08-31', close: dec('69.7670') },
    { asOf: '2026-09-30', close: dec('70.1000') },
    { asOf: '2026-10-31', close: dec('71.4000') },
  ]

  it('breaks the line rather than interpolating across a period with no stored price', () => {
    const { container } = render(
      <NavHistoryChart points={WITH_A_HOLE} marks={[]} instrumentName="Parag Parikh Flexi Cap" />,
    )
    expect(container.querySelectorAll('.line-s2')).toHaveLength(2)
    expect(container.querySelectorAll('[data-gap="true"]')).toHaveLength(1)
    expect(container.querySelector('svg')?.getAttribute('data-gaps')).toBe('1')
    assertHonest(container)
  })

  it('says in the table that the gap is a gap, not a flat stretch', () => {
    render(<NavHistoryChart points={WITH_A_HOLE} marks={[]} instrumentName="PPFC" />)
    expect(
      screen.getByText('No price stored for this period — not interpolated'),
    ).toBeInTheDocument()
  })

  /**
   * The defect this guards: the threshold was `median * 2` and the comparison is a strict `>`, so
   * the one shape a gap most often takes — a single missing period — was the one shape that could
   * never be flagged. A month-end series missing June has a delta of 61 against a threshold of 62.
   * The line was drawn through the hole, `data-gaps` read 0, the aria-label dropped its clause, and
   * the table lost the row that says the period is not interpolated. Every promise in this file's
   * header, broken quietly, on the commonest case.
   */
  it('flags a single missing month in a month-end series', () => {
    const missingJune: readonly NavPoint[] = [
      { asOf: '2026-01-31', close: dec('60.1000') },
      { asOf: '2026-02-28', close: dec('61.2000') },
      { asOf: '2026-03-31', close: dec('62.3000') },
      { asOf: '2026-04-30', close: dec('63.4000') },
      { asOf: '2026-05-31', close: dec('64.5000') },
      // June is missing. Deltas: 28, 31, 30, 31, 61, 31, 30.
      { asOf: '2026-07-31', close: dec('66.7000') },
      { asOf: '2026-08-31', close: dec('67.8000') },
      { asOf: '2026-09-30', close: dec('68.9000') },
    ]
    const { container } = render(
      <NavHistoryChart points={missingJune} marks={[]} instrumentName="PPFC" />,
    )
    expect(container.querySelector('svg')?.getAttribute('data-gaps')).toBe('1')
    expect(container.querySelectorAll('[data-gap="true"]')).toHaveLength(1)
    // Two runs, because nothing is drawn across the hole.
    expect(container.querySelectorAll('.line-s2')).toHaveLength(2)
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain(
      '1 period no price is stored for',
    )
    expect(
      screen.getByText('No price stored for this period — not interpolated'),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  /**
   * And the same for the short month, which is why the multiplier had to move rather than the
   * comparison: a missing February is a 59-day delta, under `median * 2` however the `>` reads.
   */
  it('flags a missing February, whose delta is shorter than two average months', () => {
    const missingFebruary: readonly NavPoint[] = [
      { asOf: '2025-11-30', close: dec('58.1000') },
      { asOf: '2025-12-31', close: dec('59.1000') },
      // February is missing. Deltas: 31, 31, 59, 31, 30, 31.
      { asOf: '2026-01-31', close: dec('60.1000') },
      { asOf: '2026-03-31', close: dec('62.3000') },
      { asOf: '2026-04-30', close: dec('63.4000') },
      { asOf: '2026-05-31', close: dec('64.5000') },
      { asOf: '2026-06-30', close: dec('65.6000') },
    ]
    const { container } = render(
      <NavHistoryChart points={missingFebruary} marks={[]} instrumentName="PPFC" />,
    )
    expect(container.querySelector('svg')?.getAttribute('data-gaps')).toBe('1')
  })

  it('flags a single missing week in a weekly series without flagging the weeks around it', () => {
    const weekly: readonly NavPoint[] = [
      { asOf: '2026-06-05', close: dec('60.1000') },
      { asOf: '2026-06-12', close: dec('60.2000') },
      { asOf: '2026-06-19', close: dec('60.3000') },
      // One week missing: a 14-day delta against a 7-day cadence.
      { asOf: '2026-07-03', close: dec('60.5000') },
      { asOf: '2026-07-10', close: dec('60.6000') },
      { asOf: '2026-07-17', close: dec('60.7000') },
    ]
    const { container } = render(
      <NavHistoryChart points={weekly} marks={[]} instrumentName="PPFC" />,
    )
    expect(container.querySelector('svg')?.getAttribute('data-gaps')).toBe('1')
    expect(container.querySelectorAll('.line-s2')).toHaveLength(2)
  })

  it('does not treat a weekend in a daily series as a gap', () => {
    const daily: readonly NavPoint[] = [
      { asOf: '2026-08-06', close: dec('69.1000') },
      { asOf: '2026-08-07', close: dec('69.2000') },
      // Saturday and Sunday are not days Misal is missing a price for.
      { asOf: '2026-08-10', close: dec('69.4000') },
      { asOf: '2026-08-11', close: dec('69.7670') },
    ]
    const { container } = render(
      <NavHistoryChart points={daily} marks={[]} instrumentName="PPFC" />,
    )
    expect(container.querySelectorAll('[data-gap="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('.line-s2')).toHaveLength(1)
  })
})

describe('NavHistoryChart — sparse', () => {
  it('refuses to draw a trend through two points', () => {
    const { container } = render(
      <NavHistoryChart
        points={[
          { asOf: '2026-07-31', close: dec('69.1000') },
          { asOf: '2026-08-11', close: dec('69.7670') },
        ]}
        marks={[]}
        instrumentName="PPFC"
      />,
    )
    expect(container.querySelector('svg')?.getAttribute('data-state')).toBe('sparse')
    expect(container.querySelectorAll('.line-s2')).toHaveLength(0)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByText(/would be a trend/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('places a single stored price on a real scale and says it is not a history', () => {
    const { container } = render(
      <NavHistoryChart
        points={[{ asOf: '2026-08-11', close: dec('11173.6500') }]}
        marks={null}
        instrumentName="Augmont Digital Gold"
        series="s5"
      />,
    )
    expect(container.querySelector('svg')?.getAttribute('data-state')).toBe('sparse')
    expect(screen.getByText(/One stored price is a point, not a history/u)).toBeInTheDocument()
    assertHonest(container)
  })
})

describe('NavHistoryChart — the rug', () => {
  it('marks purchases upward and disposals downward, and counts each end', () => {
    const { container } = render(
      <NavHistoryChart points={TWELVE} marks={MARKS} instrumentName="PPFC" />,
    )
    expect(container.querySelectorAll('[data-rug="buy"]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-rug="sell"]')).toHaveLength(1)
    expect(container.querySelector('.rug-lab')?.textContent).toBe('▲ 3 PURCHASES')
    expect(container.querySelector('.rug-lab2')?.textContent).toBe('▼ 1 REDEMPTION · 12 MAY 2026')
  })

  it('hatches the rug of a holding with no transaction history, in its own defs (H5)', () => {
    const { container } = render(
      <NavHistoryChart points={TWELVE} marks={null} instrumentName="Augmont Digital Gold" series="s5" />,
    )
    expect(container.querySelectorAll('[data-basis="snapshot"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(1)
    expect(container.querySelector(`svg #${HATCH_ID}`)).not.toBeNull()
    expect(screen.getByText(/NO TRANSACTION HISTORY/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('does not lean on another chart for the hatch it draws', () => {
    // The production hazard: this chart mounted beside one that carries the defs. Rendered alone,
    // it must still define the pattern it references.
    const { container } = render(
      <NavHistoryChart points={TWELVE} marks={null} instrumentName="Gold" series="s5" />,
    )
    expect(honestyViolations(container)).toEqual([])
  })

  it('extends the rug back past the first stored price, and says so', () => {
    const { container } = render(
      <NavHistoryChart
        points={TWELVE}
        marks={[{ key: 'old', on: '2024-09-07', direction: 'buy', label: 'Purchase' }]}
        instrumentName="PPFC"
      />,
    )
    expect(container.querySelector('.gap-lab')?.textContent).toContain('PRICE HISTORY BEGINS SEP 25')
    assertHonest(container)
  })
})

describe('NavHistoryChart — the other states', () => {
  it('names the absence rather than drawing an empty plot', () => {
    render(<NavHistoryChart points={[]} marks={[]} instrumentName="A new holding" />)
    expect(screen.getByText(/No price is stored for this instrument yet/u)).toBeInTheDocument()
  })

  it('draws a skeleton while loading, never a plausible line', () => {
    const { container } = render(
      <NavHistoryChart points={[]} marks={[]} instrumentName="PPFC" state="loading" />,
    )
    expect(container.querySelector('.f-skel')).not.toBeNull()
    expect(container.querySelectorAll('.line-s2')).toHaveLength(0)
  })

  it('refuses a date it cannot read rather than plotting it somewhere', () => {
    render(
      <NavHistoryChart
        points={[
          { asOf: 'not-a-date', close: dec('1.00') },
          { asOf: '2026-08-11', close: dec('2.00') },
          { asOf: '2026-08-12', close: dec('3.00') },
        ]}
        marks={[]}
        instrumentName="PPFC"
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('not-a-date')
  })

  it('states the failure when the history could not be read at all', () => {
    render(
      <NavHistoryChart points={[]} marks={[]} instrumentName="PPFC" state="error" errorMessage="The price table could not be read." />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The price table could not be read.')
  })
})
