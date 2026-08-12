/**
 * `CalibrationBar` — the signature component (spec §8.1).
 *
 * The full-width bar on a *real rupee scale* showing what fraction of net worth the
 * history-dependent metrics can actually measure. It is a requirement, not decoration: it is the
 * single place the product states, at a glance and to the rupee, what it does not know.
 *
 * Composition is fixed by the approved mockup. Ledger-backed classes are laid out first in
 * descending value, then snapshot classes in descending value, so the coverage boundary is a
 * single line rather than an interleaving. Snapshot segments carry the 45° hatch. Over the
 * boundary sits a 2px rule with a caret and two flanking annotations; beneath the excluded region,
 * a bracket names the amount the deeper metrics exclude — to the rupee, never as "some".
 *
 * There is no zero state. 0% coverage is a legitimate `ready` state: a fully hatched bar with the
 * caret at the origin, which is the harshest honest picture this component can draw.
 */

import type { ReactNode } from 'react'
import type { Minor } from '@domain/numeric'
import { ZERO_MINOR, addMinor, compareMinor, isZeroMinor, minor } from '@domain/numeric'
import type { Dec } from '@domain/numeric'
import type { AssetClass } from '@valuation/types'
import { abbreviateMinor, formatMoney, formatPct, money } from '../format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '../metrics'
import { HatchPattern } from './HatchPattern'
import { chooseTickSteps, px, roundUpScaleMax, roundedRightRect, scaleLinear, ticks } from './scale'
import './charts.css'

const VIEW_W = 1360
const VIEW_H = 156
const X0 = 44
const X1 = 1324
const BAR_Y = 46
const BAR_H = 46
const AXIS_Y = 102
const CAP_RADIUS = 4
/** Below this width a segment's label sits outside, above the bar, as GOLD 4.97% does. */
const INSIDE_LABEL_MIN_WIDTH = 90

export interface CalibrationSegment {
  readonly assetClass: AssetClass
  readonly value: Minor
  /** Share of net worth as a percentage: '26.58' means 26.58%. Labelled inside the segment. */
  readonly share: Dec
  readonly basis: 'ledger' | 'snapshot'
}

export type CalibrationState = 'ready' | 'loading' | 'empty' | 'error'

export interface CalibrationBarProps {
  readonly segments: readonly CalibrationSegment[]
  readonly netWorth: Minor
  readonly ledgerBacked: Minor
  readonly snapshotOnly: Minor
  readonly ledgerPct: Dec
  readonly snapshotPct: Dec
  readonly accountsLedger: number
  readonly accountsTotal: number
  /** Defaults to `netWorth` rounded up to a clean ₹5L / ₹50L / ₹5Cr step. */
  readonly scaleMax?: Minor
  readonly state?: CalibrationState
  readonly errorMessage?: string
}

const DESCRIPTION = 'What fraction of net worth the deeper metrics can actually measure'

function spoken(pct: Dec): string {
  return `${formatPct(pct, { decimals: 1 }).replace('%', '')} percent`
}

/**
 * A monospace advance at 10px with .12em tracking. Used only to keep the three annotations on the
 * label row from overlapping each other at the extremes — a 0% or 100% bar puts the boundary hard
 * against an edge, where the mockup's fixed offsets would clip one label and overprint another.
 */
const LABEL_CHAR_W = 7.2
const LABEL_GAP = 14

function textWidth(label: string): number {
  return label.length * LABEL_CHAR_W
}

interface LabelRow {
  readonly ledgerEnd: number
  readonly snapshotStart: number
}

function layoutLabels(
  boundaryX: number,
  ledgerLabel: string,
  snapshotLabel: string,
  totalLabel: string,
): LabelRow {
  const ledgerW = textWidth(ledgerLabel)
  const snapshotW = textWidth(snapshotLabel)
  const rightBound = X1 - textWidth(totalLabel) - 16

  let ledgerEnd = boundaryX - 10
  let snapshotStart = boundaryX + 10

  if (ledgerEnd - ledgerW < X0) {
    ledgerEnd = X0 + ledgerW
    snapshotStart = Math.max(snapshotStart, ledgerEnd + LABEL_GAP)
  }
  if (snapshotStart + snapshotW > rightBound) {
    snapshotStart = rightBound - snapshotW
    ledgerEnd = Math.min(ledgerEnd, snapshotStart - LABEL_GAP)
    if (ledgerEnd - ledgerW < X0) ledgerEnd = X0 + ledgerW
  }
  return { ledgerEnd: px(ledgerEnd), snapshotStart: px(snapshotStart) }
}

/** Ledger first by descending value, then snapshot by descending value. */
function order(segments: readonly CalibrationSegment[]): readonly CalibrationSegment[] {
  const byValueDesc = (a: CalibrationSegment, b: CalibrationSegment): number =>
    -compareMinor(a.value, b.value)
  return [
    ...segments.filter((s) => s.basis === 'ledger').sort(byValueDesc),
    ...segments.filter((s) => s.basis === 'snapshot').sort(byValueDesc),
  ]
}

export function CalibrationBar(props: CalibrationBarProps): ReactNode {
  const state = props.state ?? 'ready'
  const segments = order(props.segments)
  const scaleMax = props.scaleMax ?? roundUpScaleMax(props.netWorth)
  const x = scaleLinear([ZERO_MINOR, scaleMax], [X0, X1])
  const steps = chooseTickSteps(scaleMax)
  const axisTicks = ticks(scaleMax, steps)

  const ledgerLabel = `${formatPct(props.ledgerPct, { decimals: 1 })} LEDGER-BACKED · ${formatMoney(money(props.ledgerBacked))}`
  const snapshotLabel = `${formatPct(props.snapshotPct, { decimals: 1 })} SNAPSHOT ONLY · ${formatMoney(money(props.snapshotOnly))}`

  const label =
    state === 'ready'
      ? `Calibration bar: ${spoken(props.ledgerPct)} of net worth is backed by full transaction history; ${spoken(props.snapshotPct)} is a holdings snapshot with no transaction history.`
      : 'Calibration bar: nothing measured yet.'

  const boundaryX = px(x(props.ledgerBacked))
  const totalX = px(x(props.netWorth))
  const totalLabel = `NET WORTH ${formatMoney(money(props.netWorth))}`
  const labelRow = layoutLabels(boundaryX, ledgerLabel, snapshotLabel, totalLabel)

  return (
    <section
      className="calib"
      aria-label="Calibration — history coverage"
      data-state={state}
      data-metric="coverage"
      data-scope="portfolio"
      data-basis="mixed"
      data-coverage-pct={state === 'ready' ? formatPct(props.ledgerPct, { decimals: 1 }).replace('%', '') : undefined}
      data-coverage-minor={state === 'ready' ? props.ledgerBacked : undefined}
    >
      <div className="calib-head">
        <div>
          <div className="calib-name">Calibration — history coverage</div>
          <div className="calib-desc">{DESCRIPTION}</div>
        </div>
        <div className="calib-readout">
          {state === 'ready' ? (
            <>
              Ledger-backed <b>{formatPct(props.ledgerPct, { decimals: 1 })}</b> &nbsp;·&nbsp;{' '}
              {formatMoney(money(props.ledgerBacked))} of {formatMoney(money(props.netWorth))}{' '}
              &nbsp;·&nbsp; {props.accountsLedger} of {props.accountsTotal} accounts
            </>
          ) : state === 'loading' ? (
            <span className="skel" style={{ width: '240px', height: '18px' }} aria-hidden="true" />
          ) : (
            'Nothing measured yet'
          )}
        </div>
      </div>

      <div className="calib-body">
        <svg
          className={`cal${state === 'empty' || state === 'error' ? ' ruler-empty' : ''}`}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label={label}
        >
          <HatchPattern />

          {state === 'ready' && (
            <Segments segments={segments} netWorth={props.netWorth} x={x} />
          )}

          {state === 'loading' && (
            <rect className="f-skel" x={X0} y={BAR_Y} width={X1 - X0} height={BAR_H} />
          )}

          <Ruler ticks={axisTicks} x={x} />

          {state === 'ready' && (
            <>
              <line className="boundary" x1={boundaryX} y1={24} x2={boundaryX} y2={98} />
              <path
                className="boundary-caret"
                d={`M${px(boundaryX - 5)} 24 L${px(boundaryX + 5)} 24 L${boundaryX} 32 Z`}
              />
              <text className="cal-lab-l" x={labelRow.ledgerEnd} y={19} textAnchor="end">
                {ledgerLabel}
              </text>
              <text className="cal-lab-r" x={labelRow.snapshotStart} y={19}>
                {snapshotLabel}
              </text>
              <line className="total-mark" x1={totalX} y1={94} x2={totalX} y2={108} />
              <text className="total-lab" x={X1} y={19} textAnchor="end">
                {totalLabel}
              </text>
              {!isZeroMinor(props.snapshotOnly) && (
                <>
                  <path
                    className="bracket"
                    d={`M${px(boundaryX + 2)} 126 L${px(boundaryX + 2)} 132 L${totalX} 132 L${totalX} 126`}
                  />
                  <text
                    className="bracket-lab"
                    x={px((boundaryX + totalX) / 2)}
                    y={146}
                    textAnchor="middle"
                  >
                    NO HISTORY — XIRR, COST BASIS &amp; REALISED P&amp;L EXCLUDE{' '}
                    {formatMoney(money(props.snapshotOnly))}
                  </text>
                </>
              )}
            </>
          )}
        </svg>
      </div>

      {state === 'error' && (
        <p className="calib-error" role="alert">
          {props.errorMessage ?? 'Coverage could not be computed. Net worth is withheld until it can be.'}
        </p>
      )}

      {state === 'ready' && <CalibrationLegend segments={segments} />}
    </section>
  )
}

function Ruler({
  ticks: axisTicks,
  x,
}: {
  readonly ticks: readonly { readonly value: Minor; readonly major: boolean }[]
  readonly x: (value: Minor) => number
}): ReactNode {
  return (
    <>
      <line className="rule-axis" x1={X0} y1={AXIS_Y} x2={X1} y2={AXIS_Y} />
      {axisTicks.map((tick) => {
        const tx = px(x(tick.value))
        return (
          <g key={tick.value}>
            <line
              className={tick.major ? 'tick-maj' : 'tick-min'}
              x1={tx}
              y1={AXIS_Y}
              x2={tx}
              y2={tick.major ? AXIS_Y + 9 : AXIS_Y + 4}
            />
            {tick.major && (
              <text className="tick-lab" x={tx} y={124} textAnchor="middle">
                {abbreviateMinor(tick.value)}
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

function Segments({
  segments,
  netWorth,
  x,
}: {
  readonly segments: readonly CalibrationSegment[]
  readonly netWorth: Minor
  readonly x: (value: Minor) => number
}): ReactNode {
  let cumulative: Minor = ZERO_MINOR
  const drawn: ReactNode[] = []

  segments.forEach((segment, index) => {
    const start = px(x(cumulative))
    cumulative = addMinor(cumulative, segment.value)
    const end = px(x(cumulative))
    const width = px(end - start)
    const isLast = index === segments.length - 1
    const series = SERIES_BY_ASSET_CLASS[segment.assetClass]
    const name = ASSET_CLASS_LABEL[segment.assetClass].toUpperCase()
    const share = formatPct(segment.share, { decimals: 2 })
    const d = isLast
      ? roundedRightRect(start, BAR_Y, width, BAR_H, CAP_RADIUS)
      : roundedRightRect(start, BAR_Y, width, BAR_H, 0)

    drawn.push(
      <path
        key={`${segment.assetClass}-fill`}
        className={`f-${series}`}
        data-basis={segment.basis}
        data-asset-class={segment.assetClass}
        data-value-minor={segment.value}
        d={d}
      />,
    )
    if (segment.basis === 'snapshot') {
      drawn.push(
        <path
          key={`${segment.assetClass}-hatch`}
          className="hatch"
          data-hatch="true"
          d={d}
          aria-hidden="true"
        />,
      )
    }

    if (width >= INSIDE_LABEL_MIN_WIDTH) {
      drawn.push(
        <text
          key={`${segment.assetClass}-name`}
          className={`seg-name on-${series}`}
          x={px(start + 8)}
          y={65}
        >
          {name}
        </text>,
        <text
          key={`${segment.assetClass}-pct`}
          className={`seg-pct on-${series}`}
          x={px(start + 8)}
          y={82}
        >
          {share}
        </text>,
      )
    } else {
      // A segment too narrow to hold its label is labelled above the bar instead — kept inside the
      // plot, because a terminal segment sits hard against the right edge.
      const outside = `${name} ${share}`
      const half = textWidth(outside) / 2
      const centre = Math.min(Math.max((start + end) / 2, X0 + half), X1 - half)
      drawn.push(
        <text
          key={`${segment.assetClass}-out`}
          className="seg-name-out"
          x={px(centre)}
          y={38}
          textAnchor="middle"
        >
          {outside}
        </text>,
      )
    }
  })

  // A bar whose segments do not sum to the stated net worth is a bar lying about its own scale.
  // The discrepancy is exposed rather than absorbed: the assertion suite fails on it.
  return (
    <g
      data-segments-total-minor={cumulative}
      data-reconciles={compareMinor(cumulative, netWorth) === 0 ? 'true' : 'false'}
    >
      {drawn}
    </g>
  )
}

function CalibrationLegend({
  segments,
}: {
  readonly segments: readonly CalibrationSegment[]
}): ReactNode {
  return (
    <div className="legend">
      {segments.map((segment) => (
        <span className="lg" key={segment.assetClass}>
          <span
            className={`sw sw-${SERIES_BY_ASSET_CLASS[segment.assetClass]}${
              segment.basis === 'snapshot' ? ' sw-h' : ''
            }`}
          />
          {ASSET_CLASS_LABEL[segment.assetClass]} — {segment.basis}
        </span>
      ))}
      <span className="lg muted" style={{ marginLeft: 'auto' }}>
        Hatched fill = holdings snapshot only, no transaction history
      </span>
    </div>
  )
}

/** Exported for fixtures and tests: a zero-length bar still needs a legal scale. */
export const EMPTY_SCALE_MAX: Minor = minor('50000000')
