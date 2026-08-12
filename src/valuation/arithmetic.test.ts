/**
 * The two operations that live below the engine: fractional exponentiation and integer allocation.
 */

import { describe, expect, it } from 'vitest'
import { dec, minor } from '@domain/numeric'
import {
  commonScale,
  decFromCount,
  decimalPlaces,
  mulDivMinor,
  powDec,
  roundDec,
  scaleToInteger,
  tenPow,
  tenPowNegative,
  truncDec,
} from './arithmetic'
import { ValuationAssertionError } from './types'

describe('powDec', () => {
  it('handles the fractional exponents XIRR discounting produces', () => {
    expect(powDec(dec('1.1'), dec('2'))).toBe('1.21')
    // The discount factor at the golden XIRR root, over 863/365 years. Cross-checked against the
    // series itself: at the root, (1+r)^2.3643835… must equal 180000 / (100000 + 50000/(1+r)),
    // which is 1.2351866875… — the same figure from an independent direction.
    expect(roundDec(powDec(dec('1.0934468614'), dec('2.3643835616438356')), 8)).toBe('1.23518669')
  })

  it('returns a canonical decimal string even for results that print exponentially', () => {
    // decimal.js switches to exponential notation outside the configured window, and `dec()`
    // rejects that. The expansion must be exact, not a re-parse through a float.
    const tiny = powDec(dec('0.1'), dec('45'))
    expect(tiny.includes('e')).toBe(false)
    expect(tiny.startsWith('0.000000000000000000000000000000000000000000001')).toBe(true)
    const huge = powDec(dec('10'), dec('45'))
    expect(huge).toBe('1000000000000000000000000000000000000000000000')
  })

  it('is exact for integer powers, so no rounding creeps into a discount factor', () => {
    expect(powDec(dec('1.05'), dec('10'))).toBe('1.62889462677744140625')
  })
})

describe('decimal helpers', () => {
  it('counts decimal places as written, preserving significance', () => {
    expect(decimalPlaces(dec('12.3450'))).toBe(4)
    expect(decimalPlaces(dec('12'))).toBe(0)
  })

  it('caps the common scale at 18 places, which is the deepest quantity any asset carries', () => {
    expect(commonScale(dec('1.5'), dec('2.25'))).toBe(2)
    expect(commonScale(dec('0.0000000000000000001'))).toBe(18)
  })

  it('scales to an integer by truncation, never by rounding up', () => {
    expect(scaleToInteger(dec('12.3456'), 2)).toBe(1234n)
    expect(scaleToInteger(dec('-12.3456'), 2)).toBe(-1234n)
    expect(scaleToInteger(dec('7'), 3)).toBe(7000n)
  })

  it('rounds and truncates only where asked', () => {
    expect(roundDec(dec('2.345'), 2)).toBe('2.35')
    expect(truncDec(dec('2.349'), 2)).toBe('2.34')
  })

  it('builds powers of ten without arithmetic', () => {
    expect(tenPow(4)).toBe('10000')
    expect(tenPowNegative(4)).toBe('0.0001')
    expect(tenPowNegative(0)).toBe('1')
  })

  it('refuses a non-integer count rather than silently flooring it', () => {
    expect(() => decFromCount(3.5)).toThrow(ValuationAssertionError)
    expect(decFromCount(863)).toBe('863')
  })
})

describe('mulDivMinor', () => {
  it('is exact for the spec’s worked allocation', () => {
    // 3,603,520 paise × 20 / 50 = 1,441,408 paise.
    expect(mulDivMinor(minor('3603520'), 20n, 50n)).toBe('1441408')
  })

  it('truncates toward zero, so a slice is never over-allocated', () => {
    expect(mulDivMinor(minor('100'), 1n, 3n)).toBe('33')
    expect(mulDivMinor(minor('-100'), 1n, 3n)).toBe('-33')
  })

  it('throws on a zero denominator rather than producing a value', () => {
    expect(() => mulDivMinor(minor('100'), 1n, 0n)).toThrow(ValuationAssertionError)
  })

  it('survives figures beyond Number.MAX_SAFE_INTEGER', () => {
    // ₹900 crore in paise is past 2^53; bigint is why the ceiling is not discovered by corruption.
    expect(mulDivMinor(minor('90000000000000000'), 1n, 3n)).toBe('30000000000000000')
  })
})
