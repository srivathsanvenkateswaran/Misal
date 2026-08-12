/**
 * `ConcentrationChart` — position share of net worth (spec §8.9).
 *
 * Horizontal bars in the asset-class hue, hatched where the position is snapshot-only, with a
 * vertical threshold rule at the single-position flag. Every bar carries its name at the left and
 * its value after the bar end, so the chart reads with all colour removed — which is the test the
 * colour-independence rule sets, and the reason there is no tooltip to hide the value in.
 */

import type { ReactNode } from 'react'
import type { Dec } from '@domain/numeric'
import { ZERO_DEC, dec, maxDec } from '@domain/numeric'
import type { AssetClass } from '@valuation/types'
import { formatPct, roundDec } from '../format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '../metrics'
import { HatchPattern } from './HatchPattern'
import { px, roundedRightRect, scaleLinear } from './scale'
import './charts.css'

const VIEW_W = 560
const LABEL_RIGHT = 166
const PLOT_LEFT = 176
const PLOT_RIGHT = 430
const TOP_Y = 22
const ROW_PITCH = 21
const BAR_H = 13
const CAP_RADIUS = 4
const AXIS_STEP_PCT = 5

export interface ConcentrationRow {
  readonly key: string
  readonly label: string
  /** `null` for the aggregate "Other" bucket, which has no single asset class. */
  readonly assetClass: AssetClass | null
  /** Share of net worth as a percentage: '23.15' means 23.15%. */
  readonly share: Dec
  readonly basis: 'ledger' | 'snapshot'
}

export interface ConcentrationChartProps {
  readonly rows: readonly ConcentrationRow[]
  /** The single-position flag, '20' for 20%. Drawn as a rule with a caption beneath the plot. */
  readonly threshold?: Dec
  readonly thresholdCaption?: string
  readonly state?: 'ready' | 'loading' | 'empty' | 'error'
  readonly errorMessage?: string
}

/** Round a percentage up to the next whole `step`, so the axis ends on a labelled gridline. */
function ceilToStep(value: Dec, step: number): Dec {
  const { intDigits, fracDigits } = roundDec(value, 2)
  const hundredths = BigInt(intDigits + fracDigits)
  const stepHundredths = BigInt(step) * 100n
  const ceiled = ((hundredths + stepHundredths - 1n) / stepHundredths) * stepHundredths
  return dec((ceiled / 100n).toString())
}

export function ConcentrationChart(props: ConcentrationChartProps): ReactNode {
  const state = props.state ?? 'ready'
  const rows = props.rows

  if (state === 'empty' || (state === 'ready' && rows.length < 2)) {
    return (
      <p className="chart-empty" data-state="empty">
        Fewer than 2 positions — nothing to concentrate.
      </p>
    )
  }
  if (state === 'error') {
    return (
      <p className="chart-empty" role="alert" data-state="error">
        {props.errorMessage ?? 'Concentration could not be computed.'}
      </p>
    )
  }

  const largest = rows.reduce<Dec>((acc, row) => maxDec(acc, row.share), ZERO_DEC)
  const axisMax = ceilToStep(largest, AXIS_STEP_PCT)
  const x = scaleLinear([ZERO_DEC, axisMax], [PLOT_LEFT, PLOT_RIGHT])

  const plotBottom = TOP_Y + rows.length * ROW_PITCH + 4
  const hasThreshold = props.threshold !== undefined
  const viewH = plotBottom + (hasThreshold ? 28 : 8)

  // Ticks are stepped in whole percentage points as BigInt, so the axis never acquires a float.
  const axisTicks: Dec[] = []
  const axisMaxWhole = BigInt(axisMax)
  for (let value = 0n; value <= axisMaxWhole; value += BigInt(AXIS_STEP_PCT)) {
    axisTicks.push(dec(value.toString()))
  }

  return (
    <svg
      className="concchart"
      viewBox={`0 0 ${VIEW_W} ${viewH}`}
      role="img"
      aria-label={`Top holdings by share of net worth. The largest is ${rows[0]?.label ?? ''} at ${formatPct(rows[0]?.share ?? ZERO_DEC)}. Every bar is labelled with its value.`}
      data-state={state}
    >
      <HatchPattern />

      {axisTicks.map((tick) => {
        const tx = px(x(tick))
        return (
          <g key={tick}>
            <line className="grid" x1={tx} y1={TOP_Y} x2={tx} y2={plotBottom} />
            <text className="ax" x={tx} y={TOP_Y - 6} textAnchor="middle">
              {formatPct(tick, { decimals: 0 })}
            </text>
          </g>
        )
      })}

      {rows.map((row, index) => {
        const top = TOP_Y + 10 + index * ROW_PITCH
        const baseline = px(top + 10)
        const end = px(x(row.share))
        const width = px(end - PLOT_LEFT)
        const d = roundedRightRect(PLOT_LEFT, top, width, BAR_H, CAP_RADIUS)
        const series = row.assetClass === null ? 'other' : SERIES_BY_ASSET_CLASS[row.assetClass]
        return (
          <g key={row.key}>
            <text className="conc-lab" x={LABEL_RIGHT} y={baseline} textAnchor="end">
              {row.label}
            </text>
            <path
              className={`f-${series}`}
              data-basis={row.basis}
              data-asset-class={row.assetClass ?? 'other'}
              d={d}
            />
            {row.basis === 'snapshot' && (
              <path className="hatch" data-hatch="true" d={d} aria-hidden="true" />
            )}
            <text className="conc-val" x={px(end + 8)} y={baseline}>
              {formatPct(row.share)}
            </text>
            {row.assetClass !== null && (
              <title>{`${row.label} — ${ASSET_CLASS_LABEL[row.assetClass]}, ${formatPct(row.share)} of net worth${row.basis === 'snapshot' ? ', snapshot only' : ''}`}</title>
            )}
          </g>
        )
      })}

      {props.threshold !== undefined && (
        <>
          <line
            className="thresh"
            x1={px(x(props.threshold))}
            y1={TOP_Y}
            x2={px(x(props.threshold))}
            y2={plotBottom + 8}
          />
          <text className="thresh-lab" x={px(x(props.threshold) + 5)} y={plotBottom + 21}>
            {props.thresholdCaption ??
              `${formatPct(props.threshold, { decimals: 0 })} SINGLE-POSITION FLAG`}
          </text>
        </>
      )}
    </svg>
  )
}
