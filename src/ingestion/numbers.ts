/**
 * String-to-number canonicalisation. The only place a printed figure becomes a typed value.
 *
 * Everything here is string surgery plus `decimal.js` through `@domain/numeric`. There is no
 * float multiply, no `Math.round` and no `Number()` anywhere in the path from a statement cell to
 * a stored value, which is the point.
 *
 * Two hazards drive the design:
 *
 *   - `decimal.js` accepts `1_000`, `0x1f` and `1e3` as valid input. Input is therefore validated
 *     against an explicit decimal regex *before* it reaches the library, never after.
 *   - `new Decimal('12.3450').toString()` is `'12.345'`. Scale is captured from the source string
 *     before any Decimal exists, and carried alongside the value.
 */

import {
  type CurrencyCode,
  type Dec,
  type Minor,
  addDec,
  compareDec,
  dec,
  decToMinor,
  exponentOf,
  minor,
  subDec,
} from '@domain/numeric'
import type { DecimalString, ExcessPrecisionPolicy } from './types'
import { normaliseGlyphs } from './text'

export type NumericFailure =
  | 'empty'
  | 'not-a-number'
  | 'exponent-notation'
  | 'multiple-decimal-points'

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

/** How a source writes a negative number. */
export type NegativeStyle = 'leading-minus' | 'trailing-minus' | 'parentheses' | 'never'

export interface CanonicalOptions {
  /** Extra characters stripped before parsing, on top of the defaults. */
  readonly strip?: readonly string[]
  /** Accepted negative encodings. Defaults to leading minus and parentheses. */
  readonly negative?: NegativeStyle
}

/**
 * Characters stripped from every numeric cell regardless of descriptor.
 *
 * Digit grouping is stripped rather than locale-parsed: the depository statements group Indian
 * style (`2,55,43,509.28`) and the registrar statements group Western style (`1,723,338.01`), and
 * a locale-aware parser has to be told which — a comma strip does not.
 */
const DEFAULT_STRIP = [',', ' ', '₹', '$', 'INR', 'USD', 'Rs.', 'Rs', ' ']

const CANONICAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const EXPONENT = /[eE]/

/**
 * Turn a printed figure into a canonical decimal string plus the scale it was printed at.
 *
 * `(1,234.56)` -> `-1234.56` scale 2. `007.50` -> `7.50` scale 2. `12.3450` -> `12.3450` scale 4.
 */
export function canonicalDecimal(raw: string, options: CanonicalOptions = {}): Parsed<DecimalString> {
  let text = normaliseGlyphs(raw).trim()
  if (text === '') return fail('value is empty')

  // `--` is the depositories' null cell, not a number.
  if (text === '--' || text === '-' || text === 'N.A.' || text === 'NA') return fail('value is empty')

  const style = options.negative ?? 'leading-minus'
  let negative = false

  if (style !== 'never') {
    if ((style === 'parentheses' || style === 'leading-minus') && /^\(.*\)$/.test(text)) {
      // Parentheses are the registrar statements' only negative marker, on amounts and units
      // alike. They are accepted even under `leading-minus` because a source that uses both
      // exists and rejecting one of them would drop real rows.
      negative = true
      text = text.slice(1, -1).trim()
    } else if (style === 'trailing-minus' && text.endsWith('-')) {
      negative = true
      text = text.slice(0, -1).trim()
    } else if (text.startsWith('-')) {
      negative = true
      text = text.slice(1).trim()
    }
  }

  for (const token of [...DEFAULT_STRIP, ...(options.strip ?? [])]) {
    text = text.split(token).join('')
  }

  if (text === '') return fail('value is empty')
  if (EXPONENT.test(text)) return fail(`exponent notation is not accepted: ${JSON.stringify(raw)}`)
  if (!/^\d*(?:\.\d*)?$/.test(text)) return fail(`not a number: ${JSON.stringify(raw)}`)
  if ((text.match(/\./g) ?? []).length > 1) {
    return fail(`more than one decimal point: ${JSON.stringify(raw)}`)
  }

  // `.5` and `5.` both occur; neither is canonical.
  if (text.startsWith('.')) text = `0${text}`
  if (text.endsWith('.')) text = text.slice(0, -1)

  const dot = text.indexOf('.')
  const scale = dot === -1 ? 0 : text.length - dot - 1
  const intPart = dot === -1 ? text : text.slice(0, dot)
  const fracPart = dot === -1 ? '' : text.slice(dot + 1)

  const trimmedInt = intPart.replace(/^0+(?=\d)/, '')
  const body = fracPart === '' ? trimmedInt : `${trimmedInt}.${fracPart}`
  // `-0` and `-0.00` are printed by real statements; the sign carries no information there and a
  // signed zero would make two identical rows hash differently.
  const isZero = /^0(?:\.0*)?$/.test(body)
  const signed = negative && !isZero ? `-${body}` : body

  if (!CANONICAL.test(signed)) return fail(`not a canonical decimal: ${JSON.stringify(raw)}`)
  return { ok: true, value: { value: dec(signed), scale } }
}

/** A DecimalString from an already-canonical value, for computed results. */
export function decimalString(value: Dec, scale: number): DecimalString {
  return { value, scale }
}

/**
 * Pad a canonical decimal out to a target scale.
 *
 * Computed values lose their trailing zeros inside `decimal.js` — `10 x 3850.50` comes back as
 * `38505`. The scale of a product is the sum of its operands' scales, and padding to it is what
 * keeps a derived figure printing the way the source's own arithmetic would.
 */
export function padToScale(value: Dec, scale: number): DecimalString {
  const current = scaleOf(value)
  if (current >= scale) return { value, scale: current }
  const padded = current === 0 ? `${value}.${'0'.repeat(scale)}` : `${value}${'0'.repeat(scale - current)}`
  return { value: dec(padded), scale }
}

/** The scale of a canonical decimal string. */
export function scaleOf(value: Dec): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

export interface MoneyResult {
  readonly minor: Minor
  /** True when digits beyond the currency's exponent were dropped by rounding. */
  readonly rounded: boolean
}

/**
 * Convert a canonical decimal to minor units.
 *
 * Exact when the value has no more fractional digits than the currency's exponent — the decimal
 * point is shifted with string operations. Only when it has more, and they are not all zeros,
 * does the policy decide: `error` fails the row, `round-half-up` rounds and reports it so the
 * import report can name the original string.
 */
export function toMinorUnits(
  value: DecimalString,
  currency: CurrencyCode,
  policy: ExcessPrecisionPolicy = 'error',
): Parsed<MoneyResult> {
  const exponent = exponentOf(currency)
  const text = value.value
  const negative = text.startsWith('-')
  const body = negative ? text.slice(1) : text
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot + 1)

  if (fracPart.length > exponent) {
    const excess = fracPart.slice(exponent)
    if (/[^0]/.test(excess)) {
      if (policy === 'error') {
        return fail(
          `${text} has more than ${String(exponent)} fractional digits, which ${currency} cannot represent`,
        )
      }
      return { ok: true, value: { minor: decToMinor(text, currency), rounded: true } }
    }
  }

  const padded = (fracPart + '0'.repeat(exponent)).slice(0, exponent)
  const digits = `${intPart}${padded}`.replace(/^0+(?=\d)/, '')
  const signed = negative && /[^0]/.test(digits) ? `-${digits}` : digits
  return { ok: true, value: { minor: minor(signed), rounded: false } }
}

/**
 * Absolute difference between two decimals, for checksum comparison.
 *
 * Deliberately not exported as a general subtract: the only reason ingestion subtracts two
 * quantities is to check a printed running balance against a computed one.
 */
export function withinTolerance(a: Dec, b: Dec, tolerance: Dec): boolean {
  const diff = subtractDec(a, b)
  const magnitude = diff.startsWith('-') ? (diff.slice(1) as Dec) : diff
  return compare(magnitude, tolerance) <= 0
}

function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason }
}

// These three wrap @domain/numeric so this module is the single arithmetic surface for the rest
// of ingestion, and no caller is tempted to reach for the operator.
export function subtractDec(a: Dec, b: Dec): Dec {
  return subDec(a, b)
}

export function sumDec(values: readonly Dec[]): Dec {
  return addDec(...values)
}

export function compare(a: Dec, b: Dec): -1 | 0 | 1 {
  return compareDec(a, b)
}
