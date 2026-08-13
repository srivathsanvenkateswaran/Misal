/**
 * `Metric` — the only sanctioned renderer for a figure (spec §8.5).
 *
 * It takes a `Measured<Figure>` and handles both branches, which is what makes H3 structural: the
 * `measured: false` branch of `Measured<T>` has no `value` property at all, so there is no
 * expression in this file — or anywhere else — that could produce a zero for a metric that was
 * never measured. There is no `orElse`, no default, and no dash.
 *
 * It also emits the `data-*` contract of spec §5, which is what the honesty suite asserts against.
 */

import type { ReactNode } from 'react'
import type { Measured, NotMeasuredReason } from '@domain/measured'
import { REASON_TEXT, coveragePercent } from '@domain/measured'
import type { Figure } from '../figure'
import { formatFigure, isNegativeFigure } from '../figure'
import type { Basis, MetricId, Scope } from '../metrics'
import './Metric.css'

export type MetricSize = 'hero' | 'value' | 'cell' | 'table'

/**
 * The cell text for each reason. Fixed copy: a component may not invent its own wording for why
 * a number is absent, because that wording is the product's answer to "why is this blank".
 */
const HEADLINE: Record<NotMeasuredReason, string> = {
  no_transaction_history: 'Not measured',
  no_price: 'Not priced',
  no_fx_rate: 'Not converted',
  no_convergence: 'Not measured',
  unknown_tax_regime: 'Not measured',
  no_grandfathering_fmv: 'Not measured',
  unresolved_instrument: 'Not counted',
}

export interface NotMeasuredProps {
  readonly reason: NotMeasuredReason
  /** In a dense table the explanation is available to assistive tech and on hover, not inline. */
  readonly reasonDisplay?: 'inline' | 'assistive'
}

export function NotMeasured({
  reason,
  reasonDisplay = 'inline',
}: NotMeasuredProps): ReactNode {
  const explanation = REASON_TEXT[reason]
  return (
    <>
      <span className="na" title={explanation}>
        {HEADLINE[reason]}
      </span>
      <span className={reasonDisplay === 'inline' ? 'na-reason' : 'vh'}>{explanation}</span>
    </>
  )
}

export interface MetricProps {
  readonly value: Measured<Figure>
  readonly metric: MetricId
  readonly scope: Scope
  readonly basis: Basis
  readonly size?: MetricSize
  /** Days since the price this figure was computed from. Drives H7's alert treatment upstream. */
  readonly staleDays?: number | undefined
  /** Apply --pos / --neg as redundant reinforcement of the sign glyph the figure already carries. */
  readonly tone?: boolean | undefined
  readonly className?: string | undefined
}

export function Metric(props: MetricProps): ReactNode {
  const { value, metric, scope, basis, size = 'cell', className } = props

  const sizeClass = `metric metric-${size}`
  const classes = className === undefined ? sizeClass : `${sizeClass} ${className}`

  if (!value.measured) {
    return (
      <span
        className={classes}
        data-metric={metric}
        data-scope={scope}
        data-basis={basis}
        data-not-measured={value.reason}
        data-excluded-minor={value.excluded}
        data-stale-days={props.staleDays}
      >
        <NotMeasured
          reason={value.reason}
          reasonDisplay={size === 'table' ? 'assistive' : 'inline'}
        />
      </span>
    )
  }

  const negative = isNegativeFigure(value.value)
  const toneClass = props.tone === true ? (negative ? ' neg' : ' pos') : ''

  return (
    <span
      className={`${classes}${toneClass}`}
      data-metric={metric}
      data-scope={scope}
      data-basis={basis}
      data-coverage-pct={coveragePercent(value.coverage)}
      data-coverage-minor={value.coverage.covered}
      data-stale-days={props.staleDays}
    >
      {formatFigure(value.value)}
    </span>
  )
}
