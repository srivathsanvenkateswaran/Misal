/**
 * Chart geometry — the one audited place a decimal becomes a JavaScript number.
 *
 * `unsafeToNumberForPixelGeometryOnly` appears in this directory and nowhere else in the UI. Its
 * output is a pixel coordinate: a rendering artefact that is never displayed as a figure. Every
 * label a reader can see is formatted from the original `Minor` or `Dec` string, by the formatters
 * in `../format`. If you find yourself wanting the number for a label, that is the bug this
 * separation exists to prevent.
 */

import type { Dec, Minor } from '@domain/numeric'
import { minor, unsafeToNumberForPixelGeometryOnly } from '@domain/numeric'

export type Scalar = Minor | Dec

/** Maps a value in the domain to a pixel coordinate in the range. */
export type LinearScale = (value: Scalar) => number

export function scaleLinear(
  domain: readonly [Scalar, Scalar],
  range: readonly [number, number],
): LinearScale {
  const d0 = unsafeToNumberForPixelGeometryOnly(domain[0])
  const d1 = unsafeToNumberForPixelGeometryOnly(domain[1])
  const [r0, r1] = range
  const span = d1 - d0
  return (value) => {
    if (span === 0) return r0
    const t = (unsafeToNumberForPixelGeometryOnly(value) - d0) / span
    return r0 + t * (r1 - r0)
  }
}

/** Two decimal places of pixel precision, which is all an SVG coordinate needs. */
export function px(value: number): number {
  return Math.round(value * 100) / 100
}

// Paise, because every money value in the product is minor units. One lakh rupees is 10,000,000
// paise; a crore is a hundred times that.
export const LAKH_MINOR = 10_000_000n
export const FIVE_LAKH_MINOR = 5n * LAKH_MINOR
export const TEN_LAKH_MINOR = 10n * LAKH_MINOR
export const FIFTY_LAKH_MINOR = 50n * LAKH_MINOR
export const CRORE_MINOR = 100n * LAKH_MINOR
export const FIVE_CRORE_MINOR = 500n * LAKH_MINOR

export interface TickSteps {
  readonly major: bigint
  readonly minor: bigint
}

/**
 * Minor ticks every lakh and labelled majors every ₹5L, as the mockup draws them — until the
 * portfolio outgrows that, at which point the same 5:1 ratio steps up an order of magnitude
 * rather than the ruler growing 500 ticks.
 */
export function chooseTickSteps(scaleMax: Minor): TickSteps {
  const max = BigInt(scaleMax)
  if (max <= FIFTY_LAKH_MINOR) return { major: FIVE_LAKH_MINOR, minor: LAKH_MINOR }
  if (max <= FIVE_CRORE_MINOR) return { major: FIFTY_LAKH_MINOR, minor: TEN_LAKH_MINOR }
  return { major: FIVE_CRORE_MINOR, minor: CRORE_MINOR }
}

/** Round a total up to a clean ruler end: a whole ₹5L, ₹50L or ₹5Cr step. */
export function roundUpScaleMax(total: Minor): Minor {
  const value = BigInt(total)
  if (value <= 0n) return minor(FIVE_LAKH_MINOR)
  const step = chooseTickSteps(minor(value)).major
  const rounded = ((value + step - 1n) / step) * step
  return minor(rounded)
}

export interface Tick {
  readonly value: Minor
  readonly major: boolean
}

/** Every tick from zero to `scaleMax` inclusive, flagged major where a label belongs. */
export function ticks(scaleMax: Minor, steps: TickSteps): readonly Tick[] {
  const max = BigInt(scaleMax)
  const out: Tick[] = []
  for (let value = 0n; value <= max; value += steps.minor) {
    out.push({ value: minor(value), major: value % steps.major === 0n })
  }
  return out
}

/**
 * A rectangle with only its right-hand end rounded, as every terminal segment in the mockup is.
 * Written as a path because SVG's `rx` rounds all four corners.
 */
export function roundedRightRect(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.min(radius, Math.max(width, 0), height / 2)
  const right = px(x + width)
  const bottom = px(y + height)
  if (r <= 0) {
    return `M${px(x)} ${px(y)} L${right} ${px(y)} L${right} ${bottom} L${px(x)} ${bottom} Z`
  }
  return [
    `M${px(x)} ${px(y)}`,
    `L${px(right - r)} ${px(y)}`,
    `Q${right} ${px(y)} ${right} ${px(y + r)}`,
    `L${right} ${px(bottom - r)}`,
    `Q${right} ${bottom} ${px(right - r)} ${bottom}`,
    `L${px(x)} ${bottom}`,
    'Z',
  ].join(' ')
}

/** A rectangle with only its top end rounded — the cap on the top segment of a stacked column. */
export function roundedTopRect(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.min(radius, width / 2, Math.max(height, 0))
  const right = px(x + width)
  const bottom = px(y + height)
  if (r <= 0) {
    return `M${px(x)} ${px(y)} L${right} ${px(y)} L${right} ${bottom} L${px(x)} ${bottom} Z`
  }
  return [
    `M${px(x)} ${bottom}`,
    `L${px(x)} ${px(y + r)}`,
    `Q${px(x)} ${px(y)} ${px(x + r)} ${px(y)}`,
    `L${px(right - r)} ${px(y)}`,
    `Q${right} ${px(y)} ${right} ${px(y + r)}`,
    `L${right} ${bottom}`,
    'Z',
  ].join(' ')
}
