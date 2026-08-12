/**
 * Turning a raw JSON numeric literal into a canonical `Dec`, by string manipulation only.
 *
 * The rule this module exists to keep: a digit that arrives in the response text must appear in
 * the stored value. CoinDCX's own documentation shows a balance of `265.01745775027309` - 17
 * significant digits, already unrepresentable as a double - and its `markets_details` returns
 * step sizes in scientific notation (`1e-05`). Neither survives `JSON.parse`.
 *
 * Trailing zeros are preserved rather than trimmed. `dec('1.50')` and `dec('1.5')` are different
 * strings, the core schema says trailing zeros carry significance, and the adapter conformance
 * suite asserts an exact round trip. Normalising through a decimal library would quietly drop
 * them, so the exponent shift below is done on the digits themselves.
 */

import { type Dec, dec } from '@domain/numeric'

/** JSON's number grammar, as the specification defines it. */
const JSON_NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

export class DecimalTextError extends Error {
  override readonly name = 'DecimalTextError'
}

/**
 * Convert a raw numeric literal - from a JSON number or a JSON string - to a canonical decimal.
 *
 * Accepts the JSON number grammar plus the loose forms both exchanges emit in practice: a leading
 * '+', a bare '.5', and surrounding whitespace.
 */
export function decFromRaw(raw: string): Dec {
  const trimmed = raw.trim()
  if (trimmed === '') throw new DecimalTextError('Empty numeric literal')

  // '+1.5' and '.5' are not JSON numbers but do appear in exchange payloads.
  const unsigned = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed
  const padded = unsigned.startsWith('.')
    ? `0${unsigned}`
    : unsigned.startsWith('-.')
      ? `-0${unsigned.slice(1)}`
      : unsigned

  const match = JSON_NUMBER.exec(padded)
  if (match === null) {
    throw new DecimalTextError(`Not a numeric literal: ${JSON.stringify(raw)}`)
  }

  const [, sign = '', intPart = '0', fracPart = '', exponent] = match
  const shifted =
    exponent === undefined || exponent === ''
      ? { int: intPart, frac: fracPart }
      : shift(intPart, fracPart, smallInt(exponent))

  const canonicalInt = stripLeadingZeros(shifted.int)
  const body = shifted.frac === '' ? canonicalInt : `${canonicalInt}.${shifted.frac}`
  // '-0' is not canonical and would compare unequal to '0' as a string.
  const signed = sign === '-' && !isAllZeros(body) ? `-${body}` : body
  return dec(signed)
}

/**
 * Flip the sign without arithmetic, so the scale of the original survives.
 *
 * A sell is stored as a negative quantity, and `0.00030000000000` must stay fourteen decimal
 * places wide when it does. Negating through the decimal library would return `-0.0003`: the
 * same number, but no longer the string the exchange sent, and the conformance suite asserts an
 * exact round trip.
 */
export function negateText(value: Dec): Dec {
  if (/^-?0(?:\.0*)?$/.test(value)) return value
  return dec(value.startsWith('-') ? value.slice(1) : `-${value}`)
}

/** As above, but returns null for an absent or empty value rather than throwing. */
export function decFromRawOrNull(raw: string | null | undefined): Dec | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  return decFromRaw(raw)
}

/**
 * Move the decimal point by `exponent` places, digit by digit.
 *
 * No arithmetic touches the value itself: the digits are sliced and padded, so a 40-digit
 * mantissa survives a shift as intact as a 2-digit one.
 */
function shift(intPart: string, fracPart: string, exponent: number): { int: string; frac: string } {
  const digits = `${intPart}${fracPart}`
  // Position of the decimal point, counted from the left of `digits`.
  const point = intPart.length + exponent

  if (point <= 0) {
    return { int: '0', frac: `${'0'.repeat(-point)}${digits}` }
  }
  if (point >= digits.length) {
    return { int: `${digits}${'0'.repeat(point - digits.length)}`, frac: '' }
  }
  return { int: digits.slice(0, point), frac: digits.slice(point) }
}

const DIGIT_VALUE: Readonly<Record<string, number>> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
}

/**
 * Parse a small signed integer without touching a float.
 *
 * Only ever applied to an exponent, and bounded at four digits: a corrupt `1e100000` would
 * otherwise ask for a string of that length before anything noticed. Real step sizes on both
 * exchanges span 1e-8 to 1e8.
 */
function smallInt(text: string): number {
  const negative = text.startsWith('-')
  const digits = text.replace(/^[+-]/, '')
  if (digits.length > 4) throw new DecimalTextError(`Exponent out of range: ${text}`)
  let value = 0
  for (const ch of digits) {
    value = value * 10 + (DIGIT_VALUE[ch] ?? 0)
  }
  if (value > 400) throw new DecimalTextError(`Exponent out of range: ${text}`)
  return negative ? -value : value
}

function stripLeadingZeros(intPart: string): string {
  const stripped = intPart.replace(/^0+/, '')
  return stripped === '' ? '0' : stripped
}

function isAllZeros(body: string): boolean {
  return /^0(?:\.0*)?$/.test(body)
}
