import { describe, expect, it } from 'vitest'
import {
  NumericError,
  addDec,
  addMinor,
  compareDec,
  currencyCode,
  dec,
  decToMinor,
  divDec,
  minor,
  minorToDec,
  mulDec,
  subMinor,
  valueOf,
} from './numeric'

describe('dec', () => {
  it('accepts canonical decimal strings', () => {
    expect(dec('0')).toBe('0')
    expect(dec('-3')).toBe('-3')
    expect(dec('12.3450')).toBe('12.3450')
    expect(dec('0.000000000000000001')).toBe('0.000000000000000001')
  })

  it('preserves trailing zeros, which are significant in fund statements', () => {
    // A CAS reporting 12.3450 units has stated four decimal places of precision.
    // Normalising that to 12.345 would discard information the source asserted.
    expect(dec('12.3450')).toBe('12.3450')
    expect(dec('100.00')).toBe('100.00')
  })

  it('rejects non-canonical forms', () => {
    expect(() => dec('1e5')).toThrow(NumericError)
    expect(() => dec('1,000')).toThrow(NumericError)
    expect(() => dec('+5')).toThrow(NumericError)
    expect(() => dec('007')).toThrow(NumericError)
    expect(() => dec('.5')).toThrow(NumericError)
    expect(() => dec('5.')).toThrow(NumericError)
    expect(() => dec('')).toThrow(NumericError)
    expect(() => dec('NaN')).toThrow(NumericError)
  })
})

describe('minor', () => {
  it('accepts integer strings and bigints', () => {
    expect(minor('483215000')).toBe('483215000')
    expect(minor(-42n)).toBe('-42')
  })

  it('rejects anything fractional', () => {
    expect(() => minor('1.5')).toThrow(NumericError)
  })

  it('holds values beyond Number.MAX_SAFE_INTEGER exactly', () => {
    // The whole reason Minor is a string: a large paise value exceeds float53 precision.
    const huge = '9007199254740993' // MAX_SAFE_INTEGER + 2
    expect(minor(huge)).toBe(huge)
    expect(addMinor(minor(huge), minor('1'))).toBe('9007199254740994')
  })
})

describe('Minor arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addMinor(minor('100'), minor('250'), minor('-50'))).toBe('300')
    expect(subMinor(minor('100'), minor('250'))).toBe('-150')
  })

  it('sums a realistic portfolio without drift', () => {
    // The five accounts from the approved mockup, in paise.
    const parts = ['164238000', '128460000', '111842800', '54674200', '24000000'].map(minor)
    expect(addMinor(...parts)).toBe('483215000')
  })
})

describe('Dec arithmetic', () => {
  it('adds without binary floating-point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float. Not here.
    expect(addDec(dec('0.1'), dec('0.2'))).toBe('0.3')
  })

  it('multiplies high-precision crypto quantities', () => {
    expect(mulDec(dec('0.00000042'), dec('2'))).toBe('0.00000084')
  })

  it('divides to full configured precision', () => {
    expect(compareDec(divDec(dec('1'), dec('3')), dec('0.333'))).toBe(1)
  })

  it('refuses division by zero rather than yielding Infinity', () => {
    expect(() => divDec(dec('1'), dec('0'))).toThrow(NumericError)
  })
})

describe('conversion between Dec and Minor', () => {
  it('round-trips a major-unit value', () => {
    const d = dec('4832.15')
    expect(minorToDec(decToMinor(d, 'INR'), 'INR')).toBe('4832.15')
  })

  it('rounds half-up at the currency exponent', () => {
    expect(decToMinor(dec('1.005'), 'INR')).toBe('101')
    expect(decToMinor(dec('1.004'), 'INR')).toBe('100')
    expect(decToMinor(dec('-1.005'), 'INR')).toBe('-101')
  })

  it('values a position without intermediate rounding', () => {
    // 21.4790 grams of gold at Rs 11,174.25 per gram.
    // Exact product is 240011.71575, so 24001171.575 paise, rounding half-up to 24001172.
    expect(valueOf(dec('21.4790'), dec('11174.25'), 'INR')).toBe('24001172')
  })

  it('values a crypto position at 18 decimals', () => {
    const qty = dec('0.123456789012345678')
    const price = dec('5000000.00')
    // Exact product is 617283.94506172839, so 61728394.506172839 paise -> 61728395.
    // A float64 multiply of these operands loses the tail entirely; this asserts it does not.
    expect(valueOf(qty, price, 'INR')).toBe('61728395')
  })
})

describe('currencyCode', () => {
  it('accepts supported codes', () => {
    expect(currencyCode('INR')).toBe('INR')
    expect(currencyCode('USD')).toBe('USD')
  })

  it('rejects unsupported codes at the storage boundary', () => {
    // Currency arrives from SQLite as a plain string; this is where a bad one must stop.
    expect(() => currencyCode('EUR')).toThrow(NumericError)
    expect(() => currencyCode('')).toThrow(NumericError)
  })

  it('is not fooled by inherited object properties', () => {
    expect(() => currencyCode('toString')).toThrow(NumericError)
    expect(() => currencyCode('constructor')).toThrow(NumericError)
  })
})
