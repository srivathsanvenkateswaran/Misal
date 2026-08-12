import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { dec } from '@domain/numeric'
import * as fx from '../gallery/fixtures'
import { assertHonest } from '../testing/assert-honest'
import { ConcentrationChart } from './ConcentrationChart'
import { HATCH_ID, HatchPattern } from './HatchPattern'
import { NetWorthStackChart } from './NetWorthStackChart'
import { CoverageMeter } from '../readout/CoverageMeter'

describe('HatchPattern', () => {
  it('defines one pattern whose stroke is the surface, so it carves rather than paints', () => {
    const { container } = render(
      <svg>
        <HatchPattern />
      </svg>,
    )
    const pattern = container.querySelector(`#${HATCH_ID}`)
    expect(pattern).not.toBeNull()
    expect(pattern).toHaveAttribute('patternTransform', 'rotate(45)')
    expect(pattern?.querySelector('line')).toHaveClass('hx-line')
  })
})

describe('NetWorthStackChart', () => {
  it('stacks ledger classes below snapshot classes and hatches only the snapshot ones (H5)', () => {
    const { container } = render(<NetWorthStackChart months={fx.TWELVE_MONTHS} />)
    const firstColumn = container.querySelector('[data-month]')
    const order = [...(firstColumn?.querySelectorAll('[data-asset-class]') ?? [])].map((node) => [
      node.getAttribute('data-asset-class'),
      node.getAttribute('data-basis'),
    ])
    expect(order).toEqual([
      ['indian_equity', 'ledger'],
      ['mutual_fund', 'ledger'],
      ['crypto', 'ledger'],
      ['us_equity', 'snapshot'],
      ['gold', 'snapshot'],
    ])
    expect(container.querySelectorAll('[data-basis="snapshot"]')).toHaveLength(24)
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(24)
    assertHonest(container)
  })

  it('labels the axis with month and year, and the final column with its total', () => {
    const { container } = render(<NetWorthStackChart months={fx.TWELVE_MONTHS} />)
    const axis = [...container.querySelectorAll('.ax')].map((node) => node.textContent)
    expect(axis).toContain('SEP')
    expect(axis).toContain('AUG')
    expect(container.querySelector('.dlab')?.textContent).toBe('₹48.32L')
  })

  it('renders months before history as gaps, never back-filled (H10)', () => {
    const { container } = render(
      <NetWorthStackChart months={fx.MONTHS_WITH_GAPS} historyBegins="FEB 2026" />,
    )
    expect(container.querySelectorAll('[data-gap="true"]')).toHaveLength(5)
    expect(container.querySelectorAll('[data-month]')).toHaveLength(7)
    expect(container.querySelector('.gap-lab')?.textContent).toContain('HISTORY BEGINS FEB 2026')
    // Nothing is drawn in a gap month: no geometry, and no value in the accessible table either.
    expect(container.querySelectorAll('[data-asset-class]')).toHaveLength(35)
    expect(screen.getAllByText('No history — not drawn')).toHaveLength(5)
    assertHonest(container)
  })

  it('offers its values as a table, because twelve months cannot live in an aria-label', () => {
    render(<NetWorthStackChart months={fx.TWELVE_MONTHS} />)
    const table = screen.getByRole('table', { name: 'Net worth by asset class, month end' })
    expect(table).toHaveTextContent('₹48,32,150')
    expect(table).toHaveTextContent('US equity ₹11,18,428 (snapshot only)')
  })

  it('names what is absent when there is no history at all', () => {
    render(<NetWorthStackChart months={[]} state="empty" />)
    expect(screen.getByText(/History begins after your first import/)).toBeInTheDocument()
  })
})

describe('ConcentrationChart', () => {
  it('labels every bar with its name and value, so it reads with colour removed', () => {
    const { container } = render(
      <ConcentrationChart rows={fx.CONCENTRATION_TOP5} threshold={dec('20')} />,
    )
    const labels = [...container.querySelectorAll('.conc-lab')].map((node) => node.textContent)
    const values = [...container.querySelectorAll('.conc-val')].map((node) => node.textContent)
    expect(labels).toEqual([
      'Caterpillar Inc (CAT)',
      'Parag Parikh Flexi Cap',
      'UTI Nifty 50 Index',
      'Reliance Industries',
      'HDFC Bank',
      'Other (7 positions)',
    ])
    expect(values).toEqual(['23.15%', '16.23%', '10.57%', '9.93%', '8.82%', '31.30%'])
    assertHonest(container)
  })

  it('hatches the snapshot bar only (H5)', () => {
    const { container } = render(
      <ConcentrationChart rows={fx.CONCENTRATION_TOP5} threshold={dec('20')} />,
    )
    expect(container.querySelectorAll('[data-basis="snapshot"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(1)
    assertHonest(container)
  })

  it('draws the single-position threshold with a caption under the plot', () => {
    const { container } = render(
      <ConcentrationChart rows={fx.CONCENTRATION_TOP5} threshold={dec('20')} />,
    )
    expect(container.querySelector('.thresh')).not.toBeNull()
    expect(container.querySelector('.thresh-lab')?.textContent).toBe('20% SINGLE-POSITION FLAG')
  })

  it('ends the axis on a labelled gridline above the largest bar', () => {
    // The largest bar here is the 31.30% aggregate of everything outside the top five, so the
    // axis runs to 35% — the scale follows the data rather than the headline.
    const { container } = render(<ConcentrationChart rows={fx.CONCENTRATION_TOP5} />)
    const axis = [...container.querySelectorAll('.ax')].map((node) => node.textContent)
    expect(axis).toEqual(['0%', '5%', '10%', '15%', '20%', '25%', '30%', '35%'])

    const { container: topFiveOnly } = render(
      <ConcentrationChart rows={fx.CONCENTRATION_TOP5.slice(0, 5)} />,
    )
    expect([...topFiveOnly.querySelectorAll('.ax')].map((node) => node.textContent)).toEqual([
      '0%',
      '5%',
      '10%',
      '15%',
      '20%',
      '25%',
    ])
  })

  it('says so when there is nothing to concentrate', () => {
    render(<ConcentrationChart rows={fx.CONCENTRATION_TOP5.slice(0, 1)} />)
    expect(screen.getByText(/Fewer than 2 positions/)).toBeInTheDocument()
  })
})

describe('CoverageMeter', () => {
  it('draws the fill from the decimal string and names the coverage in words', () => {
    const { container } = render(<CoverageMeter pct={dec('71.90')} />)
    expect(container.querySelector('.meter-fill')).toHaveStyle({ width: '71.90%' })
    expect(
      screen.getByRole('img', { name: 'Coverage 71.9 percent of portfolio value' }),
    ).toBeInTheDocument()
  })

  it('draws nothing measured as an empty track, not as a missing meter', () => {
    const { container } = render(<CoverageMeter pct={dec('0')} />)
    expect(container.querySelector('.meter')).not.toBeNull()
    expect(container.querySelector('.meter-fill')).toHaveStyle({ width: '0.00%' })
  })
})
