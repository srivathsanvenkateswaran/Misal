/**
 * `NetWorthStackChart` — twelve month-end stacked columns (spec §8.9).
 *
 * Ledger classes stack at the bottom and snapshot classes on top, so the coverage line reads
 * *within* each column as well as across the calibration bar. Snapshot segments carry the hatch.
 *
 * H10 governs the interesting case. A month before an account's earliest known position is drawn
 * as an explicit gap with an annotation naming the date history begins — never a flat line carried
 * backwards. Back-filling would be the easiest plausible-looking lie available to this component,
 * and it is the one this component is written to make impossible: a month with no data has no
 * `segments`, so there is nothing to draw and no value to invent.
 *
 * A month can also be *partly* known, and that is the quieter failure: holdings existed and were
 * folded, but no price was stored for some of them that month, so the column is a sum over a subset
 * of the portfolio drawn at the full height of a complete one. `unpricedCount` carries that fact
 * from the view-model, and a column carrying it is never drawn as an ordinary column: it gets an
 * open dashed cap, its total is stated as a floor ("at least ₹…") rather than as a total, and the
 * chart annotates what the mark means. The step between an incomplete month and the month pricing
 * began is an artefact of the price table, not a movement in net worth, and nothing here may let it
 * read as one.
 */

import type { ReactNode } from 'react'
import type { Minor } from '@domain/numeric'
import { ZERO_MINOR, addMinor, minor } from '@domain/numeric'
import type { AssetClass } from '@valuation/types'
import { abbreviateMinor, formatMoney, money } from '../format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '../metrics'
import { HatchPattern } from './HatchPattern'
import { px, roundUpScaleMax, roundedTopRect, scaleLinear } from './scale'
import './charts.css'

const VIEW_W = 700
const VIEW_H = 268
const PLOT_LEFT = 54
const PLOT_RIGHT = 690
const BASE_Y = 214
const TOP_Y = 18
const COLUMN_W = 22
const CAP_RADIUS = 4
/** The hairline that separates one class from the next inside a column. */
const SEGMENT_GAP = 2

export interface StackSegment {
  readonly assetClass: AssetClass
  readonly value: Minor
  readonly basis: 'ledger' | 'snapshot'
}

export interface StackMonth {
  readonly key: string
  /** 'AUG' */
  readonly label: string
  /** '26' */
  readonly year: string
  /**
   * `null` where the month predates every account's known history. Rendered as a gap, never as a
   * value carried backwards (H10).
   */
  readonly segments: readonly StackSegment[] | null
  /**
   * How many instruments the month's own stored rows could not price — `coverage.breakdown
   * .unpricedCount` at that month end.
   *
   * Greater than zero means the holdings existed and the value did not: the column below is a sum
   * over part of the portfolio. Optional so a caller with nothing to say leaves it out, but a
   * caller that *has* the number must pass it: a partially priced month drawn as an ordinary one
   * states a rupee figure for a portfolio it did not measure.
   */
  readonly unpricedCount?: number
}

/** Whether this month's column omits holdings it knows about. */
export function isIncomplete(month: StackMonth): boolean {
  return month.segments !== null && (month.unpricedCount ?? 0) > 0
}

export type ChartState = 'ready' | 'loading' | 'empty' | 'error'

export interface NetWorthStackChartProps {
  readonly months: readonly StackMonth[]
  readonly scaleMax?: Minor
  /** Named in the gap annotation: 'MAR 2026'. Required when any month has no history. */
  readonly historyBegins?: string
  readonly state?: ChartState
  readonly errorMessage?: string
}

const CLASS_ORDER: readonly AssetClass[] = [
  'indian_equity',
  'mutual_fund',
  'crypto',
  'bond',
  'cash',
  'us_equity',
  'gold',
]

function stackOrder(segments: readonly StackSegment[]): readonly StackSegment[] {
  const rank = (segment: StackSegment): number => {
    const base = segment.basis === 'ledger' ? 0 : 100
    return base + CLASS_ORDER.indexOf(segment.assetClass)
  }
  return [...segments].sort((a, b) => rank(a) - rank(b))
}

function monthTotal(segments: readonly StackSegment[]): Minor {
  return segments.length === 0 ? ZERO_MINOR : addMinor(...segments.map((s) => s.value))
}

/** '1 instrument' / '3 instruments'. The count is the whole disclosure, so it is never rounded. */
function unpricedPhrase(count: number): string {
  return `${count.toString()} ${count === 1 ? 'instrument' : 'instruments'} held that month had no stored price`
}

export function NetWorthStackChart(props: NetWorthStackChartProps): ReactNode {
  const state = props.state ?? 'ready'
  const months = props.months
  const measured = months.filter((m) => m.segments !== null)

  const largest = measured.reduce<Minor>(
    (acc, m) => (BigInt(monthTotal(m.segments ?? [])) > BigInt(acc) ? monthTotal(m.segments ?? []) : acc),
    ZERO_MINOR,
  )
  const scaleMax = props.scaleMax ?? roundUpScaleMax(largest)
  const y = scaleLinear([ZERO_MINOR, scaleMax], [BASE_Y, TOP_Y])
  const pitch = months.length === 0 ? 0 : (PLOT_RIGHT - PLOT_LEFT) / months.length

  if (state === 'empty') {
    return (
      <p className="chart-empty" data-state="empty">
        History begins after your first import — there is no month-end to plot yet.
      </p>
    )
  }
  if (state === 'error') {
    return (
      <p className="chart-empty" role="alert" data-state="error">
        {props.errorMessage ?? 'The monthly series could not be computed.'}
      </p>
    )
  }

  const gridValues: Minor[] = []
  const gridStep = BigInt(scaleMax) / 5n
  for (let i = 0n; i <= 5n; i += 1n) gridValues.push(minor(gridStep * i))

  const lastMeasured = measured[measured.length - 1]
  const firstMeasuredIndex = months.findIndex((m) => m.segments !== null)
  const incompleteCount = months.filter(isIncomplete).length

  return (
    <>
      <svg
        className="nwchart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Net worth by asset class, month end, ${months[0]?.label ?? ''} ${months[0]?.year ?? ''} to ${lastMeasured?.label ?? ''} ${lastMeasured?.year ?? ''}.${
          incompleteCount === 0
            ? ''
            : ` ${incompleteCount.toString()} ${incompleteCount === 1 ? 'month is' : 'months are'} marked incomplete: holdings with no stored price for that month are not in those columns, so their height is a floor rather than a total.`
        } The values are listed in the table beside this chart.`}
        data-state={state}
      >
        <HatchPattern />

        {gridValues.map((value) => {
          const gy = px(y(value))
          return (
            <g key={value}>
              <line className="grid" x1={PLOT_LEFT} y1={gy} x2={PLOT_RIGHT} y2={gy} />
              <text className="ax" x={PLOT_LEFT - 8} y={px(gy + 3.5)} textAnchor="end">
                {abbreviateMinor(value)}
              </text>
            </g>
          )
        })}
        <line className="axis" x1={PLOT_LEFT} y1={BASE_Y} x2={PLOT_RIGHT} y2={BASE_Y} />

        {months.map((month, index) => {
          const centre = PLOT_LEFT + pitch * (index + 0.5)
          const left = px(centre - COLUMN_W / 2)

          if (state === 'loading') {
            return (
              <rect
                key={month.key}
                className="f-skel"
                x={left}
                y={BASE_Y - 40}
                width={COLUMN_W}
                height={40}
              />
            )
          }

          if (month.segments === null) {
            // H10: an explicit gap. Nothing is drawn where nothing is known.
            return (
              <g key={month.key} data-gap="true">
                <line
                  className="gap-mark"
                  x1={left}
                  y1={BASE_Y - 6}
                  x2={px(left + COLUMN_W)}
                  y2={BASE_Y - 6}
                />
              </g>
            )
          }

          const ordered = stackOrder(month.segments)
          let cumulative: Minor = ZERO_MINOR
          const total = monthTotal(month.segments)
          const partial = isIncomplete(month)
          const capY = px(y(total) - 3)

          return (
            <g
              key={month.key}
              data-month={month.key}
              data-total-minor={total}
              {...(partial
                ? {
                    'data-incomplete': 'true',
                    'data-unpriced-count': (month.unpricedCount ?? 0).toString(),
                  }
                : {})}
            >
              {ordered.map((segment, segmentIndex) => {
                const bottom = px(y(cumulative) - (segmentIndex === 0 ? 0 : SEGMENT_GAP))
                cumulative = addMinor(cumulative, segment.value)
                const top = px(y(cumulative))
                const height = px(bottom - top)
                const isTop = segmentIndex === ordered.length - 1
                const d = roundedTopRect(left, top, COLUMN_W, height, isTop ? CAP_RADIUS : 0)
                const series = SERIES_BY_ASSET_CLASS[segment.assetClass]
                return (
                  <g key={segment.assetClass}>
                    <path
                      className={`f-${series}`}
                      data-basis={segment.basis}
                      data-asset-class={segment.assetClass}
                      d={d}
                    />
                    {segment.basis === 'snapshot' && (
                      <path className="hatch" data-hatch="true" d={d} aria-hidden="true" />
                    )}
                  </g>
                )
              })}
              {partial && (
                /*
                 * An open dashed cap, drawn *above* the stack rather than over it: the column ends
                 * where the priced value ends and the top is left open, because how much more was
                 * held that month is exactly what these rows do not say. Drawn with `.gap-mark`,
                 * the same ink the missing-month rule uses — one visual language for "not known".
                 *
                 * Deliberately not the 45° hatch: that mark means "no transaction history" and
                 * nothing else, product-wide, and H5 counts hatch overlays against snapshot
                 * geometry inside each `<svg>`.
                 */
                <path
                  className="gap-mark"
                  fill="none"
                  data-incomplete-cap="true"
                  aria-hidden="true"
                  d={`M ${left} ${capY} L ${left} ${px(capY - 9)} L ${px(left + COLUMN_W)} ${px(capY - 9)} L ${px(left + COLUMN_W)} ${capY}`}
                />
              )}
              {month === lastMeasured && (
                <text
                  className="dlab"
                  x={px(centre)}
                  y={px(y(total) - (partial ? 20 : 10))}
                  textAnchor="middle"
                >
                  {partial ? `≥ ${abbreviateMinor(total)}` : abbreviateMinor(total)}
                </text>
              )}
            </g>
          )
        })}

        {months.map((month, index) => {
          const centre = px(PLOT_LEFT + pitch * (index + 0.5))
          return (
            <g key={`ax-${month.key}`}>
              <text className="ax" x={centre} y={230} textAnchor="middle">
                {month.label}
              </text>
              <text className="ax-dim" x={centre} y={241} textAnchor="middle">
                {month.year}
              </text>
            </g>
          )
        })}

        {incompleteCount > 0 && (
          <text className="gap-lab" data-incomplete-note="true" x={PLOT_LEFT} y={12}>
            ⌐ OPEN CAP = MONTH PRICED IN PART — HOLDINGS WITH NO STORED PRICE ARE NOT DRAWN
          </text>
        )}

        {props.historyBegins !== undefined && firstMeasuredIndex > 0 && (
          <text
            className="gap-lab"
            x={px(PLOT_LEFT + pitch * firstMeasuredIndex + 4)}
            y={BASE_Y - 14}
          >
            HISTORY BEGINS {props.historyBegins} — EARLIER MONTHS ARE NOT DRAWN
          </text>
        )}
      </svg>

      {/* Charts with more than six data points also render their values, because an aria-label
          cannot carry twelve months of five asset classes. */}
      <table className="vh">
        <caption>Net worth by asset class, month end</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Total</th>
            <th scope="col">Composition</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => {
            const partial = isIncomplete(month)
            const composition =
              month.segments === null
                ? ''
                : month.segments
                    .map(
                      (segment) =>
                        `${ASSET_CLASS_LABEL[segment.assetClass]} ${formatMoney(money(segment.value))}${
                          segment.basis === 'snapshot' ? ' (snapshot only)' : ''
                        }`,
                    )
                    .join('; ')
            return (
              <tr key={`row-${month.key}`} {...(partial ? { 'data-incomplete': 'true' } : {})}>
                <th scope="row">
                  {month.label} {month.year}
                </th>
                {/* A floor is stated as a floor. `formatMoney` alone here would print an exact
                    rupee figure for a month whose portfolio was only partly priced. */}
                <td>
                  {month.segments === null
                    ? 'No history — not drawn'
                    : partial
                      ? `At least ${formatMoney(money(monthTotal(month.segments)))} — incomplete`
                      : formatMoney(money(monthTotal(month.segments)))}
                </td>
                <td>
                  {partial
                    ? `${composition}; ${unpricedPhrase(month.unpricedCount ?? 0)}, so this month is a floor and not a total`
                    : composition}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
