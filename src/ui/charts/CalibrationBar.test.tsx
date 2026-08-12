import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import * as fx from '../gallery/fixtures'
import { assertHonest } from '../testing/assert-honest'
import { CalibrationBar } from './CalibrationBar'
import { chooseTickSteps, roundUpScaleMax, ticks } from './scale'

function mockupBar(overrides: Partial<Parameters<typeof CalibrationBar>[0]> = {}) {
  return (
    <CalibrationBar
      segments={fx.CALIBRATION_SEGMENTS}
      netWorth={fx.NET_WORTH}
      ledgerBacked={fx.LEDGER_BACKED}
      snapshotOnly={fx.SNAPSHOT_ONLY}
      accountsLedger={4}
      accountsTotal={6}
      {...overrides}
    />
  )
}

function readX(container: HTMLElement, selector: string): number {
  return Number(container.querySelector(selector)?.getAttribute('x'))
}

describe('CalibrationBar — the ruler', () => {
  it('rounds the scale up to a clean step and ticks each lakh, labelling each ₹5L', () => {
    expect(roundUpScaleMax(fx.NET_WORTH)).toBe('500000000')
    const steps = chooseTickSteps(fx.R('5000000'))
    expect(steps.minor).toBe(10_000_000n)
    expect(steps.major).toBe(50_000_000n)
    expect(ticks(fx.R('5000000'), steps)).toHaveLength(51)
  })

  it('labels the majors as the mockup does', () => {
    const { container } = render(mockupBar())
    const labels = [...container.querySelectorAll('.tick-lab')].map((node) => node.textContent)
    expect(labels).toEqual([
      '0',
      '₹5L',
      '₹10L',
      '₹15L',
      '₹20L',
      '₹25L',
      '₹30L',
      '₹35L',
      '₹40L',
      '₹45L',
      '₹50L',
    ])
    expect(container.querySelectorAll('.tick-min')).toHaveLength(40)
  })
})

describe('CalibrationBar — the coverage story', () => {
  it('names both sides of the boundary, in percent and to the rupee', () => {
    const { container } = render(mockupBar())
    // 71.8, not the mockup's 71.9. The bar derives its percentage from the amounts beside it
    // using the domain's coveragePercent, which truncates so that "100.0%" can only appear at
    // genuine completeness. Rounding half-up would let 99.96% coverage claim to be total, and a
    // coverage figure that overstates itself is the one number this component must never produce.
    expect(container.querySelector('.cal-lab-l')?.textContent).toBe(
      '71.8% LEDGER-BACKED · ₹34,73,722',
    )
    expect(container.querySelector('.cal-lab-r')?.textContent).toBe(
      '28.1% SNAPSHOT ONLY · ₹13,58,428',
    )
    expect(container.querySelector('.total-lab')?.textContent).toBe('NET WORTH ₹48,32,150')
    expect(container.querySelector('.bracket-lab')?.textContent).toContain('₹13,58,428')
    assertHonest(container)
  })

  it('lays the ledger classes out first, then the snapshot ones, both by descending value', () => {
    const { container } = render(mockupBar())
    const order = [...container.querySelectorAll('[data-asset-class]')].map((node) => [
      node.getAttribute('data-asset-class'),
      node.getAttribute('data-basis'),
    ])
    expect(order).toEqual([
      ['mutual_fund', 'ledger'],
      ['indian_equity', 'ledger'],
      ['crypto', 'ledger'],
      ['us_equity', 'snapshot'],
      ['gold', 'snapshot'],
    ])
  })

  it('reconciles the drawn segments against the stated net worth', () => {
    const { container } = render(mockupBar())
    expect(container.querySelector('[data-reconciles]')).toHaveAttribute('data-reconciles', 'true')
  })

  it('hatches every snapshot segment and only those (H5)', () => {
    const { container } = render(mockupBar())
    expect(container.querySelectorAll('[data-basis="snapshot"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(2)
    assertHonest(container)
  })

  it('labels every segment with its name and share, so the bar reads without colour', () => {
    const { container } = render(mockupBar())
    const inside = [...container.querySelectorAll('.seg-name')].map((n) => n.textContent)
    const outside = [...container.querySelectorAll('.seg-name-out')].map((n) => n.textContent)
    expect(inside).toContain('MUTUAL FUNDS')
    expect(inside).toContain('US EQUITY')
    // Gold is too narrow for an inside label, so it sits above the bar — with its share.
    expect(outside).toEqual(['GOLD 4.97%'])
  })
})

describe('CalibrationBar — the harshest honest states', () => {
  it('draws 0% coverage as a fully hatched bar with the caret at the origin', () => {
    const { container } = render(
      mockupBar({
        segments: fx.ALL_SNAPSHOT_SEGMENTS,
        ledgerBacked: fx.R('0'),
        snapshotOnly: fx.NET_WORTH,
        accountsLedger: 0,
      }),
    )
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(5)
    expect(container.querySelector('.boundary')).toHaveAttribute('x1', '44')
    expect(container.querySelector('.cal-lab-l')?.textContent).toBe('0.0% LEDGER-BACKED · ₹0')
    expect(container.querySelector('.bracket-lab')?.textContent).toContain('₹48,32,150')
    assertHonest(container)
  })

  it('draws 100% coverage with no hatch, and still displays the coverage figure', () => {
    const { container } = render(
      mockupBar({
        segments: fx.ALL_LEDGER_SEGMENTS,
        ledgerBacked: fx.NET_WORTH,
        snapshotOnly: fx.R('0'),
        accountsLedger: 6,
      }),
    )
    expect(container.querySelectorAll('[data-hatch]')).toHaveLength(0)
    expect(container.querySelector('.cal-lab-l')?.textContent).toBe(
      '100.0% LEDGER-BACKED · ₹48,32,150',
    )
    // Nothing is excluded, so there is no bracket to caption.
    expect(container.querySelector('.bracket')).toBeNull()
    assertHonest(container)
  })

  it('keeps the boundary annotations inside the plot and clear of each other at both extremes', () => {
    const extremes = [
      {
        ledgerBacked: fx.R('0'),
        snapshotOnly: fx.NET_WORTH,
      },
      {
        ledgerBacked: fx.NET_WORTH,
        snapshotOnly: fx.R('0'),
      },
    ]
    for (const extreme of extremes) {
      const { container, unmount } = render(mockupBar(extreme))
      const ledgerEnd = readX(container, '.cal-lab-l')
      const snapshotStart = readX(container, '.cal-lab-r')
      const ledgerLabel = container.querySelector('.cal-lab-l')?.textContent ?? ''
      // The left label is right-anchored, so its start is its x minus its own width.
      expect(ledgerEnd - ledgerLabel.length * 7.2).toBeGreaterThanOrEqual(44)
      expect(snapshotStart).toBeGreaterThan(ledgerEnd)
      expect(snapshotStart).toBeLessThan(1324)
      unmount()
    }
  })

  it('draws the ruler while loading, and invents no figure', () => {
    const { container } = render(mockupBar({ state: 'loading' }))
    expect(container.querySelector('.rule-axis')).not.toBeNull()
    expect(container.querySelector('.f-skel')).not.toBeNull()
    expect(container.querySelector('.seg-pct')).toBeNull()
    expect(container.textContent).not.toContain('48,32,150')
    assertHonest(container)
  })

  it('draws a calibrated instrument with nothing to measure on first run', () => {
    const { container } = render(
      mockupBar({
        segments: [],
        netWorth: fx.R('0'),
        ledgerBacked: fx.R('0'),
        snapshotOnly: fx.R('0'),
        state: 'empty',
      }),
    )
    expect(screen.getByText('Nothing measured yet')).toBeInTheDocument()
    expect(
      screen.getByText('What fraction of net worth the deeper metrics can actually measure'),
    ).toBeInTheDocument()
    expect(container.querySelector('.boundary')).toBeNull()
    expect(container.querySelector('.rule-axis')).not.toBeNull()
    assertHonest(container)
  })

  it('names the failure and suppresses net worth on error', () => {
    render(mockupBar({ state: 'error', errorMessage: 'Prices unavailable (E_PRICE_STORE).' }))
    expect(screen.getByRole('alert')).toHaveTextContent('E_PRICE_STORE')
    expect(screen.queryByText(/48,32,150/)).toBeNull()
  })
})
