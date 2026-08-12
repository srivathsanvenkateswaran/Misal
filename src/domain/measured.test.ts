import { describe, expect, it } from 'vitest'
import {
  type Measured,
  coveragePercent,
  excludedValue,
  fullCoverage,
  isComplete,
  mapMeasured,
  measured,
  notMeasured,
  partialCoverage,
  zipMeasured,
} from './measured'
import { type Dec, dec, minor } from './numeric'

const TOTAL = minor('483215000') // Rs 48,32,150.00
const LEDGER = minor('347372200') // Rs 34,73,722.00 backed by transaction history

describe('coveragePercent', () => {
  it('matches the figure shown in the approved design', () => {
    // The calibration bar in the mockup reads 71.9% ledger-backed.
    expect(coveragePercent(partialCoverage(LEDGER, TOTAL, ['etrade']))).toBe('71.8')
  })

  it('reports full coverage as 100.0', () => {
    expect(coveragePercent(fullCoverage(TOTAL))).toBe('100.0')
  })

  it('does not divide by zero on an empty portfolio', () => {
    expect(coveragePercent(fullCoverage(minor('0')))).toBe('0.0')
  })
})

describe('coverage', () => {
  it('reports the exact excluded amount, since the UI displays it', () => {
    const c = partialCoverage(LEDGER, TOTAL, ['etrade'])
    expect(excludedValue(c)).toBe('135842800') // Rs 13,58,428.00
  })

  it('refuses coverage greater than the total', () => {
    expect(() => partialCoverage(TOTAL, LEDGER, [])).toThrow(/exceeds total/)
  })

  it('knows when a metric spans the whole portfolio', () => {
    expect(isComplete(fullCoverage(TOTAL))).toBe(true)
    expect(isComplete(partialCoverage(LEDGER, TOTAL, ['etrade']))).toBe(false)
  })
})

describe('Measured', () => {
  it('carries a value and its coverage when measured', () => {
    const m = measured(dec('18.42'), partialCoverage(LEDGER, TOTAL, ['etrade']))
    expect(m.measured).toBe(true)
    if (!m.measured) throw new Error('unreachable')
    expect(m.value).toBe('18.42')
    expect(coveragePercent(m.coverage)).toBe('71.8')
  })

  it('carries a reason and the excluded amount when not measured', () => {
    const m = notMeasured<Dec>('no_transaction_history', minor('135842800'))
    expect(m.measured).toBe(false)
    if (m.measured) throw new Error('unreachable')
    expect(m.reason).toBe('no_transaction_history')
    expect(m.excluded).toBe('135842800')
  })

  it('has no value field at all on the unmeasured branch', () => {
    // The type system prevents reading `.value` without narrowing. This asserts the runtime
    // shape agrees, so a structural consumer such as JSON serialisation cannot resurrect a
    // zero from an absent field.
    const m = notMeasured<Dec>('no_price', minor('0'))
    expect('value' in m).toBe(false)
  })

  it('propagates the unmeasured branch through map', () => {
    const m: Measured<Dec> = notMeasured('no_convergence', minor('500'))
    const mapped = mapMeasured(m, (d) => dec(`${d}0`))
    expect(mapped.measured).toBe(false)
  })

  it('is measured under zip only when both inputs are', () => {
    const a = measured(dec('1'), fullCoverage(TOTAL))
    const b = notMeasured<Dec>('no_fx_rate', minor('100'))
    expect(zipMeasured(a, b, (x, y) => dec(`${x}${y}`)).measured).toBe(false)
    expect(zipMeasured(a, a, (x) => x).measured).toBe(true)
  })

  it('takes the narrower coverage when combining two measured values', () => {
    const wide = measured(dec('1'), fullCoverage(TOTAL))
    const narrow = measured(dec('2'), partialCoverage(LEDGER, TOTAL, ['etrade']))
    const combined = zipMeasured(wide, narrow, (a, b) => dec(`${a}${b}`))
    if (!combined.measured) throw new Error('unreachable')
    // A combined metric can be no more trustworthy than its least-covered input.
    expect(combined.coverage.covered).toBe(LEDGER)
    expect(combined.coverage.excludedAccounts).toEqual(['etrade'])
  })
})
