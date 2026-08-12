/**
 * `CoverageMeter` and `SplitBar` — the two micro-instruments inside the readout cells.
 *
 * Both are drawn in CSS from the decimal string itself, so neither needs the pixel-geometry escape
 * hatch: `width: 71.90%` is arithmetic the browser does, on a value that never became a float in
 * our code.
 *
 * The meter is achromatic on purpose. Coverage is not an asset class, and spending a hue on it
 * would break the one rule the palette exists to keep.
 */

import type { ReactNode } from 'react'
import type { Dec } from '@domain/numeric'
import { cssPercent, formatPct } from '../format'
import './readout.css'

export interface CoverageMeterProps {
  /** Percentage covered: '71.9'. */
  readonly pct: Dec
  /** What the coverage is of, for the accessible name. */
  readonly of?: string | undefined
}

export function CoverageMeter({ pct, of = 'portfolio value' }: CoverageMeterProps): ReactNode {
  return (
    <>
      <div
        className="meter"
        role="img"
        aria-label={`Coverage ${formatPct(pct, { decimals: 1 }).replace('%', '')} percent of ${of}`}
        data-coverage-meter={pct}
      >
        <span className="meter-fill" style={{ width: cssPercent(pct) }} />
      </div>
      <div className="meter-scale" aria-hidden="true">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100%</span>
      </div>
    </>
  )
}

export interface SplitBarProps {
  readonly aPct: Dec
  readonly bPct: Dec
  readonly aLabel: string
  readonly bLabel: string
}

/** Solid --ink-2 for the base currency against a hatched --ink-4 leg for the foreign one. */
export function SplitBar({ aPct, bPct, aLabel, bLabel }: SplitBarProps): ReactNode {
  return (
    <>
      <div
        className="split"
        role="img"
        aria-label={`${aLabel} ${formatPct(aPct)}, ${bLabel} ${formatPct(bPct)}`}
      >
        <span className="split-a" style={{ width: cssPercent(aPct) }} />
        <span className="split-b" style={{ width: cssPercent(bPct) }} />
      </div>
      <div className="split-key">
        <span>
          {aLabel} {formatPct(aPct)}
        </span>
        <span>
          {bLabel} {formatPct(bPct)}
        </span>
      </div>
    </>
  )
}

export interface WeightBarProps {
  readonly pct: Dec
}

/** The 54px micro-bar beside a weight numeral in a table cell. Decoration: the numeral leads. */
export function WeightBar({ pct }: WeightBarProps): ReactNode {
  return (
    <span className="wbar" aria-hidden="true">
      <i style={{ width: cssPercent(pct) }} />
    </span>
  )
}
