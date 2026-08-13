/**
 * The scaling and counting helpers that live below the engine.
 *
 * `powDec`, `roundDec` and `mulDivMinor` are general numeric operations and are tested with the
 * rest of them in `src/domain/numeric.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { dec } from '@domain/numeric'
import {
  commonScale,
  decFromCount,
  decimalPlaces,
  scaleToInteger,
  tenPow,
  tenPowNegative,
  truncDec,
} from './arithmetic'
import { ValuationAssertionError } from './types'

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

  it('truncates rather than rounds where asked', () => {
    expect(truncDec(dec('2.349'), 2)).toBe('2.34')
    expect(truncDec(dec('2.999'), 2)).toBe('2.99')
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
