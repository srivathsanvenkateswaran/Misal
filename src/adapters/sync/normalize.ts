/**
 * Turning fills, transfers and conversions into transactions.
 *
 * Four rules here are easy to get wrong and expensive to get wrong quietly.
 *
 * A transfer is not a trade, and this module will not let one become one. `normalizeTransfer`
 * cannot take a price, because there is nowhere for a price to come from: units arriving from a
 * wallet were acquired somewhere Misal cannot see, and the only true statement about their cost is
 * that it is unknown. `transfer_in` with a null price and a null amount is exactly how the fold
 * spells that, and it is why a deposit must not be recorded as a `buy` with a missing price - the
 * two are one field apart in the row and a whole category apart in what they claim.
 *
 * The traded asset is the market catalogue's *base*, never a substring of the symbol. CoinDCX
 * inverts the usual naming - its "target currency" is the traded quantity - and the adapter has
 * already mapped that onto MarketSpec.base, so this module can trust it.
 *
 * A fee paid in kind becomes its own `fee` transaction against the fee asset. `fees_minor` is an
 * integer count of a currency's minor units and cannot represent 0.000114 BNB; recording it there
 * would either round it to zero or corrupt the trade's cost. Only fees in a real fiat currency go
 * in a fee column.
 *
 * A crypto-quoted trade has no `amount_minor`. USDT has no ISO code and no minor unit, so the
 * currency is recorded in the reserved 'X:' namespace and the value is derived from quantity and
 * price at valuation time.
 */

import {
  type Dec,
  type CurrencyCode,
  ZERO_MINOR,
  currencyCode,
  decToMinor,
  mulDec,
} from '@domain/numeric'
import type { MarketSpec, RawConversion, RawFill, RawTransfer } from '../contract'
import { negateText } from '../decimal-text'
import { assignOccurrences, naturalKey } from './natural-key'
import type { TxnRow } from './store'

/** The fiat currencies Misal can express in minor units. Everything else is 'X:'-namespaced. */
const FIAT: readonly string[] = ['INR', 'USD']

export function isFiat(code: string): code is CurrencyCode {
  return FIAT.includes(code)
}

/** The currency a trade is denominated in, in the form `txn.currency` expects. */
export function quoteCurrency(quoteAsset: string): string {
  // ISO 4217 reserves codes beginning with X for things that are not national currencies, so
  // the prefix cannot collide with a real currency code.
  return isFiat(quoteAsset) ? quoteAsset : `X:${quoteAsset}`
}

export interface NormalizeInput {
  readonly accountId: string
  readonly fill: RawFill
  readonly market: MarketSpec
  readonly baseInstrumentId: string
  /** Null when the fee asset could not be resolved; the fee is then dropped and reported. */
  readonly feeInstrumentId: string | null
  readonly sourceDocumentId: string
}

/** A transaction before its natural key and occurrence number are assigned. */
export type UnkeyedTxnRow = Omit<TxnRow, 'naturalKey' | 'occurrence'>

/**
 * One fill becomes one trade row, plus a fee row when the fee was paid in kind.
 *
 * Keys are NOT assigned here. Occurrence numbering has to be computed across the whole page at
 * once: two identical fills in one page are both real, and numbering them independently would
 * give both occurrence 0, collide on the unique index, and silently drop one as a duplicate.
 */
export function normalizeFill(input: NormalizeInput): UnkeyedTxnRow[] {
  const { fill, market } = input
  const currency = quoteCurrency(market.quote.code)
  const fiat = isFiat(market.quote.code)
  const gross = mulDec(fill.quantity, fill.price)
  const amountMinor = fiat ? decToMinor(gross, currencyCode(market.quote.code)) : null

  // A sell reduces the holding, so its quantity is negative. The fold that reconciles against the
  // reported balance depends on this sign, as does every downstream cost-basis calculation.
  const signedQuantity = fill.side === 'sell' ? negateText(fill.quantity) : fill.quantity

  const feeInFiat =
    fill.fee !== undefined && isFiat(fill.fee.asset.code) && fill.fee.asset.code === market.quote.code
      ? decToMinor(fill.fee.amount, currencyCode(fill.fee.asset.code))
      : ZERO_MINOR

  const trade: UnkeyedTxnRow = {
    accountId: input.accountId,
    instrumentId: input.baseInstrumentId,
    type: fill.side,
    occurredAt: fill.occurredAt,
    occurredTz: null,
    quantity: signedQuantity,
    price: fill.price,
    amountMinor,
    otherFeesMinor: feeInFiat,
    currency,
    sourceDocumentId: input.sourceDocumentId,
    externalId: fill.externalId,
  }

  const rows: UnkeyedTxnRow[] = [trade]

  const feeInstrumentId = input.feeInstrumentId
  if (fill.fee !== undefined && feeInFiat === ZERO_MINOR && feeInstrumentId !== null) {
    rows.push({
      accountId: input.accountId,
      instrumentId: feeInstrumentId,
      type: 'fee',
      occurredAt: fill.occurredAt,
      occurredTz: null,
      // A fee removes units of the fee asset from the account.
      quantity: negateText(fill.fee.amount),
      price: null,
      amountMinor: null,
      otherFeesMinor: ZERO_MINOR,
      currency: quoteCurrency(fill.fee.asset.code),
      sourceDocumentId: input.sourceDocumentId,
      // Suffixed so the fee and the trade it came from are distinct rows even when every other
      // keyed field happens to match.
      externalId: `${fill.externalId}:fee`,
    })
  }

  return rows
}

export interface NormalizeTransferInput {
  readonly accountId: string
  readonly transfer: RawTransfer
  readonly instrumentId: string
  /** Null when the fee asset could not be resolved; the fee is then dropped and reported. */
  readonly feeInstrumentId: string | null
  /** The account's reporting currency, which is what a cost would later be entered in. */
  readonly reportingCurrency: string
  readonly sourceDocumentId: string
}

/**
 * One transfer becomes one movement of units, plus a fee row where the exchange charged one.
 *
 * There is no `price` argument and no `amountMinor`, and their absence is the entire point. A
 * `transfer_in` opens a lot the fold marks `costKnown: false`, which withholds cost basis,
 * unrealised P&L and XIRR for that holding and says so - rather than valuing the units at the
 * market price on the day they arrived, which would look like an answer and be a fabrication.
 *
 * `transfer_out` is symmetrical and equally unpriced: units leaving for a wallet are not a sale,
 * and `tax.ts` already declines to treat a `transfer_out` consumption as a disposal.
 */
export function normalizeTransfer(input: NormalizeTransferInput): UnkeyedTxnRow[] {
  const { transfer } = input
  const incoming = transfer.direction === 'in'

  const movement: UnkeyedTxnRow = {
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    type: incoming ? 'transfer_in' : 'transfer_out',
    occurredAt: transfer.occurredAt,
    occurredTz: null,
    // The direction carries the sign. RawTransfer.quantity is always positive.
    quantity: incoming ? transfer.quantity : negateText(transfer.quantity),
    // Never a price. See above.
    price: null,
    amountMinor: null,
    otherFeesMinor: ZERO_MINOR,
    currency: input.reportingCurrency,
    sourceDocumentId: input.sourceDocumentId,
    externalId: transfer.externalId,
  }

  const rows: UnkeyedTxnRow[] = [movement]

  // Binance deducts the withdrawal fee on top of the amount withdrawn, so it is units leaving the
  // account in its own right. Folding it into the transfer's quantity would misstate what reached
  // the other end; dropping it would leave the fold above the balance by exactly the fee and
  // manufacture a coverage gap out of a fee we can see.
  if (transfer.fee !== undefined && input.feeInstrumentId !== null) {
    rows.push({
      accountId: input.accountId,
      instrumentId: input.feeInstrumentId,
      type: 'fee',
      occurredAt: transfer.occurredAt,
      occurredTz: null,
      quantity: negateText(transfer.fee.amount),
      price: null,
      amountMinor: null,
      otherFeesMinor: ZERO_MINOR,
      currency: quoteCurrency(transfer.fee.asset.code),
      sourceDocumentId: input.sourceDocumentId,
      externalId: `${transfer.externalId}:fee`,
    })
  }

  return rows
}

export interface NormalizeConversionInput {
  readonly accountId: string
  readonly conversion: RawConversion
  /** The instrument for the asset acquired. */
  readonly toInstrumentId: string
  readonly sourceDocumentId: string
}

/**
 * A conversion becomes a priced acquisition of the asset received.
 *
 * This is the opposite call from a transfer, and for a concrete reason: the units given up *are*
 * the consideration, so the cost is known exactly and recording it as anything but a `buy` would
 * throw away a cost basis the exchange handed us.
 *
 * Only the acquisition side is recorded, which is the same choice `normalizeFill` makes: a spot buy
 * of BTC for USDT produces a row against BTC and nothing against USDT. Emitting the disposal side
 * here and not there would make the coverage check tell two different stories about USDT depending
 * on which screen the trade was made from.
 */
export function normalizeConversion(input: NormalizeConversionInput): UnkeyedTxnRow[] {
  const { conversion } = input
  const quoteAsset = conversion.from.code
  const fiat = isFiat(quoteAsset)

  return [
    {
      accountId: input.accountId,
      instrumentId: input.toInstrumentId,
      type: 'buy',
      occurredAt: conversion.occurredAt,
      occurredTz: null,
      quantity: conversion.toQuantity,
      price: conversion.price,
      // The exchange's own `fromAmount`, not quantity times price. Convert quotes a rounded ratio
      // and the amount actually debited is the authoritative figure.
      amountMinor: fiat ? decToMinor(conversion.fromQuantity, currencyCode(quoteAsset)) : null,
      otherFeesMinor: ZERO_MINOR,
      currency: quoteCurrency(quoteAsset),
      sourceDocumentId: input.sourceDocumentId,
      externalId: conversion.externalId,
    },
  ]
}

/** Assign natural keys and occurrence numbers across one page. */
export async function withKeys(rows: readonly UnkeyedTxnRow[]): Promise<TxnRow[]> {
  const keys = await Promise.all(
    rows.map((row) =>
      naturalKey({
        accountId: row.accountId,
        instrumentId: row.instrumentId,
        type: row.type,
        occurredAt: row.occurredAt,
        quantity: row.quantity,
        amountMinor: row.amountMinor,
        externalId: row.externalId,
      }),
    ),
  )
  const occurrences = assignOccurrences(keys)
  return rows.map((row, index) => ({
    ...row,
    naturalKey: keys[index] as string,
    occurrence: occurrences[index] as number,
  }))
}

/** The gross consideration of a fill, for the import report. Exact; never rounded. */
export function grossOf(fill: RawFill): Dec {
  return mulDec(fill.quantity, fill.price)
}
