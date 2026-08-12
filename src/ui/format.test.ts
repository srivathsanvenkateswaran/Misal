import { describe, expect, it } from 'vitest'
import { dec, minor } from '@domain/numeric'
import {
  abbreviateMinor,
  cssPercent,
  formatIndianGroups,
  formatMoney,
  formatPct,
  formatQty,
  formatWesternGroups,
  money,
} from './format'

describe('Indian grouping', () => {
  it('applies the 2-2-3 rule rather than 3-3-3', () => {
    expect(formatIndianGroups('4832150')).toBe('48,32,150')
    expect(formatIndianGroups('100000')).toBe('1,00,000')
    expect(formatIndianGroups('10000000')).toBe('1,00,00,000')
  })

  it('leaves short numbers alone', () => {
    for (const digits of ['0', '7', '99', '999']) {
      expect(formatIndianGroups(digits)).toBe(digits)
    }
  })

  it('groups correctly across 1 to 15 digits', () => {
    const digits = '123456789012345'
    for (let length = 1; length <= digits.length; length += 1) {
      const input = digits.slice(0, length)
      const grouped = formatIndianGroups(input)
      expect(grouped.replace(/,/g, '')).toBe(input)
      const groups = grouped.split(',')
      if (groups.length > 1) {
        expect(groups[groups.length - 1]).toHaveLength(3)
        for (const group of groups.slice(1, -1)) expect(group).toHaveLength(2)
      }
    }
  })

  it('keeps USD on three-digit groups', () => {
    expect(formatWesternGroups('4832150')).toBe('4,832,150')
  })
})

describe('formatMoney', () => {
  it('reproduces the mockup figures', () => {
    expect(formatMoney(money(minor('483215000')))).toBe('₹48,32,150')
    expect(formatMoney(money(minor('347372200')))).toBe('₹34,73,722')
    expect(formatMoney(money(minor('1850600')), { signed: true })).toBe('+₹18,506')
  })

  it('uses U+2212 for negatives, never a hyphen', () => {
    const formatted = formatMoney(money(minor('-1850600')), { signed: true })
    expect(formatted).toBe('−₹18,506')
    expect(formatted).not.toContain('-')
  })

  it('shows a negative even when signs are not requested', () => {
    expect(formatMoney(money(minor('-100')))).toBe('−₹1')
  })

  it('rounds to the rupee half-up, and only at the display boundary', () => {
    expect(formatMoney(money(minor('150')))).toBe('₹2')
    expect(formatMoney(money(minor('149')))).toBe('₹1')
    expect(formatMoney(money(minor('149')), { decimals: 2 })).toBe('₹1.49')
  })

  it('drops the symbol where a column header already carries it', () => {
    expect(formatMoney(money(minor('483215000')), { symbol: false })).toBe('48,32,150')
  })

  it('formats USD with its own symbol and grouping', () => {
    expect(formatMoney({ minor: minor('37620'), currency: 'USD' }, { decimals: 2 })).toBe('$376.20')
    expect(formatMoney({ minor: minor('127908000'), currency: 'USD' }, { decimals: 2 })).toBe(
      '$1,279,080.00',
    )
  })

  it('never emits an exponent, NaN or undefined for a large value', () => {
    // 18 digits of paise: an int64 the exact way, rounded up to the rupee at the display boundary.
    const formatted = formatMoney(money(minor('999999999999999999')))
    expect(formatted).toBe('₹10,00,00,00,00,00,00,000')
    expect(formatMoney(money(minor('999999999999999999')), { decimals: 2 })).toBe(
      '₹9,99,99,99,99,99,99,999.99',
    )
    expect(formatted).not.toMatch(/e\+|NaN|Infinity|undefined/i)
  })
})

describe('formatPct', () => {
  it('matches the mockup', () => {
    expect(formatPct(dec('24.94'), { signed: true })).toBe('+24.94%')
    expect(formatPct(dec('-0.30'), { signed: true })).toBe('−0.30%')
    expect(formatPct(dec('71.9'), { decimals: 1 })).toBe('71.9%')
    expect(formatPct(dec('18.42'))).toBe('18.42%')
  })

  it('rounds half-up on the string, without a float', () => {
    expect(formatPct(dec('71.85'), { decimals: 1 })).toBe('71.9%')
    expect(formatPct(dec('71.84999'), { decimals: 1 })).toBe('71.8%')
    expect(formatPct(dec('99.999'), { decimals: 0 })).toBe('100%')
  })
})

describe('formatQty', () => {
  it('preserves the stored digits, trailing zeros included', () => {
    expect(formatQty(dec('0.04150000'))).toBe('0.04150000')
    expect(formatQty(dec('11240.556'))).toBe('11,240.556')
    expect(formatQty(dec('21.4790'), { unit: 'g' })).toBe('21.4790 g')
    expect(formatQty(dec('55.8400'))).toBe('55.8400')
  })

  it('does not re-round an already-rounded value', () => {
    expect(formatQty(dec('6.09770000'), { precision: 8 })).toBe('6.09770000')
  })
})

describe('abbreviateMinor — axis ticks only', () => {
  it('produces the mockup ruler labels', () => {
    expect(abbreviateMinor(minor('0'))).toBe('0')
    expect(abbreviateMinor(minor('50000000'))).toBe('₹5L')
    expect(abbreviateMinor(minor('500000000'))).toBe('₹50L')
    expect(abbreviateMinor(minor('100000000'))).toBe('₹10L')
  })

  it('switches to crore, keeping at most two decimals', () => {
    expect(abbreviateMinor(minor('1000000000'))).toBe('₹1Cr')
    expect(abbreviateMinor(minor('1500000000'))).toBe('₹1.5Cr')
    expect(abbreviateMinor(minor('483215000'))).toBe('₹48.32L')
  })
})

describe('cssPercent', () => {
  it('is clamped and never negative', () => {
    expect(cssPercent(dec('71.9'))).toBe('71.90%')
    expect(cssPercent(dec('0'))).toBe('0.00%')
    expect(cssPercent(dec('100'))).toBe('100%')
    expect(cssPercent(dec('140.2'))).toBe('100%')
    expect(cssPercent(dec('-4'))).toBe('0%')
  })
})
