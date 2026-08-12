/**
 * Coverage arithmetic. These figures are displayed prominently, so they are exact or they are null.
 */

import { describe, expect, it } from 'vitest'
import { addMinor, minor, subMinor } from '@domain/numeric'
import { coverageReport, historyCoveragePct, metricCoverage } from './coverage'
import type { MeasurementReason } from './types'

const REASON: MeasurementReason = {
  status: 'not_measured',
  code: 'SNAPSHOT_ACCOUNT',
  message: 'snapshot account',
  userFixable: false,
}

describe('historyCoveragePct', () => {
  it('reads 100.00 only when the two figures are exactly equal', () => {
    expect(historyCoveragePct(minor('4000000'), minor('4000000'))).toBe('100.00')
  })

  it('reads 99.99, not 100.00, when a single paisa is unmeasured', () => {
    // A bar reading "100% covered" with ₹400 of a ₹40 lakh portfolio unmeasured is a lie by
    // rounding, and it is the fastest way to lose the user's trust in the whole feature.
    expect(historyCoveragePct(minor('399999999'), minor('400000000'))).toBe('99.99')
    expect(historyCoveragePct(minor('39999'), minor('40000'))).toBe('99.99')
  })

  it('reads 0.00 only when nothing at all is measured, and floors at 0.01 otherwise', () => {
    expect(historyCoveragePct(minor('0'), minor('400000000'))).toBe('0.00')
    expect(historyCoveragePct(minor('1'), minor('400000000'))).toBe('0.01')
  })

  it('returns null, not 0, when there is nothing to cover', () => {
    expect(historyCoveragePct(minor('0'), minor('0'))).toBeNull()
  })

  it('is value-weighted, not count-weighted', () => {
    // Forty small ledger holdings and one large snapshot holding is low coverage, whatever the
    // count says.
    expect(historyCoveragePct(minor('2000000'), minor('10000000'))).toBe('20.00')
  })
})

describe('metric coverage', () => {
  it('reconciles: covered plus every excluded pair equals the total', () => {
    const total = minor('10000000')
    const coverage = metricCoverage({
      metric: 'cost_basis',
      included: [{ valueMinor: minor('6000000') }, { valueMinor: minor('1000000') }],
      excluded: [
        { accountId: 'a', instrumentId: 'i1', valueMinor: minor('2500000'), reason: REASON },
        { accountId: 'a', instrumentId: 'i2', valueMinor: minor('500000'), reason: REASON },
      ],
      totalMinor: total,
    })
    expect(coverage.coveredMinor).toBe('7000000')
    expect(coverage.excludedValueMinor).toBe('3000000')
    expect(addMinor(coverage.coveredMinor, coverage.excludedValueMinor)).toBe(total)
    expect(coverage.pct).toBe('70.00')
  })

  it('names every exclusion with a reason the UI can sort by fixability', () => {
    const coverage = metricCoverage({
      metric: 'xirr',
      included: [],
      excluded: [{ accountId: 'a', instrumentId: 'i1', valueMinor: minor('1'), reason: REASON }],
      totalMinor: minor('1'),
    })
    expect(coverage.excludedPairs[0]!.reason.userFixable).toBe(false)
    expect(coverage.pct).toBe('0.00')
  })
})

describe('coverage report', () => {
  it('computes the unmeasured segment by subtraction so the bar has no rounding gap', () => {
    const valued = minor('123456789')
    const measured = minor('99999999')
    const report = coverageReport({
      asOf: '2026-08-12T18:30:00+05:30',
      breakdown: {
        valuedMinor: valued,
        withheldMinor: minor('4500000'),
        unpricedCount: 2,
        unpricedInstrumentIds: ['i9', 'i8'],
      },
      measuredMinor: measured,
      perMetric: [],
      stalePriceCount: 1,
      stalestPriceAgeDays: 9,
      unresolvedInstrumentCount: 3,
    })
    expect(addMinor(report.measuredMinor, report.unmeasuredMinor)).toBe(valued)
    expect(report.unmeasuredMinor).toBe(subMinor(valued, measured))
    // Withheld value is reported beside net worth, never inside it.
    expect(report.withheldMinor).toBe('4500000')
    expect(report.historyCoveragePct).toBe('80.99')
  })
})
