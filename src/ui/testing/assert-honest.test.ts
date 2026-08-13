/**
 * The honesty suite's own tests, for the invariant that had no way to see the defect it exists to
 * stop.
 *
 * A coverage meter beside a withheld figure shipped for as long as it did because `assertHonest`
 * only ever asked one question — does a figure state its coverage? — and the meter is not a
 * figure. It carried no `data-metric`, so H2 walked straight past it, and the component tests that
 * rendered it in the withheld state passed while the cell read "Not priced" above a bar labelled
 * "Coverage 56.6 percent of portfolio value".
 *
 * These tests are written against raw DOM rather than against a component on purpose: the rule
 * belongs to `[data-coverage-meter]`, not to `ReadoutCell`, and the next component to draw a meter
 * must inherit it without anyone remembering that this file exists.
 */

import { describe, expect, it } from 'vitest'
import { honestyViolations } from './assert-honest'

function dom(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

/** A cell as `ReadoutCell` builds one: the figure, then the meter, inside `[data-cell-metric]`. */
function cell(figure: string, meter: string): string {
  return `<div data-cell-metric="xirr"><div>${figure}${meter}</div></div>`
}

const WITHHELD =
  '<span data-metric="xirr" data-scope="portfolio" data-not-measured="no_price" data-excluded-minor="55395000">Not pricedno price available</span>'

const MEASURED =
  '<span data-metric="xirr" data-scope="portfolio" data-coverage-pct="56.6" data-coverage-minor="6600000">18.42%</span>'

describe('a coverage meter beside a metric that was never measured', () => {
  it('is a violation when the meter names the metric it covers', () => {
    const container = dom(
      cell(
        WITHHELD,
        '<div data-coverage-meter="56.60" data-metric="xirr" data-scope="portfolio" data-coverage-pct="56.6" data-coverage-minor="6600000"></div>',
      ),
    )
    const problems = honestyViolations(container)
    expect(problems.some((p) => p.includes('H2') && p.includes('not measured'))).toBe(true)
  })

  it('is a violation in the shape the defect actually shipped in — a bare meter with no metric', () => {
    // The meter carried nothing but its own percentage, which is precisely why H2 could not see
    // it. An unbindable bar inside a metric cell is now two violations, not zero.
    const container = dom(cell(WITHHELD, '<div data-coverage-meter="56.60"></div>'))
    const problems = honestyViolations(container)
    expect(problems.some((p) => p.includes('H2') && p.includes('not measured'))).toBe(true)
    expect(problems.some((p) => p.includes('H2') && p.includes('data-metric'))).toBe(true)
  })

  it('is a violation at 100.0%, which is the worst reading of all', () => {
    // When the unpriced pair contributes to neither side of the fraction the bar reads exactly
    // 100.0% — the one value this product documents as meaning "complete" — over a figure that
    // was never computed.
    const container = dom(
      cell(WITHHELD, '<div data-coverage-meter="100.00" data-metric="xirr"></div>'),
    )
    expect(honestyViolations(container).some((p) => p.includes('100.00%'))).toBe(true)
  })

  it('holds for every reason a figure can be withheld, not just the unpriced one', () => {
    for (const reason of ['no_convergence', 'no_transaction_history', 'no_fx_rate']) {
      const figure = WITHHELD.replace('no_price', reason)
      const container = dom(
        cell(figure, '<div data-coverage-meter="99.99" data-metric="xirr"></div>'),
      )
      expect(honestyViolations(container).some((p) => p.includes(reason))).toBe(true)
    }
  })
})

describe('what the meter rule must not accuse', () => {
  it('allows a meter beside the measured figure it covers', () => {
    const container = dom(
      cell(
        MEASURED,
        '<div data-coverage-meter="56.60" data-metric="xirr" data-scope="portfolio" data-coverage-pct="56.6" data-coverage-minor="6600000"></div>',
      ),
    )
    expect(honestyViolations(container)).toEqual([])
  })

  it('does not blame a meter for a different metric withheld in the same cell', () => {
    // A cell's sub-row can be withheld while its headline figure is real. The meter names what it
    // covers, so the pairing it is judged on is the one it actually claims.
    const subRow = MEASURED.replace('data-metric="xirr"', 'data-metric="unrealised-pct"')
      .replace('data-coverage-pct="56.6"', 'data-not-measured="no_price"')
      .replace('data-coverage-minor="6600000"', 'data-excluded-minor="1"')
    const container = dom(
      cell(
        MEASURED + subRow,
        '<div data-coverage-meter="56.60" data-metric="xirr" data-coverage-pct="56.6" data-coverage-minor="6600000"></div>',
      ),
    )
    expect(honestyViolations(container)).toEqual([])
  })

  it('does not blame a specimen meter for an unmeasured metric elsewhere on the panel', () => {
    // The gallery renders three meters as design specimens in the same <section> as every
    // withheld state in the product. A meter with no figure beside it claims nothing.
    const container = dom(
      `<section><div><span class="lab">Fully measured</span><div data-coverage-meter="100.00"></div></div><div>${WITHHELD}</div></section>`,
    )
    expect(honestyViolations(container)).toEqual([])
  })
})
