/**
 * `NavHistoryChart` — one instrument's stored price history, with a transaction rug (spec §8.9).
 *
 * A single 2px line in the instrument's asset-class hue, an end dot and an end label, gridlines on
 * a step chosen from the data, six-ish date ticks, and beneath the axis a rug marking every
 * transaction Misal holds: 1px `--ink-3` upward for purchases, 2px `--ink-1` downward for
 * disposals, with counted captions at each end.
 *
 * Four things this component refuses to do, each of which would be easy and would read as a
 * better chart:
 *
 *  1. **It does not interpolate.** The points are stored `price` rows, and a gap between them is a
 *     period Misal has no price for. Joining across one draws a value for every day in between
 *     that nobody ever observed. Runs separated by more than the series' own cadence are therefore
 *     drawn as separate paths with a dashed mark under the gap, and the gaps are counted in the
 *     table below the chart.
 *  2. **It does not draw a line through one or two points.** Two prices are two facts; the segment
 *     between them is a trend, and a trend is not something two observations can support. One or
 *     two points render as dots with a sentence saying why there is no line — the `sparse` state.
 *  3. **It does not stretch the line over transactions it cannot price.** The horizontal domain
 *     covers the transactions as well as the prices, so a holding whose ledger reaches back
 *     further than its stored prices shows the rug extending to the left of where the line starts,
 *     annotated with the month the price history begins.
 *  4. **It does not draw an empty rug for an instrument with no transaction history.** A snapshot
 *     holding has nothing to mark, and an empty strip reads as "no transactions" rather than "no
 *     record of any". `marks: null` says the latter, and is drawn as a hatched band — the same 45°
 *     hatch that means the same thing everywhere else in the product.
 *
 * The hatch pattern is defined inside this component's own `<svg>`. See `HatchPattern`: an SVG
 * `url(#…)` resolves against the whole document, so a chart borrowing another chart's `<defs>`
 * loses its hatch the moment that chart unmounts, and snapshot-only value then reads as
 * ledger-backed.
 *
 * Pixel geometry is the only place a decimal becomes a number, via `scale.ts`. Every label here —
 * the end label, the gridline labels, the table — is formatted from the original `Dec` string.
 */

import type { ReactNode } from 'react'
import { Fragment } from 'react'
import { DateTime } from 'luxon'
import type { CurrencyCode, Dec } from '@domain/numeric'
import { dec } from '@domain/numeric'
import { CURRENCY_SYMBOL, formatQty } from '../format'
import type { SeriesToken } from '../metrics'
import { HatchOverlay, HatchPattern } from './HatchPattern'
import { px, roundedRightRect, scaleLinear } from './scale'
import './charts.css'

const VIEW_W = 700
const VIEW_H = 244
const PLOT_LEFT = 52
const PLOT_RIGHT = 636
/** The price axis. Gridlines run from here up to `TOP_Y`. */
const BASE_Y = 184
const TOP_Y = 28
const DATE_LAB_Y = 200
/** The rug's own baseline, below the date labels. */
const RUG_Y = 214
const RUG_UP = 207
const RUG_DOWN = 221
const RUG_LAB_Y = 236
const END_DOT_R = 4
const POINT_DOT_R = 2.5
const MS_PER_DAY = 86_400_000
/** At most this many labelled date ticks, always including the first and the last. */
const MAX_DATE_TICKS = 6
/** Below this many stored prices there is no line — see the `sparse` state above. */
const MIN_POINTS_FOR_A_LINE = 3
/** No series is treated as having a cadence finer than this, so a weekend is not a gap. */
const MIN_GAP_DAYS = 5

export interface NavPoint {
  /** The date the price is for, ISO. Stored `price.as_of`. */
  readonly asOf: string
  /** The close, exactly as stored. Every label is rendered from this string. */
  readonly close: Dec
}

export type RugDirection = 'buy' | 'sell'

export interface RugMark {
  readonly key: string
  /** ISO date of the transaction. */
  readonly on: string
  readonly direction: RugDirection
  /** The transaction's own type word — 'Purchase', 'Redemption'. Used in the counted captions. */
  readonly label: string
}

export type NavHistoryState = 'ready' | 'loading' | 'empty' | 'error'

export interface NavHistoryChartProps {
  readonly points: readonly NavPoint[]
  /**
   * Every transaction Misal holds for this instrument, or `null` when the holding has no
   * transaction history at all. `[]` and `null` are different facts and are drawn differently.
   */
  readonly marks: readonly RugMark[] | null
  readonly instrumentName: string
  readonly currency?: CurrencyCode
  /** Digits in the end label: 4 for a NAV, 2 for a quote. Defaults to the stored digits. */
  readonly precision?: number
  readonly series?: SeriesToken
  /** Override the derived gap threshold, in days. */
  readonly gapDays?: number
  readonly state?: NavHistoryState
  readonly errorMessage?: string
}

// ---------------------------------------------------------------------------
// Exact decimal helpers.
//
// The price axis has to choose a step, floor a minimum and ceil a maximum, none of which the
// display formatters do. All three happen here in BigInt on the digits of the stored strings: the
// prices are scaled to a common number of decimal places, so a ₹5 step on a NAV and a ₹250 step on
// an equity quote are the same integer arithmetic.
// ---------------------------------------------------------------------------

function fractionDigits(value: string): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

/** `'69.7670'` at k=4 → `697670n`. */
function scaleToUnits(value: Dec, k: number): bigint {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const dot = abs.indexOf('.')
  const intPart = dot === -1 ? abs : abs.slice(0, dot)
  const fracPart = (dot === -1 ? '' : abs.slice(dot + 1)).slice(0, k).padEnd(k, '0')
  const scaled = BigInt(intPart + fracPart)
  return negative ? -scaled : scaled
}

/** The inverse: `697670n` at k=4 → `'69.7670'`. */
function unscale(units: bigint, k: number): Dec {
  const negative = units < 0n
  const abs = negative ? -units : units
  const digits = abs.toString().padStart(k + 1, '0')
  const intDigits = k === 0 ? digits : digits.slice(0, digits.length - k)
  const fracDigits = k === 0 ? '' : digits.slice(digits.length - k)
  return dec(`${negative ? '-' : ''}${intDigits}${fracDigits === '' ? '' : `.${fracDigits}`}`)
}

function floorToStep(value: bigint, step: bigint): bigint {
  const quotient = value / step
  const floored = value < 0n && quotient * step !== value ? quotient - 1n : quotient
  return floored * step
}

function ceilToStep(value: bigint, step: bigint): bigint {
  const quotient = value / step
  const ceiled = value > 0n && quotient * step !== value ? quotient + 1n : quotient
  return ceiled * step
}

/**
 * A 1 / 2 / 5 × 10ⁿ step that divides the span into at most five intervals.
 *
 * The mockup's ₹5 gridlines are what this produces for a NAV in the forties to seventies; the same
 * rule gives ₹250 for an equity quote in the thousands, rather than five hundred gridlines.
 */
function chooseStep(span: bigint): bigint {
  const MULTIPLIERS = [1n, 2n, 5n]
  let magnitude = 1n
  for (let power = 0; power < 40; power += 1) {
    for (const multiplier of MULTIPLIERS) {
      const step = multiplier * magnitude
      if (span / step <= 5n) return step
    }
    magnitude *= 10n
  }
  return magnitude
}

interface PriceAxis {
  readonly min: bigint
  readonly max: bigint
  readonly step: bigint
  readonly k: number
  readonly decimals: number
}

function priceAxis(points: readonly NavPoint[]): PriceAxis {
  const k = Math.min(8, Math.max(2, ...points.map((point) => fractionDigits(point.close))))
  const units = points.map((point) => scaleToUnits(point.close, k))
  let min = units.reduce((acc, value) => (value < acc ? value : acc), units[0] ?? 0n)
  let max = units.reduce((acc, value) => (value > acc ? value : acc), units[0] ?? 0n)

  if (min === max) {
    // One distinct price, or several identical ones. There is no span to scale, so the axis is
    // given a symmetric window around the value rather than a zero-height plot.
    const pad = max / 20n > 0n ? max / 20n : 1n
    min -= pad
    max += pad
  }

  const step = chooseStep(max - min)
  const axisMin = floorToStep(min, step)
  const axisMax = ceilToStep(max, step)

  // Trailing zeros on the step are places no gridline label needs: a ₹5.0000 step on four-decimal
  // NAVs labels '₹45', not '₹45.0000'.
  let decimals = k
  let remainder = step
  while (decimals > 0 && remainder % 10n === 0n) {
    remainder /= 10n
    decimals -= 1
  }

  return {
    min: axisMin,
    max: axisMax === axisMin ? axisMin + step : axisMax,
    step,
    k,
    decimals,
  }
}

// ---------------------------------------------------------------------------
// Dates. A day index is a count, not a measurement, so it is an ordinary number.
// ---------------------------------------------------------------------------

function dayIndexOf(iso: string): number | null {
  const dt = DateTime.fromISO(iso, { zone: 'utc' })
  return dt.isValid ? Math.round(dt.toMillis() / MS_PER_DAY) : null
}

function monthLabel(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).toFormat('LLL yy').toUpperCase()
}

function dayLabel(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).toFormat('dd LLL yyyy').toUpperCase()
}

/**
 * The cadence a series is treated as having: half again its median interval, never finer than five
 * days.
 *
 * A month-end series flags a missing month; a daily series does not flag a weekend or a holiday,
 * which are not gaps in Misal's knowledge but in the market's.
 *
 * **One and a half, not two.** A single missing observation in a regular series produces a delta of
 * exactly twice the cadence, which a threshold of `median * 2` and a strict `>` both reject: a
 * month-end series missing June has deltas of 28, 31, 30, 31, 61, 31, 30 — a median of 31, a
 * threshold of 62, and 61 > 62 is false. The line was drawn straight through the hole, `data-gaps` stayed 0, and
 * the accessible table lost the row saying nothing was stored — the interpolation this whole
 * component refuses to do, done silently. Relaxing the comparison to `>=` is not enough either,
 * because calendar months are 28 to 31 days long: a missing February gives 59 against a threshold
 * of 62 and is still missed. At `3/2` the threshold sits above the widest ordinary interval (31 →
 * 46, and no month exceeds 31) and below the narrowest doubled one (28 × 2 = 56), which is the
 * whole of the requirement. Weekly: 7 → 10, flagging 14 and passing 7.
 */
function gapThreshold(days: readonly number[], override: number | undefined): number {
  if (override !== undefined) return override
  const deltas: number[] = []
  for (let index = 1; index < days.length; index += 1) {
    deltas.push((days[index] ?? 0) - (days[index - 1] ?? 0))
  }
  if (deltas.length === 0) return MIN_GAP_DAYS
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  // Day counts, floored to stay an integer. Pixel geometry is elsewhere; nothing here is money.
  return Math.max(MIN_GAP_DAYS, Math.floor((median * 3) / 2))
}

interface Plotted {
  readonly point: NavPoint
  readonly day: number
  readonly x: number
  readonly y: number
}

interface Gap {
  readonly fromDate: string
  readonly toDate: string
  readonly fromX: number
  readonly toX: number
}

function pathOf(run: readonly Plotted[]): string {
  return run
    .map((plotted, index) => `${index === 0 ? 'M' : 'L'}${plotted.x} ${plotted.y}`)
    .join(' ')
}

/** `▲ 24 PURCHASES`, `▼ 1 REDEMPTION · 12 MAY 2026`. */
function rugCaption(
  marks: readonly RugMark[],
  direction: RugDirection,
  arrow: string,
): string | null {
  const own = marks.filter((mark) => mark.direction === direction)
  const first = own[0]
  if (first === undefined) return null
  const distinct = new Set(own.map((mark) => mark.label.toUpperCase()))
  const noun = distinct.size === 1 ? [...distinct][0] ?? 'TRANSACTION' : 'TRANSACTION'
  if (own.length === 1) {
    return `${arrow} 1 ${noun} · ${dayLabel(first.on)}`
  }
  return `${arrow} ${own.length.toString()} ${noun}S`
}

// ---------------------------------------------------------------------------

export function NavHistoryChart(props: NavHistoryChartProps): ReactNode {
  const state = props.state ?? 'ready'
  const currency = props.currency ?? 'INR'
  const series = props.series ?? 's2'
  const symbol = CURRENCY_SYMBOL[currency]
  const marks = props.marks ?? []

  if (state === 'error') {
    return (
      <p className="chart-empty" role="alert" data-state="error">
        {props.errorMessage ?? 'The price history could not be read.'}
      </p>
    )
  }

  if (state === 'empty' || (state === 'ready' && props.points.length === 0)) {
    return (
      <p className="chart-empty" data-state="empty">
        No price is stored for this instrument yet, so there is no history to draw. A new holding
        has none until prices are fetched or a statement carrying them is imported.
      </p>
    )
  }

  if (state === 'loading') {
    return (
      <svg
        className="navchart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Reading the stored prices for ${props.instrumentName}.`}
        data-state="loading"
      >
        <HatchPattern />
        <rect className="f-skel" x={PLOT_LEFT} y={TOP_Y} width={PLOT_RIGHT - PLOT_LEFT} height={BASE_Y - TOP_Y} />
        <line className="axis" x1={PLOT_LEFT} y1={BASE_Y} x2={PLOT_RIGHT} y2={BASE_Y} />
      </svg>
    )
  }

  // Every date is parsed before anything is drawn. A date this component cannot read is a defect
  // in the stored row, and it is named rather than plotted at coordinate NaN.
  const badDate =
    props.points.find((point) => dayIndexOf(point.asOf) === null)?.asOf ??
    marks.find((mark) => dayIndexOf(mark.on) === null)?.on
  if (badDate !== undefined) {
    return (
      <p className="chart-empty" role="alert" data-state="error">
        A stored row carries a date this chart cannot read ({badDate}), so no history is drawn
        rather than a history with a point in the wrong place.
      </p>
    )
  }

  const ordered = [...props.points].sort((a, b) => (a.asOf < b.asOf ? -1 : 1))
  const pointDays = ordered.map((point) => dayIndexOf(point.asOf) ?? 0)
  const markDays = marks.map((mark) => dayIndexOf(mark.on) ?? 0)
  const allDays = [...pointDays, ...markDays]
  const minDay = Math.min(...allDays)
  const maxDay = Math.max(...allDays)

  const axis = priceAxis(ordered)
  const y = scaleLinear([unscale(axis.min, axis.k), unscale(axis.max, axis.k)], [BASE_Y, TOP_Y])
  const xScale = scaleLinear([dec(minDay.toString()), dec(maxDay.toString())], [PLOT_LEFT, PLOT_RIGHT])
  // A single date has no span; the lone point belongs in the middle of the plot, not hard against
  // its left edge, which would read as the start of a series that continues off-frame.
  const xOf = (day: number): number =>
    minDay === maxDay ? px((PLOT_LEFT + PLOT_RIGHT) / 2) : px(xScale(dec(day.toString())))

  const plotted: Plotted[] = ordered.map((point, index) => ({
    point,
    day: pointDays[index] ?? 0,
    x: xOf(pointDays[index] ?? 0),
    y: px(y(point.close)),
  }))

  const threshold = gapThreshold(pointDays, props.gapDays)
  const runs: Plotted[][] = []
  const gaps: Gap[] = []
  for (const item of plotted) {
    const current = runs[runs.length - 1]
    const previous = current?.[current.length - 1]
    if (current === undefined || previous === undefined) {
      runs.push([item])
      continue
    }
    if (item.day - previous.day > threshold) {
      gaps.push({
        fromDate: previous.point.asOf,
        toDate: item.point.asOf,
        fromX: previous.x,
        toX: item.x,
      })
      runs.push([item])
    } else {
      current.push(item)
    }
  }

  const sparse = plotted.length < MIN_POINTS_FOR_A_LINE
  const last = plotted[plotted.length - 1]
  const first = plotted[0]
  const endLabel =
    last === undefined
      ? ''
      : `${symbol}${formatQty(last.point.close, props.precision === undefined ? {} : { precision: props.precision })}`

  const gridValues: bigint[] = []
  for (let value = axis.min; value <= axis.max; value += axis.step) gridValues.push(value)

  const dateTicks = chooseDateTicks(plotted)
  const buyCaption = rugCaption(marks, 'buy', '▲')
  const sellCaption = rugCaption(marks, 'sell', '▼')
  const firstMarkDay = markDays.length === 0 ? null : Math.min(...markDays)
  const historyBegins =
    first !== undefined && firstMarkDay !== null && firstMarkDay < first.day
      ? monthLabel(first.point.asOf)
      : null

  const label =
    first === undefined || last === undefined
      ? `Price history of ${props.instrumentName}.`
      : `Price history of ${props.instrumentName}: ${plotted.length.toString()} stored prices from ${dayLabel(first.point.asOf)} to ${dayLabel(last.point.asOf)}, ${symbol}${formatQty(first.point.close)} to ${symbol}${formatQty(last.point.close)}${
          gaps.length === 0
            ? ''
            : `, with ${gaps.length.toString()} period${gaps.length === 1 ? '' : 's'} no price is stored for`
        }. Every stored price is listed in the table below this chart.`

  return (
    <>
      <svg
        className="navchart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={label}
        data-state={sparse ? 'sparse' : 'ready'}
        data-points={plotted.length}
        data-gaps={gaps.length}
      >
        <HatchPattern />

        {gridValues.map((value) => {
          const gy = px(y(unscale(value, axis.k)))
          return (
            <g key={value.toString()}>
              <line className="grid" x1={PLOT_LEFT} y1={gy} x2={PLOT_RIGHT} y2={gy} />
              <text className="ax" x={PLOT_LEFT - 8} y={px(gy + 3.5)} textAnchor="end">
                {symbol}
                {formatQty(unscale(value, axis.k), { precision: axis.decimals })}
              </text>
            </g>
          )
        })}
        <line className="axis" x1={PLOT_LEFT} y1={BASE_Y} x2={PLOT_RIGHT} y2={BASE_Y} />

        {/* The line, in runs. Nothing is drawn across a gap and nothing is drawn at all when two
            points would have to carry a trend between them. */}
        {!sparse &&
          runs.map((run) =>
            run.length < 2 ? (
              <circle
                key={`run-${run[0]?.point.asOf ?? ''}`}
                className={`dot-${series}`}
                cx={run[0]?.x ?? 0}
                cy={run[0]?.y ?? 0}
                r={POINT_DOT_R}
              />
            ) : (
              <path key={`run-${run[0]?.point.asOf ?? ''}`} className={`line-${series}`} d={pathOf(run)} />
            ),
          )}

        {sparse &&
          plotted.map((item) => (
            <circle
              key={`pt-${item.point.asOf}`}
              className={`dot-${series}`}
              cx={item.x}
              cy={item.y}
              r={POINT_DOT_R}
            />
          ))}

        {gaps.map((gap) => (
          <g key={`gap-${gap.fromDate}`} data-gap="true">
            <line className="gap-mark" x1={gap.fromX} y1={BASE_Y - 5} x2={gap.toX} y2={BASE_Y - 5} />
          </g>
        ))}

        {last !== undefined && !sparse && (
          <>
            <circle className={`dot-${series}`} cx={last.x} cy={last.y} r={END_DOT_R} />
            <text className="dlab" x={px(PLOT_RIGHT + 12)} y={px(last.y + 4)}>
              {endLabel}
            </text>
          </>
        )}

        {dateTicks.map((tick) => (
          <g key={`tick-${tick.item.point.asOf}`}>
            <line className="tick-min" x1={tick.item.x} y1={BASE_Y} x2={tick.item.x} y2={BASE_Y + 4} />
            <text className="ax" x={tick.item.x} y={DATE_LAB_Y} textAnchor={tick.anchor}>
              {monthLabel(tick.item.point.asOf)}
            </text>
          </g>
        ))}

        {historyBegins !== null && first !== undefined && (
          <text className="gap-lab" x={px(first.x + 4)} y={BASE_Y - 14}>
            PRICE HISTORY BEGINS {historyBegins} — EARLIER TRANSACTIONS ARE MARKED, NOT PRICED
          </text>
        )}

        {/* The rug. */}
        <line className="rule-axis" x1={PLOT_LEFT} y1={RUG_Y} x2={PLOT_RIGHT} y2={RUG_Y} />

        {props.marks === null ? (
          <NoHistoryRug />
        ) : (
          <>
            {marks.map((mark, index) => {
              const mx = xOf(markDays[index] ?? 0)
              return (
                <line
                  key={mark.key}
                  className={mark.direction === 'buy' ? 'rug-buy' : 'rug-sell'}
                  data-rug={mark.direction}
                  x1={mx}
                  y1={RUG_Y}
                  x2={mx}
                  y2={mark.direction === 'buy' ? RUG_UP : RUG_DOWN}
                />
              )
            })}
            {buyCaption !== null && (
              <text className="rug-lab" x={PLOT_LEFT} y={RUG_LAB_Y}>
                {buyCaption}
              </text>
            )}
            {sellCaption !== null && (
              <text className="rug-lab2" x={PLOT_RIGHT} y={RUG_LAB_Y} textAnchor="end">
                {sellCaption}
              </text>
            )}
            {marks.length === 0 && (
              <text className="rug-lab" x={PLOT_LEFT} y={RUG_LAB_Y}>
                NO TRANSACTION IN THIS PERIOD
              </text>
            )}
          </>
        )}
      </svg>

      {sparse && (
        <p className="chart-empty" data-state="sparse">
          {plotted.length === 1
            ? 'One stored price is a point, not a history. It is drawn where it belongs on the scale, and no line is drawn through it.'
            : 'Two stored prices are two facts; the line between them would be a trend, which two observations cannot support. Both are drawn, neither is joined.'}
        </p>
      )}

      {/* A chart of more than six points cannot live in an aria-label, so its values are also a
          table — including the periods with no stored price, which are rows in their own right. */}
      <table className="vh">
        <caption>Stored prices for {props.instrumentName}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {plotted.map((item) => {
            const gap = gaps.find((entry) => entry.toDate === item.point.asOf)
            return (
              <Fragment key={`row-${item.point.asOf}`}>
                {gap !== undefined && (
                  <tr>
                    <th scope="row">
                      {dayLabel(gap.fromDate)} → {dayLabel(gap.toDate)}
                    </th>
                    <td>No price stored for this period — not interpolated</td>
                  </tr>
                )}
                <tr>
                  <th scope="row">{dayLabel(item.point.asOf)}</th>
                  <td>
                    {symbol}
                    {formatQty(item.point.close)}
                  </td>
                </tr>
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/**
 * The rug of an instrument with no transaction history.
 *
 * Hatched rather than empty: an empty strip says "no transactions happened", and this component is
 * never in a position to say that. It says "Misal holds no record of any", which is what the hatch
 * means everywhere else in the product.
 */
function NoHistoryRug(): ReactNode {
  const d = roundedRightRect(PLOT_LEFT, RUG_UP, PLOT_RIGHT - PLOT_LEFT, RUG_DOWN - RUG_UP, 0)
  return (
    <>
      <path className="f-skel" data-basis="snapshot" d={d} />
      <HatchOverlay d={d} />
      <text className="rug-lab" x={PLOT_LEFT} y={RUG_LAB_Y}>
        NO TRANSACTION HISTORY — NOTHING TO MARK BENEATH THE AXIS
      </text>
    </>
  )
}

interface DateTick {
  readonly item: Plotted
  readonly anchor: 'start' | 'middle' | 'end'
}

/** The first, the last, and evenly spaced points between them — six labels at most. */
function chooseDateTicks(plotted: readonly Plotted[]): readonly DateTick[] {
  const count = Math.min(MAX_DATE_TICKS, plotted.length)
  if (count === 0) return []
  if (count === 1) {
    const only = plotted[0]
    return only === undefined ? [] : [{ item: only, anchor: 'middle' }]
  }
  const indices = new Set<number>()
  for (let tick = 0; tick < count; tick += 1) {
    indices.add(Math.round((tick * (plotted.length - 1)) / (count - 1)))
  }
  const ordered = [...indices].sort((a, b) => a - b)
  return ordered.flatMap((index): DateTick[] => {
    const item = plotted[index]
    if (item === undefined) return []
    const anchor: DateTick['anchor'] =
      index === 0 ? 'start' : index === plotted.length - 1 ? 'end' : 'middle'
    return [{ item, anchor }]
  })
}
