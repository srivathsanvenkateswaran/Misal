/**
 * Conformance tests for the shared transaction natural key.
 *
 * The first block is the one that matters: it computes a key through the statement-ingestion call
 * path and through the exchange-adapter call path for the same logical trade, and asserts they
 * match. Two independent implementations previously disagreed on four separate details, so the
 * same trade imported from a CSV and synced from the API produced different keys, both rows
 * landed, and the holding was counted twice in net worth. Nothing failed, because nothing
 * compared them. This is that comparison.
 */

import { describe, expect, it } from 'vitest'
import {
  NaturalKeyError,
  assignOccurrences,
  naturalKeyInput,
  trimTrailingZeros,
} from './natural-key'
import { naturalKeyInput as ingestionKeyInput } from '../ingestion/reconcile'
import { exchangeLocalDate } from '../adapters/sync/natural-key'
import { dec } from './numeric'
import type { ResolvedTransaction } from '../ingestion/types'

/** A statement row, as the ingestion pipeline would present it after resolution. */
function statementTxn(over: Partial<Record<string, unknown>> = {}): ResolvedTransaction {
  return {
    accountId: 'acct-1',
    instrumentId: 'inst-btc',
    txnType: 'buy',
    occurredDate: '2026-01-06',
    quantity: { value: dec('0.50000000') },
    amountMinor: '250000000',
    ...over,
  } as unknown as ResolvedTransaction
}

describe('both ingestion paths agree on the same logical trade', () => {
  it('produces an identical key from a statement row and an exchange fill', () => {
    // Same account, instrument, type, day, quantity and amount. A CSV export of this fill and an
    // API sync of it must deduplicate against each other.
    const fromStatement = ingestionKeyInput(statementTxn())

    const fromExchange = naturalKeyInput({
      accountId: 'acct-1',
      instrumentId: 'inst-btc',
      type: 'buy',
      occurredDate: exchangeLocalDate('2026-01-06T04:30:00.000Z'),
      quantity: dec('0.50000000'),
      amountMinor: '250000000',
    })

    expect(fromExchange).toBe(fromStatement)
  })

  it('still agrees when the two sources print the quantity at different scales', () => {
    // A statement printing 0.50000000 and an API returning 0.5 describe the same trade.
    const fromStatement = ingestionKeyInput(statementTxn({ quantity: { value: dec('0.50000000') } }))
    const fromExchange = naturalKeyInput({
      accountId: 'acct-1',
      instrumentId: 'inst-btc',
      type: 'buy',
      occurredDate: '2026-01-06',
      quantity: dec('0.5'),
      amountMinor: '250000000',
    })
    expect(fromExchange).toBe(fromStatement)
  })

  it('separates two fills that differ only by the exchange trade id', () => {
    // The same commission, same asset, same day, from two pages of one response is two real fees.
    const base = {
      accountId: 'acct-1',
      instrumentId: 'inst-btc',
      type: 'fee',
      occurredDate: '2026-01-06',
      quantity: dec('0.0001'),
      amountMinor: '500',
    }
    expect(naturalKeyInput({ ...base, externalId: '111' })).not.toBe(
      naturalKeyInput({ ...base, externalId: '222' }),
    )
  })

  it('keys a statement identically whether or not the field is present', () => {
    // Statements have no external id and pass nothing, so they must behave exactly as before.
    const absent = naturalKeyInput({
      accountId: 'a',
      instrumentId: 'i',
      type: 'buy',
      occurredDate: '2026-01-06',
      quantity: dec('1'),
      amountMinor: '100',
    })
    const explicitUndefined = naturalKeyInput({
      accountId: 'a',
      instrumentId: 'i',
      type: 'buy',
      occurredDate: '2026-01-06',
      quantity: dec('1'),
      amountMinor: '100',
      externalId: undefined,
    })
    expect(explicitUndefined).toBe(absent)
  })
})

describe('the date must be a local calendar date, not an instant', () => {
  it('refuses an ISO instant', () => {
    // The exact mistake the shared function exists to prevent. A UTC instant sliced by a caller
    // that did not think about it shifts every late-evening Indian trade by a day.
    expect(() =>
      naturalKeyInput({
        accountId: 'a',
        instrumentId: 'i',
        type: 'buy',
        occurredDate: '2026-01-06T20:30:00Z',
        quantity: dec('1'),
        amountMinor: '100',
      }),
    ).toThrow(NaturalKeyError)
  })

  it('demonstrates why the basis matters for an Indian evening trade', () => {
    // 02:00 on 6 January IST is 20:30 on 5 January UTC. A statement says the 6th; a naive UTC
    // slice says the 5th. Keys built on different bases can never match.
    const istLocalDate = '2026-01-06'
    const utcDateOfSameInstant = exchangeLocalDate('2026-01-05T20:30:00.000Z')
    expect(utcDateOfSameInstant).toBe('2026-01-05')

    const parts = {
      accountId: 'a',
      instrumentId: 'i',
      type: 'buy' as const,
      quantity: dec('1'),
      amountMinor: '100',
    }
    expect(naturalKeyInput({ ...parts, occurredDate: istLocalDate })).not.toBe(
      naturalKeyInput({ ...parts, occurredDate: utcDateOfSameInstant }),
    )
  })
})

describe('field encoding', () => {
  it('distinguishes a null amount from a zero amount', () => {
    // A bonus of 10 units carries no amount; a zero-value transfer of 10 units carries zero.
    const base = {
      accountId: 'a',
      instrumentId: 'i',
      type: 'bonus',
      occurredDate: '2026-01-06',
      quantity: dec('10'),
    }
    expect(naturalKeyInput({ ...base, amountMinor: null })).not.toBe(
      naturalKeyInput({ ...base, amountMinor: '0' }),
    )
  })

  it('cannot be confused by a value containing the separator', () => {
    // The separator is ASCII unit separator, which cannot occur in an id, a type or a decimal.
    const a = naturalKeyInput({
      accountId: 'a',
      instrumentId: 'i',
      type: 'buy',
      occurredDate: '2026-01-06',
      quantity: dec('1'),
      amountMinor: '100',
    })
    const b = naturalKeyInput({
      accountId: 'a',
      instrumentId: 'i',
      type: 'buy',
      occurredDate: '2026-01-06',
      quantity: dec('1'),
      amountMinor: '10',
      externalId: '0',
    })
    expect(a).not.toBe(b)
  })
})

describe('trimTrailingZeros', () => {
  it('normalises scale without changing value', () => {
    expect(trimTrailingZeros(dec('10.000'))).toBe('10')
    expect(trimTrailingZeros(dec('10.500'))).toBe('10.5')
    expect(trimTrailingZeros(dec('10'))).toBe('10')
    expect(trimTrailingZeros(dec('0.00000000'))).toBe('0')
    expect(trimTrailingZeros(dec('-0.000'))).toBe('0')
  })
})

describe('assignOccurrences', () => {
  it('numbers identical keys within a batch and repeats on re-import', () => {
    // Two identical same-day SIP instalments are both real and must survive.
    const keys = ['k1', 'k2', 'k1', 'k1']
    expect(assignOccurrences(keys)).toEqual([0, 0, 1, 2])
    expect(assignOccurrences(keys)).toEqual([0, 0, 1, 2])
  })
})
