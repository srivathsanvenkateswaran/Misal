/**
 * `ReadoutCell`, `ReadoutGrid` — the dashboard readout (spec §8.4).
 *
 * A cell is a label, a figure, optional sub-rows, an optional coverage line and a micro-note. The
 * figure is always a `Measured<Figure>` rendered through `Metric`, so both branches are handled
 * and neither can produce a zero.
 *
 * H2 is structural here. A history-dependent metric at portfolio, class or account scope renders
 * its coverage — the percentage *and* the rupee amount — in the same visual component as the
 * figure. Not in a tooltip, not in a page footnote: the cell says what it covers, next to what it
 * claims.
 *
 * D1 applies to the grid: all seven dashboard cells are derived, so seven identical dotted `DRV`
 * marks would say nothing seven times. The grid states it once at panel level and carries
 * `data-stamp-scope`; the hero keeps a single stamp so the gutter rhythm and the stamp system stay
 * visibly present, and the remaining gutters are aria-hidden spacers holding the left edge.
 */

import type { ReactNode } from 'react'
import type { Measured } from '@domain/measured'
import { coveragePercent } from '@domain/measured'
import type { Dec } from '@domain/numeric'
import type { Figure } from '../figure'
import { formatMoney, money } from '../format'
import type { Basis, MetricId, Scope } from '../metrics'
import { isHistoryDependent } from '../metrics'
import { Metric } from '../measured/Metric'
import type { SourceStampProps } from '../provenance/SourceStamp'
import { StampGutter } from '../provenance/SourceStamp'
import { CoverageMeter, SplitBar } from './CoverageMeter'
import './readout.css'

export type ReadoutState = 'ready' | 'loading' | 'error' | 'refreshing'

export interface ReadoutSubRow {
  readonly label: string
  readonly value: Measured<Figure>
  readonly metric: MetricId
  /** Apply --pos / --neg as redundant reinforcement of the sign the figure already carries. */
  readonly tone?: boolean
  readonly emphasis?: boolean
}

export interface ReadoutFootRow {
  readonly label: string
  readonly value: ReactNode
  readonly muted?: boolean
}

export interface ReadoutCellProps {
  readonly label: string
  readonly value: Measured<Figure>
  readonly metric: MetricId
  readonly scope: Scope
  readonly basis: Basis
  readonly sub?: readonly ReadoutSubRow[]
  /** Rendered below a hairline at the foot of the cell — the hero's ledger/snapshot split. */
  readonly foot?: readonly ReadoutFootRow[]
  readonly note?: string
  readonly meter?: { readonly pct: Dec; readonly of?: string }
  readonly split?: { readonly aPct: Dec; readonly bPct: Dec; readonly aLabel: string; readonly bLabel: string }
  readonly stamp?: SourceStampProps
  readonly hero?: boolean
  readonly tone?: boolean
  readonly state?: ReadoutState
  /** Overrides the generated coverage line. The line itself is not optional under H2. */
  readonly coverageLine?: string
}

/** H2's sentence: what the metric covers, in rupees and percent, beside the metric itself. */
function coverageLineFor(value: Measured<Figure>): string {
  if (value.measured) {
    return `Covers ${formatMoney(money(value.coverage.covered))} / ${coveragePercent(value.coverage)}% of net worth`
  }
  return `Excludes ${formatMoney(money(value.excluded))} of net worth`
}

export function ReadoutCell(props: ReadoutCellProps): ReactNode {
  const state = props.state ?? 'ready'
  const hero = props.hero === true
  const showCoverage = isHistoryDependent(props.metric) && props.scope !== 'position'
  const coverageLine =
    props.coverageLine ?? (showCoverage ? coverageLineFor(props.value) : undefined)

  return (
    <div
      className={`cell${hero ? ' cell-hero' : ''}`}
      data-cell-metric={props.metric}
      data-state={state}
      data-refreshing={state === 'refreshing' ? 'true' : undefined}
    >
      <StampGutter stamp={props.stamp} />
      <div className="cell-body">
        <div>
          <span className="lab">{props.label}</span>

          {state === 'loading' ? (
            // A skeleton at the exact height of the figure it replaces. Never a fake numeral: a
            // plausible digit shown while loading is a lie told in the moment it is most believed.
            <span
              className="skel"
              style={{ height: hero ? '44px' : '26px', marginTop: '3px' }}
              aria-hidden="true"
            />
          ) : (
            <Metric
              value={props.value}
              metric={props.metric}
              scope={props.scope}
              basis={props.basis}
              size={hero ? 'hero' : 'value'}
              tone={props.tone === true}
            />
          )}

          {state !== 'loading' &&
            props.sub?.map((row) => (
              <div className="rowline" key={row.label}>
                <span className={row.emphasis === true ? 'hero-sub' : 'sublab'}>{row.label}</span>
                <Metric
                  value={row.value}
                  metric={row.metric}
                  scope={props.scope}
                  basis={props.basis}
                  size="cell"
                  tone={row.tone === true}
                  className={row.emphasis === true ? 'val-sm' : undefined}
                />
              </div>
            ))}

          {state === 'ready' && props.meter !== undefined && (
            <CoverageMeter pct={props.meter.pct} of={props.meter.of} />
          )}

          {state === 'ready' && props.split !== undefined && (
            <SplitBar
              aPct={props.split.aPct}
              bPct={props.split.bPct}
              aLabel={props.split.aLabel}
              bLabel={props.split.bLabel}
            />
          )}
        </div>

        <div>
          {props.foot !== undefined && props.foot.length > 0 && (
            <div className="cell-foot">
              {props.foot.map((row) => (
                <div className="rowline" key={row.label}>
                  <span className="sublab">{row.label}</span>
                  <span className={row.muted === true ? 'muted' : undefined}>{row.value}</span>
                </div>
              ))}
            </div>
          )}
          {coverageLine !== undefined && (
            <div className="cell-note" data-coverage-line="true">
              {coverageLine}
            </div>
          )}
          {props.note !== undefined && <div className="cell-note">{props.note}</div>}
        </div>
      </div>
    </div>
  )
}

export interface ReadoutGridProps {
  readonly children?: ReactNode
  /** The D1 panel-level statement: 'Derived from 6 accounts · nothing observed directly'. */
  readonly title?: string
  readonly statement?: string
  readonly state?: ReadoutState
  readonly errorMessage?: string
}

export function ReadoutGrid(props: ReadoutGridProps): ReactNode {
  const state = props.state ?? 'ready'
  return (
    <section
      className="readout-wrap"
      aria-label={props.title ?? 'Portfolio readout'}
      // Every cell in this grid is derived; the statement above covers them, which is what lets
      // six of the seven gutters stand empty without breaking H6.
      data-stamp-scope="derived"
      data-state={state}
    >
      <div className="readout-head">
        <span className="panel-title">{props.title ?? 'Portfolio readout'}</span>
        {props.statement !== undefined && <span className="panel-meta">{props.statement}</span>}
      </div>
      {state === 'error' ? (
        <p className="readout-error" role="alert">
          {props.errorMessage ?? 'The portfolio readout could not be computed.'}
        </p>
      ) : (
        <div className="readout">{props.children}</div>
      )}
    </section>
  )
}
