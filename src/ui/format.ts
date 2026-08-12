/**
 * Formatting — the display boundary, and the only place rounding happens.
 *
 * Every figure in the interface arrives as a `Minor` or a `Dec` string and leaves this module as
 * a string. Nothing here parses a value into a JavaScript number: grouping, rounding and sign
 * glyphs are all string or `BigInt` operations, which is why `Intl.NumberFormat` — whose input is
 * a `number` — cannot be used and the lakh/crore rule is written out by hand.
 *
 * Rules taken from the approved mockup (spec §4.3):
 *   - Indian 2-2-3 grouping for INR, 3-digit grouping for USD.
 *   - Signs are glyphs: '+' (U+002B) and '−' (U+2212 MINUS SIGN), never a hyphen, never colour
 *     alone.
 *   - The currency symbol appears once — in the column header or in the figure, never both.
 *   - Quantities keep their stored digits, trailing zeros intact.
 *   - Money in a cell is never abbreviated. `₹5L` is an axis tick, which is a scale marker rather
 *     than a figure, and `abbreviateMinor` is documented as tick-only for that reason.
 */

import type { CurrencyCode, Dec, Minor } from '@domain/numeric'
import { exponentOf } from '@domain/numeric'

export const MINUS = '−'
export const PLUS = '+'

export const CURRENCY_SYMBOL: Record<CurrencyCode, string> = {
  INR: '₹',
  USD: '$',
}

/** A rupee (or dollar) amount, always carrying its currency so nothing is assumed. */
export interface Money {
  readonly minor: Minor
  readonly currency: CurrencyCode
}

export function money(minor: Minor, currency: CurrencyCode = 'INR'): Money {
  return { minor, currency }
}

/**
 * The 2-2-3 lakh/crore rule, applied to a string of integer digits.
 *
 * `4832150` → `48,32,150`. The last three digits stay together; everything before them is grouped
 * in twos, from the right.
 */
export function formatIndianGroups(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits
  const last3 = intDigits.slice(-3)
  const rest = intDigits.slice(0, -3)
  const groups: string[] = []
  let index = rest.length
  while (index > 2) {
    groups.unshift(rest.slice(index - 2, index))
    index -= 2
  }
  if (index > 0) groups.unshift(rest.slice(0, index))
  return `${groups.join(',')},${last3}`
}

/** Plain 3-digit grouping, for USD. */
export function formatWesternGroups(intDigits: string): string {
  const groups: string[] = []
  let index = intDigits.length
  while (index > 3) {
    groups.unshift(intDigits.slice(index - 3, index))
    index -= 3
  }
  groups.unshift(intDigits.slice(0, index))
  return groups.join(',')
}

function groupFor(currency: CurrencyCode, intDigits: string): string {
  return currency === 'INR' ? formatIndianGroups(intDigits) : formatWesternGroups(intDigits)
}

interface Parts {
  readonly negative: boolean
  readonly intDigits: string
  readonly fracDigits: string
}

/**
 * Scale a minor-unit integer down to `decimals` displayed places, rounding half-up.
 *
 * This is the one rounding step in the product, and it happens after every arithmetic decision has
 * already been made in exact integer or decimal maths.
 */
function scaleMinor(value: Minor, currency: CurrencyCode, decimals: number): Parts {
  const exponent = exponentOf(currency)
  if (decimals > exponent) {
    throw new Error(`Cannot show ${decimals} decimals of a ${currency} minor unit`)
  }
  const raw = BigInt(value)
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const divisor = 10n ** BigInt(exponent - decimals)
  const quotient = abs / divisor
  const remainder = abs % divisor
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient
  const digits = rounded.toString().padStart(decimals + 1, '0')
  return {
    negative,
    intDigits: decimals === 0 ? digits : digits.slice(0, -decimals),
    fracDigits: decimals === 0 ? '' : digits.slice(-decimals),
  }
}

function signGlyph(negative: boolean, signed: boolean): string {
  if (negative) return MINUS
  return signed ? PLUS : ''
}

export interface MoneyFormat {
  /** Displayed decimal places. 0 for portfolio figures, 2 for prices. Defaults to 0. */
  readonly decimals?: number
  /** Emit a leading '+' for positive values. Negatives always carry '−'. */
  readonly signed?: boolean
  /** Emit the currency symbol. Set false where the column header already carries it. */
  readonly symbol?: boolean
}

/** `₹48,32,150`, `+₹18,506`, `−₹2,412.75`, `$376.20`. */
export function formatMoney(value: Money, options: MoneyFormat = {}): string {
  const decimals = options.decimals ?? 0
  const { negative, intDigits, fracDigits } = scaleMinor(value.minor, value.currency, decimals)
  const symbol = options.symbol === false ? '' : CURRENCY_SYMBOL[value.currency]
  const grouped = groupFor(value.currency, intDigits)
  const body = fracDigits === '' ? grouped : `${grouped}.${fracDigits}`
  return `${signGlyph(negative, options.signed === true)}${symbol}${body}`
}

/**
 * Round a canonical decimal string to `decimals` places, half-up, without leaving string maths.
 */
export function roundDec(value: Dec | string, decimals: number): Parts {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const dot = abs.indexOf('.')
  const intPart = dot === -1 ? abs : abs.slice(0, dot)
  const fracPart = dot === -1 ? '' : abs.slice(dot + 1)

  if (fracPart.length <= decimals) {
    return { negative, intDigits: intPart, fracDigits: fracPart.padEnd(decimals, '0') }
  }
  let scaled = BigInt(intPart + fracPart.slice(0, decimals))
  const nextDigit = fracPart.charCodeAt(decimals) - 48
  if (nextDigit >= 5) scaled += 1n
  const digits = scaled.toString().padStart(decimals + 1, '0')
  return {
    negative,
    intDigits: decimals === 0 ? digits : digits.slice(0, -decimals),
    fracDigits: decimals === 0 ? '' : digits.slice(-decimals),
  }
}

export interface PctFormat {
  /** Defaults to 2, matching the mockup's `+24.94%`. Coverage uses 1. */
  readonly decimals?: number
  readonly signed?: boolean
}

/** `71.9%`, `+24.94%`, `−0.30%`. The value is a percentage already: '24.94' means 24.94%. */
export function formatPct(value: Dec, options: PctFormat = {}): string {
  const decimals = options.decimals ?? 2
  const { negative, intDigits, fracDigits } = roundDec(value, decimals)
  const body = fracDigits === '' ? intDigits : `${intDigits}.${fracDigits}`
  return `${signGlyph(negative, options.signed === true)}${body}%`
}

export interface QtyFormat {
  /** Digits to display. Omitted, the stored digits are shown exactly as held. */
  readonly precision?: number
  readonly unit?: string
}

/** `11,240.556`, `0.04150000`, `21.4790 g`. Trailing zeros are significant and are preserved. */
export function formatQty(value: Dec, options: QtyFormat = {}): string {
  const parts =
    options.precision === undefined
      ? splitDec(value)
      : roundDec(value, options.precision)
  const grouped = formatWesternGroups(parts.intDigits)
  const body = parts.fracDigits === '' ? grouped : `${grouped}.${parts.fracDigits}`
  const sign = parts.negative ? MINUS : ''
  return options.unit === undefined ? `${sign}${body}` : `${sign}${body} ${options.unit}`
}

function splitDec(value: Dec): Parts {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const dot = abs.indexOf('.')
  return {
    negative,
    intDigits: dot === -1 ? abs : abs.slice(0, dot),
    fracDigits: dot === -1 ? '' : abs.slice(dot + 1),
  }
}

/**
 * A percentage as a CSS length: `'71.9'` → `'71.90%'`, clamped to 0–100.
 *
 * Meters, split bars and weight bars are drawn in CSS from the decimal string itself, which is why
 * none of them needs the pixel-geometry escape hatch: the browser does the arithmetic.
 */
export function cssPercent(value: Dec): string {
  const { negative, intDigits, fracDigits } = roundDec(value, 2)
  if (negative) return '0%'
  const hundredths = BigInt(intDigits + fracDigits)
  if (hundredths >= 10_000n) return '100%'
  return `${intDigits}.${fracDigits}%`
}

const CRORE = 10_000_000n
const LAKH = 100_000n

/**
 * `₹5L`, `₹1.5Cr`, `0`.
 *
 * **Axis ticks only.** An abbreviated figure states less than it appears to, so it is allowed
 * where it marks a scale and nowhere a reader would take it for the value itself (spec §4.3).
 */
export function abbreviateMinor(value: Minor, currency: CurrencyCode = 'INR'): string {
  const exponent = exponentOf(currency)
  const raw = BigInt(value)
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const majorUnits = abs / 10n ** BigInt(exponent)
  const symbol = CURRENCY_SYMBOL[currency]
  const sign = negative ? MINUS : ''

  if (majorUnits === 0n) return '0'
  if (currency !== 'INR' || majorUnits < LAKH) {
    return `${sign}${symbol}${groupFor(currency, majorUnits.toString())}`
  }
  const divisor = majorUnits >= CRORE ? CRORE : LAKH
  const suffix = majorUnits >= CRORE ? 'Cr' : 'L'
  const whole = majorUnits / divisor
  const hundredths = ((majorUnits % divisor) * 100n) / divisor
  const fraction = hundredths.toString().padStart(2, '0').replace(/0+$/, '')
  const body = fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`
  return `${sign}${symbol}${body}${suffix}`
}
