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
import type { Coverage } from '@domain/measured'
import { coveragePercent } from '@domain/measured'
import type { Dec, Minor } from '@domain/numeric'
import { minor } from '@domain/numeric'
import { MINUS, cssPercent, formatPct } from '../format'
import type { MetricId, Scope } from '../metrics'
import './readout.css'

/** 100.00%, counted in hundredths of a percentage point. */
const WHOLE: Minor = minor('10000')

/** A percentage's hundredths, truncated rather than rounded, so nothing is gained on the way in. */
function hundredths(pct: string): Minor {
  const dot = pct.indexOf('.')
  const whole = dot === -1 ? pct : pct.slice(0, dot)
  const frac = dot === -1 ? '' : pct.slice(dot + 1)
  return minor(BigInt(`${whole}${frac.slice(0, 2).padEnd(2, '0')}`))
}

/**
 * One-decimal display text for a value that is already a percentage: `'99.99'` → `'99.9'`.
 *
 * Routed through the domain's `coveragePercent`, which truncates, rather than through `formatPct`,
 * which rounds half-up. The difference is the entire point of the function. `historyCoveragePct`
 * clamps to `99.99` precisely so that `100.00` can only mean exact equality; rounding half-up at
 * one decimal hands anything from 99.95 upwards back the "100.0%" that clamp exists to prevent,
 * which is the "lie by rounding" `coverage.ts` names as the fastest way this feature loses trust.
 *
 * `coveragePercent` is expressed over rupees, so the percentage is handed to it as its hundredths
 * over a 100.00% whole. The integer division it performs is the same either way, and there is one
 * truncation rule in the product rather than two that agree until they do not.
 */
export function coverageText(pct: Dec): string {
  const negative = pct.startsWith('-')
  const magnitude = coveragePercent({
    covered: hundredths(negative ? pct.slice(1) : pct),
    total: WHOLE,
    excludedAccounts: [],
  })
  // A negative share is not a coverage. It cannot arise from `historyCoveragePct`, but if one ever
  // reaches here it leaves as a legible negative rather than as a malformed numeral.
  return negative ? `${MINUS}${magnitude}` : magnitude
}

export interface CoverageMeterProps {
  /** Percentage covered: '71.9'. */
  readonly pct: Dec
  /** What the coverage is of, for the accessible name. */
  readonly of?: string | undefined
  /**
   * The metric this bar speaks for, and that metric's own coverage.
   *
   * A meter is never a free-standing percentage: it qualifies a figure. Naming the figure is what
   * lets `assertHonest` bind the bar to the metric beside it and refuse the pairing when that
   * metric was withheld — a bar reading "100.0 percent of portfolio value" under the words "Not
   * priced" states a completeness nothing computed. Optional only because the gallery draws the
   * component as a specimen with no figure to qualify; a meter inside a metric cell must name it.
   */
  readonly metric?: MetricId | undefined
  readonly scope?: Scope | undefined
  readonly coverage?: Coverage | undefined
}

export function CoverageMeter({
  pct,
  of = 'portfolio value',
  metric,
  scope,
  coverage,
}: CoverageMeterProps): ReactNode {
  return (
    <>
      <div
        className="meter"
        role="img"
        // The accessible name is the *only* figure a screen-reader user gets from this component,
        // so it takes the truncating rule the coverage line above it already uses. Rounding here
        // put "100.0 percent" in one ear while the sighted line beside it read 99.9%.
        aria-label={`Coverage ${coverageText(pct)} percent of ${of}`}
        data-coverage-meter={pct}
        // The §5 metric contract, so H2 treats the bar as part of its cell rather than as loose
        // geometry it has no opinion about. The coverage stated here is the metric's own — the
        // same `MetricCoverage` the drawn percentage comes from — never a second figure.
        data-metric={metric}
        data-scope={scope}
        data-coverage-pct={coverage === undefined ? undefined : coveragePercent(coverage)}
        data-coverage-minor={coverage?.covered}
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
