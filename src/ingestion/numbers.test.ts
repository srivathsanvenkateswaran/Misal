import { describe, expect, it } from 'vitest'
import { canonicalDecimal, padToScale, toMinorUnits, withinTolerance } from './numbers'
import { dec } from '@domain/numeric'
import { parseDate } from './dates'
import { findIsin, rejoinLetterSpacing, undouble } from './text'
import { classifyDescription } from './classify'
import { naturalKeyInput, trimTrailingZeros } from './reconcile'
import type { ResolvedTransaction } from './types'

describe('numeric fidelity', () => {
  it('preserves trailing zeros and the scale the source printed', () => {
    const parsed = canonicalDecimal('12.3450')
    expect(parsed.ok && parsed.value.value).toBe('12.3450')
    expect(parsed.ok && parsed.value.scale).toBe(4)
  })

  it('reads Indian and Western digit grouping the same way', () => {
    expect(canonicalDecimal('2,55,43,509.28')).toMatchObject({ ok: true, value: { value: '25543509.28' } })
    expect(canonicalDecimal('1,723,338.01')).toMatchObject({ ok: true, value: { value: '1723338.01' } })
  })

  it('reads a parenthesised amount as a negative', () => {
    const parsed = canonicalDecimal('(1,234.56)')
    expect(parsed.ok && parsed.value.value).toBe('-1234.56')
  })

  it('turns a rupee amount into paise exactly', () => {
    const parsed = canonicalDecimal('₹48,32,150.00')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(toMinorUnits(parsed.value, 'INR')).toMatchObject({ ok: true, value: { minor: '483215000' } })
  })

  it('rejects what the decimal library would otherwise accept', () => {
    // decimal.js takes all three of these and produces a number. The regex runs first.
    expect(canonicalDecimal('1_000').ok).toBe(false)
    expect(canonicalDecimal('0x1f').ok).toBe(false)
    expect(canonicalDecimal('1e3').ok).toBe(false)
  })

  it('treats the depositories null cell as empty rather than as a number', () => {
    expect(canonicalDecimal('--').ok).toBe(false)
  })

  it('drops a sign that carries no information', () => {
    expect(canonicalDecimal('(0.00)')).toMatchObject({ ok: true, value: { value: '0.00' } })
  })

  it('refuses to round money by default, and reports it when asked to', () => {
    const value = { value: dec('100.005'), scale: 3 }
    expect(toMinorUnits(value, 'INR').ok).toBe(false)
    expect(toMinorUnits(value, 'INR', 'round-half-up')).toMatchObject({
      ok: true,
      value: { minor: '10001', rounded: true },
    })
  })

  it('pads a computed value back out to the scale of its operands', () => {
    expect(padToScale(dec('38505'), 2)).toEqual({ value: '38505.00', scale: 2 })
  })

  it('compares within a tolerance without leaving the decimal world', () => {
    expect(withinTolerance(dec('147.300'), dec('147.302'), dec('0.005'))).toBe(true)
    expect(withinTolerance(dec('147.300'), dec('147.310'), dec('0.005'))).toBe(false)
  })
})

describe('dates', () => {
  it('keeps an Indian trade date on its own calendar day', () => {
    const parsed = parseDate('01-Jan-2024', 'dd-MMM-yyyy', 'Asia/Kolkata')
    expect(parsed.ok && parsed.value.at).toBe('2024-01-01T00:00:00+05:30')
    // The whole point: a UTC wall clock would say 2023-12-31 and report the trade a day early.
    expect(parsed.ok && parsed.value.date).toBe('2024-01-01')
  })

  it('is strict about the format it was given', () => {
    expect(parseDate('1-Jan-2024', 'dd-MMM-yyyy', 'Asia/Kolkata').ok).toBe(false)
    expect(parseDate('31-Feb-2024', 'dd-MMM-yyyy', 'Asia/Kolkata').ok).toBe(false)
  })
})

describe('text repair', () => {
  it('undoes bold glyph doubling', () => {
    expect(undouble('TTrraannssaaccttiioonn')).toBe('Transaction')
    expect(undouble('AABB')).toBe('AB')
    // A legitimate double letter is left alone.
    expect(undouble('BALL')).toBe('BALL')
  })

  it('rejoins issuer letter-spacing', () => {
    expect(rejoinLetterSpacing('S ystematic Investment')).toBe('Systematic Investment')
    expect(rejoinLetterSpacing('S T P In')).toBe('STP In')
    expect(rejoinLetterSpacing('I DCW Reinvestment')).toBe('IDCW Reinvestment')
  })

  it('finds an ISIN glued to a folio number', () => {
    expect(findIsin('910124242826/0INF846K01859')).toBe('INF846K01859')
  })
})

describe('transaction classification', () => {
  const cases: [string, 'positive' | 'negative' | 'none', string][] = [
    ['SIP Purchase', 'positive', 'buy'],
    ['Purchase-SIP (ECS) - Instalment 100/156', 'positive', 'buy'],
    ['S ystematic Investment (12/60)', 'positive', 'buy'],
    ['Sys. Investment (8/1000)', 'positive', 'buy'],
    ['S T P In', 'positive', 'transfer_in'],
    ['Switch Out', 'negative', 'transfer_out'],
    ['R edemption', 'negative', 'sell'],
    ['Redemption - Reversal', 'negative', 'sell'],
    ['Gift Received', 'positive', 'transfer_in'],
    ['*** IDCW Reinvestment @ Rs.1.50 per unit ***', 'positive', 'dividend'],
  ]

  for (const [description, units, expected] of cases) {
    it(`classifies ${JSON.stringify(description)} as ${expected}`, () => {
      const result = classifyDescription(description, units, true)
      expect(result.kind === 'transaction' && result.type).toBe(expected)
    })
  }

  it('emits a purchase alongside a reinvested dividend', () => {
    const result = classifyDescription('*** IDCW Reinvestment @ Rs.1.50 per unit ***', 'positive', true)
    expect(result.kind === 'transaction' && result.alsoBuy).toBe(true)
  })

  it('skips a non-financial event rather than failing it', () => {
    expect(classifyDescription('Address Updated', 'none', false).kind).toBe('event')
  })

  it('recognises a levy so it can be folded', () => {
    expect(classifyDescription('*** Stamp Duty ***', 'none', true)).toEqual({
      kind: 'levy',
      bucket: 'stampDuty',
    })
  })
})

describe('the natural key', () => {
  const base = {
    kind: 'transaction' as const,
    accountId: 'a1',
    instrumentId: 'i1',
    accountKey: 'k',
    instrument: { name: 'x' },
    txnType: 'buy' as const,
    occurredAt: '2024-01-01T00:00:00+05:30',
    occurredDate: '2024-01-01',
    occurredTz: 'Asia/Kolkata',
    currency: 'INR',
    authority: 'primary' as const,
    fees: {
      brokerage: '0',
      stt: '0',
      gst: '0',
      stampDuty: '0',
      other: '0',
      tds: '0',
    },
    origin: { ref: 'row 1', raw: {} },
  } as unknown as ResolvedTransaction

  it('ignores the scale a source printed a quantity at', () => {
    expect(trimTrailingZeros(dec('10.000'))).toBe('10')
    expect(trimTrailingZeros(dec('10.500'))).toBe('10.5')
    const a = { ...base, quantity: { value: dec('10.000'), scale: 3 } }
    const b = { ...base, quantity: { value: dec('10'), scale: 0 } }
    expect(naturalKeyInput(a)).toBe(naturalKeyInput(b))
  })

  it('uses the local calendar date, not the UTC instant', () => {
    const txn = { ...base, quantity: { value: dec('10'), scale: 0 } }
    expect(naturalKeyInput(txn)).toContain('2024-01-01')
    expect(naturalKeyInput(txn)).not.toContain('T00:00:00')
  })

  it('serialises a missing amount as empty, not as zero', () => {
    const withoutAmount = { ...base, quantity: { value: dec('10'), scale: 0 } }
    const withZero = { ...withoutAmount, amountMinor: '0' } as unknown as ResolvedTransaction
    expect(naturalKeyInput(withoutAmount)).not.toBe(naturalKeyInput(withZero))
  })
})
