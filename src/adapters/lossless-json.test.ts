import { describe, expect, it } from 'vitest'
import { decFromRaw, DecimalTextError } from './decimal-text'
import { decimal, parseLossless, requireArray, text } from './lossless-json'
import { epochMsToIso, truncateToMs } from './time'

describe('decimal text', () => {
  it('preserves trailing zeros, which carry significance', () => {
    expect(decFromRaw('1.50')).toBe('1.50')
    expect(decFromRaw('0.00000000')).toBe('0.00000000')
  })

  it('preserves seventeen significant digits', () => {
    // CoinDCX's own documentation shows this balance. A double cannot hold it.
    expect(decFromRaw('265.01745775027309')).toBe('265.01745775027309')
  })

  it('preserves eighteen decimal places', () => {
    expect(decFromRaw('42.000000000000000001')).toBe('42.000000000000000001')
  })

  it('expands scientific notation without arithmetic', () => {
    expect(decFromRaw('1e-05')).toBe('0.00001')
    expect(decFromRaw('1.5E3')).toBe('1500')
    expect(decFromRaw('-2.5e-3')).toBe('-0.0025')
    expect(decFromRaw('1e0')).toBe('1')
  })

  it('accepts the loose forms exchanges actually send', () => {
    expect(decFromRaw(' 12.5 ')).toBe('12.5')
    expect(decFromRaw('+7')).toBe('7')
    expect(decFromRaw('.5')).toBe('0.5')
    expect(decFromRaw('-0')).toBe('0')
  })

  it('refuses an exponent large enough to be an attack', () => {
    expect(() => decFromRaw('1e100000')).toThrow(DecimalTextError)
  })
})

describe('lossless parsing', () => {
  it('never produces a number', () => {
    const parsed = parseLossless('{"balance": 265.01745775027309}')
    expect(decimal(parsed, 'balance', 'row')).toBe('265.01745775027309')
    // The proof that JSON.parse would have lost it.
    const viaJsonParse = JSON.parse('{"b":265.01745775027309}') as { b: number }
    expect(String(viaJsonParse.b)).toBe('265.0174577502731')
  })

  it('reads a numeric field whether the exchange quoted it or not', () => {
    // CoinDCX returns strings in real responses and numbers in its documented samples, and has
    // changed which is which; both must read identically.
    expect(decimal(parseLossless('{"q":"0.50000000"}'), 'q', 'row')).toBe('0.50000000')
    expect(decimal(parseLossless('{"q":0.5}'), 'q', 'row')).toBe('0.5')
  })

  it('handles nesting, escapes and empty containers', () => {
    const parsed = parseLossless('{"a":[{"b":"x\\"y"},[],{}],"c":null,"d":true}')
    const array = requireArray((parsed as { a: unknown }).a as never, 'a')
    expect(text(array[0], 'b', 'row')).toBe('x"y')
    expect(array).toHaveLength(3)
  })

  it('rejects malformed input as a typed error rather than a decode exception', () => {
    expect(() => parseLossless('{"a": }')).toThrow(/could not read/)
    expect(() => parseLossless('')).toThrow(/could not read/)
  })
})

describe('timestamps', () => {
  it('truncates fractional milliseconds rather than rounding them', () => {
    // Rounding would shift the instant by a millisecond, change the natural key, and defeat
    // deduplication against the same trade imported from a CSV.
    expect(truncateToMs('1718386312255.3608')).toBe('1718386312255')
    expect(truncateToMs('1718386512255.9999')).toBe('1718386512255')
  })

  it('converts to ISO-8601 exactly', () => {
    expect(epochMsToIso('1718386312255')).toBe('2024-06-14T17:31:52.255Z')
    expect(epochMsToIso('0')).toBe('1970-01-01T00:00:00.000Z')
    expect(epochMsToIso('1755000000000')).toBe('2025-08-12T12:00:00.000Z')
  })

  it('agrees with the platform Date for a spread of instants', () => {
    for (const ms of [1, 86_399_999, 951_782_400_000, 1_709_164_800_000, 4_102_444_800_000]) {
      expect(epochMsToIso(String(ms))).toBe(new Date(ms).toISOString())
    }
  })

  it('handles instants before the epoch without landing a day late', () => {
    expect(epochMsToIso('-1')).toBe(new Date(-1).toISOString())
  })
})
