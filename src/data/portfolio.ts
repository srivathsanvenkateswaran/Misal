/**
 * The seam between stored rows and the valuation engine.
 *
 * The Rust core hands over rows; `src/valuation/` computes metrics. Neither knows about the other,
 * and this module is the only place their shapes meet. It does no arithmetic of its own beyond
 * summing fee components, because a second place that computes money is a second place that can
 * disagree with the first.
 *
 * Every string arriving from the database is validated here rather than cast. A row with an
 * unsupported currency or a malformed decimal must fail at this boundary, where the error names
 * the offending row, rather than three layers deeper inside a fold.
 */

import { type CurrencyCode, type Dec, type Minor, addMinor, currencyCode, dec, minor } from '@domain/numeric'
import {
  FxTable,
  InMemoryPriceStore,
  PriceService,
  type FoldInput,
  type InstrumentRef,
  type PortfolioInput,
  type ValuationSnapshot,
  type Result,
  valuePortfolio,
} from '@valuation/index'
import type { AliasRow, PortfolioRows, TxnRow as DbTxnRow } from './client'

export class MappingError extends Error {
  override readonly name = 'MappingError'
}

/**
 * Fees that form part of the cost of transfer.
 *
 * Securities transaction tax is deliberately excluded. Section 48 expressly disallows STT as a
 * deduction in computing capital gains, so folding it into the same figure as brokerage would
 * overstate cost and understate the gain.
 *
 * This is a lossy mapping and worth naming as such: the schema decomposes fees into six columns
 * precisely so this distinction is possible, but the valuation engine's `TxnRow` carries a single
 * `feesMinor`, so the choice has to be made here instead of in the engine where context is
 * available. The consequence is that STT is invisible to cost basis, which is correct, but also
 * invisible to any future "what did this cost me in charges" view, which is not. See
 * docs/known-issues.md.
 */
function costOfTransferMinor(row: DbTxnRow): Minor {
  return addMinor(
    minor(row.brokerageMinor),
    minor(row.gstMinor),
    minor(row.stampDutyMinor),
    minor(row.otherFeesMinor),
  )
}

const ASSET_CLASSES = new Set([
  'indian_equity',
  'mutual_fund',
  'us_equity',
  'crypto',
  'gold',
  'bond',
  'cash',
])

const TXN_TYPES = new Set([
  'buy',
  'sell',
  'dividend',
  'split',
  'bonus',
  'transfer_in',
  'transfer_out',
  'fee',
  'interest',
  'tds',
])

/**
 * Currencies the valuation engine can convert.
 *
 * The `X:` namespace reserved by migration 0002 is deliberately NOT one of them: a `BTCUSDT` fill
 * is denominated in USDT, which has no minor unit and no exchange rate here. Such rows carry no
 * `amount_minor` and are valued from quantity and price instead.
 */
function requireCurrency(raw: string, context: string): CurrencyCode {
  try {
    return currencyCode(raw)
  } catch {
    throw new MappingError(`${context}: unsupported currency ${JSON.stringify(raw)}`)
  }
}

/** True for a crypto-denominated amount, which is a valid stored value rather than a bad row. */
export function isNonFiatCurrency(raw: string): boolean {
  return raw.startsWith('X:')
}

function requireDec(raw: string, context: string): Dec {
  try {
    return dec(raw)
  } catch {
    throw new MappingError(`${context}: malformed decimal ${JSON.stringify(raw)}`)
  }
}

/** Build the instrument lookup the engine indexes everything by. */
export function buildInstruments(
  rows: PortfolioRows,
  aliases: readonly AliasRow[],
): ReadonlyMap<string, InstrumentRef> {
  const byInstrument = new Map<string, AliasRow[]>()
  for (const alias of aliases) {
    const list = byInstrument.get(alias.instrumentId) ?? []
    list.push(alias)
    byInstrument.set(alias.instrumentId, list)
  }

  const out = new Map<string, InstrumentRef>()
  for (const row of rows.instruments) {
    if (!ASSET_CLASSES.has(row.assetClass)) {
      throw new MappingError(`instrument ${row.id}: unknown asset class ${row.assetClass}`)
    }
    out.set(row.id, {
      id: row.id,
      assetClass: row.assetClass as InstrumentRef['assetClass'],
      displayName: row.displayName,
      isin: row.isin,
      currency: requireCurrency(row.currency, `instrument ${row.id}`),
      precision: row.precision,
      aliases: (byInstrument.get(row.id) ?? []).map((a) => ({
        scheme: a.scheme as never,
        value: a.value,
        providerId: a.providerId,
      })),
      taxRegime: row.taxRegime as InstrumentRef['taxRegime'],
      fmv31Jan2018:
        row.fmv31Jan2018 === null
          ? null
          : requireDec(row.fmv31Jan2018, `instrument ${row.id} 31 Jan 2018 FMV`),
    })
  }
  return out
}

/** Group rows into one fold input per account. */
export function buildAccounts(
  rows: PortfolioRows,
  instruments: ReadonlyMap<string, InstrumentRef>,
  asOf: string,
): readonly FoldInput[] {
  return rows.accounts.map((account) => ({
    accountId: account.id,
    capability: account.capability,
    txns: rows.transactions
      .filter((t) => t.accountId === account.id)
      // A snapshot account's transactions are never folded - derivePositions takes its holdings
      // from the stored snapshot and ignores txns entirely. Mapping them anyway meant a single
      // exchange fill quoted in USDT threw MappingError on a row nothing would ever read, which
      // failed the whole valuation and, before the Shell ordering was fixed, locked the user out
      // of every screen including the ones that could undo it.
      .filter(() => account.capability === 'ledger')
      .map((t) => {
        if (!TXN_TYPES.has(t.type)) {
          throw new MappingError(`transaction ${t.id}: unknown type ${t.type}`)
        }
        return {
          id: t.id,
          accountId: t.accountId,
          instrumentId: t.instrumentId,
          type: t.type as never,
          occurredAt: t.occurredAt as never,
          occurredTz: t.occurredTz,
          quantity: requireDec(t.quantity, `transaction ${t.id} quantity`),
          price: t.price === null ? null : requireDec(t.price, `transaction ${t.id} price`),
          amountMinor: t.amountMinor === null ? null : minor(t.amountMinor),
          feesMinor: costOfTransferMinor(t),
          currency: requireCurrency(t.currency, `transaction ${t.id}`),
          fxRate: t.fxRate === null ? null : requireDec(t.fxRate, `transaction ${t.id} fx rate`),
          sourceDocumentId: t.sourceDocumentId,
          naturalKey: t.naturalKey,
          createdAt: t.createdAt as never,
        }
      }),
    snapshots: rows.positions
      .filter((p) => p.accountId === account.id)
      .map((p) => ({
        id: p.id,
        accountId: p.accountId,
        instrumentId: p.instrumentId,
        quantity: requireDec(p.quantity, `position ${p.id}`),
        asOf: p.asOf as never,
        sourceDocumentId: p.sourceDocumentId,
      })),
    instruments,
    asOf: asOf as never,
  }))
}

/** A price service seeded with every stored price, manual rows keeping precedence. */
export function buildPriceService(
  rows: PortfolioRows,
  instruments: ReadonlyMap<string, InstrumentRef>,
  now: () => string,
): PriceService {
  const store = new InMemoryPriceStore()
  // Non-manual rows first, so a manual override is never refused by an already-present manual row
  // and never overwritten by a fetched one. `put` enforces the precedence; ordering just avoids
  // relying on the input happening to arrive in a helpful sequence.
  const ordered = [...rows.prices].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'manual' ? 1 : -1,
  )
  for (const price of ordered) {
    store.put({
      instrumentId: price.instrumentId,
      asOf: price.asOf,
      close: requireDec(price.close, `price for ${price.instrumentId} on ${price.asOf}`),
      currency: requireCurrency(price.currency, `price for ${price.instrumentId}`),
      source: price.source,
      fetchedAt: price.fetchedAt,
    })
  }

  // No provider is registered here. Providers fetch over the network, which belongs to an
  // explicit refresh action the user triggers - not to rendering a screen. Reading stored prices
  // must never quietly become a network call, or opening the app would depend on connectivity and
  // on an exchange's rate limit.
  return new PriceService({ store, instruments, now: now })
}

export interface ValuationBundle {
  readonly snapshot: Result<ValuationSnapshot>
  readonly instruments: ReadonlyMap<string, InstrumentRef>
  readonly prices: PriceService
}

/**
 * Value a portfolio from stored rows.
 *
 * Returns the engine's `Result` unchanged rather than throwing on a valuation failure: a portfolio
 * that cannot be fully valued is an ordinary state this product is built to display honestly, not
 * an exception. Only a malformed row throws, because that is a defect rather than a gap.
 */
export function valueFromRows(
  rows: PortfolioRows,
  aliases: readonly AliasRow[],
  asOf: string,
): ValuationBundle {
  const instruments = buildInstruments(rows, aliases)
  const accounts = buildAccounts(rows, instruments, asOf)
  const prices = buildPriceService(rows, instruments, () => asOf)

  // Seeded from stored rates. An empty table is not a neutral default: the engine refuses to
  // convert rather than assume a rate, so every USD holding - the E*TRADE and Fidelity RSUs this
  // product exists to consolidate - would be silently absent from every total rather than merely
  // unpriced.
  const fx = new FxTable(
    rows.fxRates.map((r) => ({
      base: r.base,
      quote: r.quote,
      asOf: r.asOf as never,
      rate: requireDec(r.rate, `fx rate ${r.base}/${r.quote} on ${r.asOf}`),
      source: r.source,
    })),
  )

  const input: PortfolioInput = {
    accounts,
    instruments,
    prices,
    fx,
    // Fully mapped, and deliberately not cast. An earlier version omitted `resolvedAt` and
    // silenced the resulting type error with `as never`; the engine filters on
    // `resolvedAt === null`, `undefined === null` is false, and so every unresolved row was
    // dropped and the withheld value always reported zero. The whole point of the queue is to
    // state what is being held out of the totals, so it reported the opposite of the truth.
    //
    // list_unresolved returns only rows where resolved_at IS NULL, hence the constant.
    unresolved: rows.unresolved.map((u) => ({
      id: u.id,
      accountId: u.accountId,
      rawIdentifier: u.rawIdentifier,
      rawName: u.rawName,
      observedQuantity:
        u.observedQuantity === null
          ? null
          : requireDec(u.observedQuantity, `unresolved ${u.id} quantity`),
      observedValueMinor: u.observedValueMinor === null ? null : minor(u.observedValueMinor),
      currency: u.currency === null ? null : requireCurrency(u.currency, `unresolved ${u.id}`),
      resolvedAt: null,
    })),
    asOf: asOf,
  }

  return { snapshot: valuePortfolio(input), instruments, prices }
}
