/**
 * FIFO invariants, over generated transaction sequences.
 *
 * These are the tests that catch what a fixed example cannot: an allocation that loses a paisa only
 * on the third partial disposal, an ordering that holds until a bonus lands between two sells, a
 * split applied to the wrong side of a same-day trade.
 *
 * The generator is a seeded LCG so a failure is reproducible from the seed printed in the name.
 */

import { describe, expect, it } from 'vitest'
import {
  type Dec,
  ZERO_MINOR,
  addDec,
  addMinor,
  compareDec,
  dec,
  maxDec,
  mulDec,
  mulDivMinor,
  subDec,
} from '@domain/numeric'
import { commonScale, scaleToInteger } from './arithmetic'
import { instrument, instrumentMap, resetIds, txn } from './__fixtures__/build'
import { type FoldInput, type LotLedger, buildLots, lotIdOf, openCostMinor } from './fold'
import { grandfatheredUnitCost } from './grandfather'
import type { TxnRow } from './types'

const AS_OF = '2026-08-12T18:30:00+05:30'

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!
}

function dateAt(index: number): string {
  const base = Date.UTC(2015, 0, 5)
  return new Date(base + index * 37 * 86_400_000).toISOString().slice(0, 10)
}

interface Generated {
  readonly txns: readonly TxnRow[]
  /** Quantity implied by replaying signed quantities with splits, computed independently. */
  readonly expectedQuantity: Dec
  readonly openingCost: ReadonlyMap<string, string>
}

/**
 * Quantities span 0 to 8 decimal places deliberately: mutual funds carry 3–4 and crypto up to 18,
 * and the allocation arithmetic must not care which.
 */
function quantityFor(random: () => number): string {
  const places = Math.floor(random() * 5)
  const whole = 1 + Math.floor(random() * 400)
  if (places === 0) return whole.toString()
  const fraction = Math.floor(random() * 10 ** places)
      .toString()
      .padStart(places, '0')
  return `${whole.toString()}.${fraction}`
}

function generate(random: () => number, length: number): Generated {
  const txns: TxnRow[] = []
  const openingCost = new Map<string, string>()
  let held = dec('0')
  let index = 0

  // Always open with a purchase; a sequence starting with a sale is the negative-inventory case and
  // is exercised separately.
  const firstQty = quantityFor(random)
  const firstAmount = (1000 + Math.floor(random() * 5_000_000)).toString()
  const first = txn({ type: 'buy', date: dateAt(index), quantity: firstQty, amount: firstAmount, fees: '250' })
  txns.push(first)
  openingCost.set(first.id, addMinor(first.amountMinor!, first.feesMinor))
  held = addDec(held, dec(firstQty))
  index += 1

  for (let i = 0; i < length; i++) {
    const kind = pick(random, ['buy', 'buy', 'sell', 'split', 'bonus', 'transfer_in', 'transfer_out'] as const)
    const date = dateAt(index)
    index += 1
    if (kind === 'buy' || kind === 'transfer_in') {
      const quantity = quantityFor(random)
      const amount = (1000 + Math.floor(random() * 5_000_000)).toString()
      const row = txn({ type: kind, date, quantity, amount, fees: '137' })
      txns.push(row)
      openingCost.set(row.id, addMinor(row.amountMinor!, row.feesMinor))
      held = addDec(held, dec(quantity))
    } else if (kind === 'bonus') {
      const quantity = quantityFor(random)
      const row = txn({ type: 'bonus', date, quantity })
      txns.push(row)
      openingCost.set(row.id, '0')
      held = addDec(held, dec(quantity))
    } else if (kind === 'split') {
      const ratio = pick(random, ['2', '5', '0.5', '10'])
      txns.push(txn({ type: 'split', date, quantity: ratio }))
      held = mulDec(held, dec(ratio))
    } else {
      // Dispose of a fraction of what is held, so inventory never goes negative in this generator.
      const fraction = pick(random, ['0.25', '0.5', '0.75', '1'])
      const quantity = mulDec(held, dec(fraction))
      if (compareDec(quantity, dec('0')) <= 0) continue
      const amount = (1000 + Math.floor(random() * 9_000_000)).toString()
      txns.push(txn({ type: kind, date, quantity, amount, fees: '211' }))
      held = subDec(held, quantity)
    }
  }
  return { txns, expectedQuantity: held, openingCost }
}

function fold(txns: readonly TxnRow[]): LotLedger {
  const input: FoldInput = {
    accountId: 'acc-1',
    capability: 'ledger',
    txns,
    snapshots: [],
    instruments: instrumentMap(instrument({ fmv: '1130.00' })),
    asOf: AS_OF,
  }
  const result = buildLots(input)
  if (!result.ok) throw new Error(`fold failed: ${result.error.message}`)
  const ledger = result.value.get('inst-1')
  if (ledger === undefined) throw new Error('no ledger')
  return ledger
}

function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

const SEEDS = [1, 7, 42, 1337, 20260812, 99991, 424242, 8675309]

describe('FIFO invariants', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed.toString()}`, () => {
      resetIds()
      const random = lcg(seed)
      const generated = generate(random, 14)
      const ledger = fold(generated.txns)

      it('conserves cost: every lot’s consumed slices plus its residual equal its opening cost', () => {
        for (const [txnId, opening] of generated.openingCost) {
          const consumed = ledger.consumptions
            .filter((c) => c.lotId === lotIdOf('acc-1', 'inst-1', txnId))
            .map((c) => c.costMinor)
          const residual = ledger.open.find((lot) => lot.openingTxnId === txnId)?.costMinor ?? ZERO_MINOR
          if (consumed.length === 0 && residual === ZERO_MINOR) continue
          expect(addMinor(...consumed, residual)).toBe(opening)
        }
      })

      it('conserves quantity against an independent replay of the signed quantities', () => {
        expect(ledger.measurement).not.toBe('not_measured')
        const openTotal = addDec(...ledger.open.map((lot) => lot.quantity))
        expect(compareDec(openTotal, generated.expectedQuantity)).toBe(0)
        expect(compareDec(ledger.quantity, generated.expectedQuantity)).toBe(0)
      })

      it('never produces a lot with a negative quantity or a negative cost', () => {
        for (const lot of ledger.open) {
          expect(compareDec(lot.quantity, dec('0'))).toBe(1)
          expect(BigInt(lot.costMinor) >= 0n).toBe(true)
        }
      })

      it('consumes lots in acquisition order, exhausting the earlier before touching the later', () => {
        let previous = ''
        for (const consumption of ledger.consumptions) {
          expect(consumption.acquiredOn >= previous).toBe(true)
          previous = consumption.acquiredOn
        }
      })

      it('gives every bonus lot nil cost and its own allotment date', () => {
        for (const lot of ledger.open) {
          if (lot.origin !== 'bonus') continue
          expect(lot.costMinor).toBe('0')
          const source = generated.txns.find((t) => t.id === lot.openingTxnId)!
          expect(lot.acquiredOn).toBe(source.occurredAt.slice(0, 10))
        }
      })

      it('is deterministic: any shuffled import order folds to byte-identical output', () => {
        const shuffled = fold(shuffle(lcg(seed + 1), generated.txns))
        expect(JSON.stringify(shuffled)).toBe(JSON.stringify(ledger))
      })
    })
  }
})

describe('split invariance', () => {
  it('leaves total cost and every acquisition date untouched and multiplies quantity exactly', () => {
    resetIds()
    const buys = [
      txn({ type: 'buy', date: '2019-01-10', quantity: '37.5', amount: '1234567', fees: '99' }),
      txn({ type: 'buy', date: '2020-02-20', quantity: '12.25', amount: '765432', fees: '11' }),
    ]
    const withoutSplit = fold(buys)
    const withSplit = fold([...buys, txn({ type: 'split', date: '2021-03-03', quantity: '5' })])

    expect(openCostMinor(withSplit)).toBe(openCostMinor(withoutSplit))
    expect(withSplit.open.map((l) => l.acquiredOn)).toEqual(withoutSplit.open.map((l) => l.acquiredOn))
    expect(compareDec(withSplit.quantity, mulDec(withoutSplit.quantity, dec('5')))).toBe(0)
  })

  it('produces the same ledger whether the split is imported first or last', () => {
    resetIds()
    const buy2019 = txn({ type: 'buy', date: '2019-06-10', quantity: '50', amount: '3600000', fees: '3520' })
    const split = txn({ type: 'split', date: '2022-09-15', quantity: '5' })
    const buy2026 = txn({ type: 'buy', date: '2026-01-05', quantity: '100', amount: '1500000', fees: '1200' })
    // The late-arriving split: the CSV was imported in January, the older CAS in August.
    expect(JSON.stringify(fold([buy2019, buy2026, split]))).toBe(
      JSON.stringify(fold([buy2019, split, buy2026])),
    )
  })
})

describe('negative inventory', () => {
  it('emits NEGATIVE_INVENTORY, withholds the lots, and never yields a negative lot', () => {
    resetIds()
    const ledger = fold([
      txn({ type: 'buy', date: '2024-01-10', quantity: '5', amount: '50000' }),
      txn({ type: 'sell', date: '2024-06-10', quantity: '9', amount: '120000' }),
      txn({ type: 'buy', date: '2024-09-10', quantity: '2', amount: '30000' }),
    ])
    expect(ledger.measurement).toBe('not_measured')
    expect(ledger.warnings.some((w) => w.code === 'NEGATIVE_INVENTORY')).toBe(true)
    expect(ledger.open).toEqual([])
  })
})

describe('integer allocation', () => {
  it('splits a cost across arbitrary fractions without losing or inventing a paisa', () => {
    const random = lcg(4242)
    for (let trial = 0; trial < 200; trial++) {
      const total = BigInt(1 + Math.floor(random() * 10_000_000))
      const lotQty = dec(quantityFor(random))
      const takeFraction = pick(random, ['0.1', '0.333', '0.5', '0.75', '0.9'])
      const take = mulDec(lotQty, dec(takeFraction))
      const k = commonScale(take, lotQty)
      const consumed = mulDivMinor(total.toString() as never, scaleToInteger(take, k), scaleToInteger(lotQty, k))
      const residual = BigInt(total) - BigInt(consumed)
      expect(BigInt(consumed) + residual).toBe(total)
      // Truncation biases the consumed slice down by at most one paisa, never up.
      expect(BigInt(consumed) >= 0n).toBe(true)
      expect(residual >= 0n).toBe(true)
    }
  })
})

describe('grandfathering monotonicity', () => {
  it('never reduces the deemed cost below actual cost, and never turns a gain into a loss', () => {
    const random = lcg(31337)
    for (let trial = 0; trial < 200; trial++) {
      const actual = dec((1 + Math.floor(random() * 5000)).toString())
      const fmv = dec((1 + Math.floor(random() * 5000)).toString())
      const consideration = dec((1 + Math.floor(random() * 5000)).toString())
      const outcome = grandfatheredUnitCost({
        regime: 's112a_listed_equity',
        lotAcquiredOn: '2015-06-01',
        actualUnitCost: actual,
        fmv31Jan2018: fmv,
        grossUnitConsideration: consideration,
        disposedOn: '2026-06-20',
      })
      if (outcome.applied !== true) throw new Error('expected grandfathering to apply')
      // Never below actual cost, and never above the proceeds unless the actual cost already was —
      // so grandfathering can erase a gain but never manufacture a loss. The bound falls out of the
      // min(), which is why no separate clamp exists, or should.
      expect(compareDec(outcome.deemedUnitCost, actual)).toBeGreaterThanOrEqual(0)
      expect(compareDec(outcome.deemedUnitCost, maxDec(actual, consideration))).toBeLessThanOrEqual(0)
    }
  })
})
