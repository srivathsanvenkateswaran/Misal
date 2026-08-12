/**
 * Golden tests for the fold and for FIFO cost basis.
 *
 * The expected figures are the ones in the spec, which were produced by an exact-decimal script and
 * cross-checked against a hand-computed sheet. They are copied, never recomputed here: hand
 * arithmetic in a test file is how a wrong expectation gets baked in and then defended.
 */

import { describe, expect, it } from 'vitest'
import { addMinor, divDec, minorToDec } from '@domain/numeric'
import { roundDec } from './arithmetic'
import { instrument, instrumentMap, resetIds, snapshot, txn } from './__fixtures__/build'
import { type FoldInput, TYPE_RANK, buildLots, openCostMinor, sortTxns } from './fold'
import { derivePortfolioPositions, derivePositions } from './positions'
import { classifyDisposal } from './tax'
import type { LotLedger } from './fold'

const AS_OF = '2026-08-12T18:30:00+05:30'

function foldInput(txns: ReturnType<typeof txn>[], overrides: Partial<FoldInput> = {}): FoldInput {
  return {
    accountId: 'acc-1',
    capability: 'ledger',
    txns,
    snapshots: [],
    instruments: instrumentMap(instrument({ fmv: '1130.00' })),
    asOf: AS_OF,
    ...overrides,
  }
}

function ledgerOf(input: FoldInput, instrumentId = 'inst-1'): LotLedger {
  const result = buildLots(input)
  if (!result.ok) throw new Error(`fold failed: ${result.error.message}`)
  const ledger = result.value.get(instrumentId)
  if (ledger === undefined) throw new Error('no ledger for instrument')
  return ledger
}

describe('fold ordering', () => {
  it('ranks corporate actions before the same day trades', () => {
    // From the ex-date onward statements quote adjusted quantities, so a buy on the ex-date is
    // already in post-split terms and must not be adjusted again.
    expect(TYPE_RANK.split).toBeLessThan(TYPE_RANK.buy)
    expect(TYPE_RANK.bonus).toBeLessThan(TYPE_RANK.buy)
    expect(TYPE_RANK.buy).toBeLessThan(TYPE_RANK.sell)
    expect(TYPE_RANK.sell).toBeLessThan(TYPE_RANK.transfer_out)
    expect(TYPE_RANK.transfer_out).toBeLessThan(TYPE_RANK.fee)
  })

  it('sorts by local calendar day, not by UTC instant', () => {
    resetIds()
    // 2022-09-15 23:30 IST is 18:00 UTC on the 15th; a naive UTC date would still be the 15th, but
    // 00:30 IST on the 16th is 19:00 UTC on the 15th and would move a day backwards.
    const late = txn({ type: 'buy', date: '2022-09-16', quantity: '1', amount: '100' })
    const early = txn({ type: 'buy', date: '2022-09-15', quantity: '1', amount: '100' })
    const ordered = sortTxns([late, early])
    expect(ordered.map((o) => o.date)).toEqual(['2022-09-15', '2022-09-16'])
  })
})

describe('worked example: FIFO with a partial disposal and grandfathering', () => {
  const txns = [
    txn({ type: 'buy', date: '2017-03-15', quantity: '100', price: '500.00', fees: '4000', amount: '5000000' }),
    txn({ type: 'buy', date: '2019-06-10', quantity: '50', price: '720.00', fees: '3520', amount: '3600000' }),
    txn({ type: 'sell', date: '2026-06-20', quantity: '120', price: '1540.00', fees: '18000', amount: '18480000' }),
  ]

  it('opens lots at amount plus capitalised fees', () => {
    resetIds()
    const ledger = ledgerOf(foldInput([txns[0]!, txns[1]!]))
    expect(ledger.open.map((lot) => [lot.acquiredOn, lot.quantity, lot.costMinor])).toEqual([
      ['2017-03-15', '100', '5004000'],
      ['2019-06-10', '50', '3603520'],
    ])
  })

  it('leaves one lot of 30 units at 2162112 paise, with the unit cost unchanged', () => {
    const ledger = ledgerOf(foldInput(txns))
    expect(ledger.open).toHaveLength(1)
    const lot = ledger.open[0]!
    expect(lot.quantity).toBe('30')
    expect(lot.costMinor).toBe('2162112')
    // ₹720.704, exactly as before the partial disposal: truncating allocation moves cost between
    // slices, never into or out of the lot.
    expect(divDec(minorToDec(lot.costMinor, 'INR'), lot.quantity)).toBe('720.704')
  })

  it('allocates consumed and residual cost so they sum to the original exactly', () => {
    const ledger = ledgerOf(foldInput(txns))
    const lotB = ledger.consumptions.find((c) => c.acquiredOn === '2019-06-10')!
    expect(lotB.costMinor).toBe('1441408')
    expect(addMinor(lotB.costMinor, ledger.open[0]!.costMinor)).toBe('3603520')
  })

  it('apportions gross consideration and transfer expenses pro rata by units', () => {
    const ledger = ledgerOf(foldInput(txns))
    const [lotA, lotB] = ledger.consumptions
    expect(lotA!.grossConsiderationMinor).toBe('15400000')
    expect(lotA!.transferExpensesMinor).toBe('15000')
    expect(lotB!.grossConsiderationMinor).toBe('3080000')
    expect(lotB!.transferExpensesMinor).toBe('3000')
  })

  it('grandfathers the pre-2018 lot and not the post-2018 one', () => {
    const ledger = ledgerOf(foldInput(txns))
    const inst = instrument({ fmv: '1130.00' })
    const disposals = ledger.consumptions.map((c) => classifyDisposal(c, inst)!)

    const [lotA, lotB] = disposals
    expect(lotA!.grandfathered).toBe(true)
    expect(lotA!.deemedCost.measured && lotA!.deemedCost.value).toBe('11300000')
    expect(lotA!.gain.measured && lotA!.gain.value).toBe('4085000')
    expect(lotA!.bucket).toEqual({ kind: 'ltcg', regime: 's112a_listed_equity' })

    expect(lotB!.grandfathered).toBe(false)
    expect(lotB!.deemedCost.measured && lotB!.deemedCost.value).toBe('1441408')
    expect(lotB!.gain.measured && lotB!.gain.value).toBe('1635592')
    expect(lotB!.bucket).toEqual({ kind: 'ltcg', regime: 's112a_listed_equity' })

    // Realised LTCG ₹57,205.92 in total.
    const total = disposals.reduce(
      (acc, d) => (d.gain.measured ? addMinor(acc, d.gain.value) : acc),
      '0' as ReturnType<typeof addMinor>,
    )
    expect(total).toBe('5720592')
    expect(disposals[0]!.financialYear).toBe('FY2026-27')
  })

  it('withholds the gain instead of falling back to actual cost when the FMV is missing', () => {
    // Falling back would overstate the taxable gain by the whole 2001–2018 appreciation.
    const ledger = ledgerOf(foldInput(txns))
    const noFmv = instrument({})
    const lotA = classifyDisposal(ledger.consumptions[0]!, noFmv)!
    expect(lotA.bucket).toEqual({ kind: 'unavailable', reason: 'GRANDFATHER_FMV_UNAVAILABLE' })
    expect(lotA.gain.measured).toBe(false)
    expect(lotA.deemedCost.measured).toBe(false)
  })
})

describe('worked example: split, then bonus', () => {
  const txns = [
    txn({ type: 'buy', date: '2019-06-10', quantity: '50', price: '720.00', fees: '3520', amount: '3600000' }),
    txn({ type: 'split', date: '2022-09-15', quantity: '5' }),
    txn({ type: 'buy', date: '2022-09-15', quantity: '100', price: '150.00', fees: '1200', amount: '1500000' }),
    txn({ type: 'bonus', date: '2023-03-10', quantity: '250' }),
  ]

  it('multiplies the pre-split lot, leaves its cost and date alone, and does not touch the same-day buy', () => {
    resetIds()
    const ledger = ledgerOf(foldInput(txns))
    expect(
      ledger.open.map((lot) => [lot.acquiredOn, lot.quantity, lot.costMinor, lot.origin]),
    ).toEqual([
      ['2019-06-10', '250', '3603520', 'buy'],
      ['2022-09-15', '100', '1501200', 'buy'],
      ['2023-03-10', '250', '0', 'bonus'],
    ])
  })

  it('totals 600 units at ₹51,047.20 with a weighted average unit cost of 85.0787', () => {
    const ledger = ledgerOf(foldInput(txns))
    expect(ledger.quantity).toBe('600')
    expect(openCostMinor(ledger)).toBe('5104720')
    const weightedAverage = divDec(minorToDec(openCostMinor(ledger), 'INR'), ledger.quantity)
    expect(roundDec(weightedAverage, 4)).toBe('85.0787')
  })

  it('gives the bonus lot nil cost and its own allotment date', () => {
    const ledger = ledgerOf(foldInput(txns))
    const bonus = ledger.open.find((lot) => lot.origin === 'bonus')!
    expect(bonus.costMinor).toBe('0')
    expect(bonus.acquiredOn).toBe('2023-03-10')
    expect(bonus.costKnown).toBe(true)
  })

  it('produces the same ledger whichever order the transactions are imported in', () => {
    // The late-arriving-split guarantee: the fold is a pure function of the whole set.
    const inOrder = ledgerOf(foldInput(txns))
    const shuffled = ledgerOf(foldInput([txns[3]!, txns[2]!, txns[0]!, txns[1]!]))
    expect(shuffled).toEqual(inOrder)
  })
})

describe('ledger defects', () => {
  it('withholds everything for the pair when inventory goes negative, and never emits a negative lot', () => {
    resetIds()
    const input = foldInput([
      txn({ type: 'buy', date: '2024-01-10', quantity: '10', amount: '100000' }),
      txn({ type: 'sell', date: '2024-03-10', quantity: '25', amount: '300000' }),
    ])
    const ledger = ledgerOf(input)
    expect(ledger.measurement).toBe('not_measured')
    expect(ledger.reason?.code).toBe('NEGATIVE_INVENTORY')
    expect(ledger.open).toEqual([])
    // The sale is real; the missing purchase is the defect, so the signed quantity is kept.
    expect(ledger.quantity).toBe('-15')
  })

  it('marks an unpriced transfer_in partially measured and keeps the quantity', () => {
    resetIds()
    const ledger = ledgerOf(
      foldInput([txn({ type: 'transfer_in', date: '2022-04-01', quantity: '40' })]),
    )
    expect(ledger.measurement).toBe('partially_measured')
    expect(ledger.reason?.code).toBe('MISSING_ACQUISITION_COST')
    expect(ledger.reason?.userFixable).toBe(true)
    expect(ledger.open[0]!.costKnown).toBe(false)
    expect(ledger.quantity).toBe('40')
  })
})

describe('reconciliation against snapshot rows', () => {
  it('names double adjustment when the disagreement equals a corporate-action ratio', () => {
    resetIds()
    // The CAS restates the 2019 purchase in post-split units *and* reports the split, so the fold
    // multiplies an already multiplied quantity.
    const input = foldInput(
      [
        txn({ type: 'buy', date: '2019-06-10', quantity: '250', price: '144.14', amount: '3603500' }),
        txn({ type: 'split', date: '2022-09-15', quantity: '5' }),
      ],
      { snapshots: [snapshot('inst-1', '250', '2026-08-01')] },
    )
    const derived = derivePositions(input)
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const position = derived.value[0]!
    expect(position.measurement).toBe('not_measured')
    expect(position.reason?.code).toBe('FOLD_SNAPSHOT_MISMATCH')
    expect(position.reason?.message).toContain('applied twice')
    // Quantity is reported from the corroborated snapshot; cost basis is withheld.
    expect(position.quantity).toBe('250')
    expect(position.lots).toEqual([])
  })

  it('compares as at the snapshot’s own date, so a later trade is not a mismatch', () => {
    resetIds()
    // A statement balance from 1 August says nothing about a purchase made on 5 August. Comparing
    // it against today's folded quantity would report every recently traded holding as broken.
    const input = foldInput(
      [
        txn({ type: 'buy', date: '2024-01-10', quantity: '10', amount: '100000' }),
        txn({ type: 'buy', date: '2026-08-05', quantity: '7', amount: '90000' }),
      ],
      { snapshots: [snapshot('inst-1', '10', '2026-08-01')] },
    )
    const derived = derivePositions(input)
    if (!derived.ok) throw new Error('unexpected error')
    expect(derived.value[0]!.reconciliation?.agrees).toBe(true)
    expect(derived.value[0]!.measurement).toBe('measured')
    expect(derived.value[0]!.quantity).toBe('17')
  })

  it('accepts a difference within one display step', () => {
    resetIds()
    const input = foldInput(
      [txn({ type: 'buy', date: '2024-01-10', quantity: '10.0001', amount: '100000' })],
      { snapshots: [snapshot('inst-1', '10.0000', '2026-08-01')] },
    )
    const derived = derivePositions(input)
    if (!derived.ok) throw new Error('unexpected error')
    expect(derived.value[0]!.reconciliation?.agrees).toBe(true)
    expect(derived.value[0]!.measurement).toBe('measured')
  })
})

describe('snapshot accounts', () => {
  it('never manufactures a cost basis from an observed quantity', () => {
    resetIds()
    const derived = derivePositions({
      accountId: 'acc-2',
      capability: 'snapshot',
      txns: [],
      snapshots: [snapshot('inst-1', '12.3450', '2026-08-01', 'acc-2')],
      instruments: instrumentMap(instrument()),
      asOf: AS_OF,
    })
    if (!derived.ok) throw new Error('unexpected error')
    const position = derived.value[0]!
    expect(position.basis).toBe('snapshot')
    expect(position.measurement).toBe('not_measured')
    expect(position.reason?.code).toBe('SNAPSHOT_ACCOUNT')
    expect(position.reason?.userFixable).toBe(false)
    expect(position.lots).toEqual([])
    expect(position.quantity).toBe('12.3450')
  })
})

describe('corporate actions recorded per account', () => {
  it('downgrades an account that held across an ex-date without the action row', () => {
    resetIds()
    const instruments = instrumentMap(instrument())
    const withSplit: FoldInput = {
      accountId: 'acc-1',
      capability: 'ledger',
      txns: [
        txn({ type: 'buy', date: '2021-01-04', quantity: '10', amount: '100000' }),
        txn({ type: 'split', date: '2022-09-15', quantity: '5' }),
      ],
      snapshots: [],
      instruments,
      asOf: AS_OF,
    }
    const withoutSplit: FoldInput = {
      accountId: 'acc-2',
      capability: 'ledger',
      txns: [
        txn({ type: 'buy', date: '2021-02-04', quantity: '20', amount: '200000', accountId: 'acc-2' }),
      ],
      snapshots: [],
      instruments,
      asOf: AS_OF,
    }
    const derived = derivePortfolioPositions([withSplit, withoutSplit])
    if (!derived.ok) throw new Error('unexpected error')
    const second = derived.value.find((p) => p.accountId === 'acc-2')!
    expect(second.measurement).toBe('not_measured')
    expect(second.reason?.code).toBe('CORPORATE_ACTION_MISSING_IN_ACCOUNT')
    expect(second.quantitySuspect).toBe(true)
    expect(derived.value.find((p) => p.accountId === 'acc-1')!.measurement).toBe('measured')
  })

  it('leaves an account alone when it held nothing across the ex-date', () => {
    resetIds()
    const instruments = instrumentMap(instrument())
    const derived = derivePortfolioPositions([
      {
        accountId: 'acc-1',
        capability: 'ledger',
        txns: [
          txn({ type: 'buy', date: '2021-01-04', quantity: '10', amount: '100000' }),
          txn({ type: 'split', date: '2022-09-15', quantity: '5' }),
        ],
        snapshots: [],
        instruments,
        asOf: AS_OF,
      },
      {
        accountId: 'acc-2',
        capability: 'ledger',
        txns: [
          txn({ type: 'buy', date: '2023-02-04', quantity: '20', amount: '200000', accountId: 'acc-2' }),
        ],
        snapshots: [],
        instruments,
        asOf: AS_OF,
      },
    ])
    if (!derived.ok) throw new Error('unexpected error')
    expect(derived.value.find((p) => p.accountId === 'acc-2')!.measurement).toBe('measured')
  })
})
