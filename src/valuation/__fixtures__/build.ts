/**
 * Fixture builders for the valuation tests.
 *
 * They exist so that a test reads as the transaction table in the spec rather than as twelve lines
 * of object literal, and so that every fixture goes through `dec()` and `minor()` — the float ban
 * applies to test data too, because a fixture built from a float would validate the wrong thing.
 */

import { type CurrencyCode, type Dec, type Minor, dec, minor } from '@domain/numeric'
import { type FxRateRow, type FxService, FxTable } from '../fx'
import type { AliasRef, AssetClass, InstrumentRef, PositionRow, TaxRegime, TxnRow, TxnType } from '../types'

let counter = 0

export function resetIds(): void {
  counter = 0
}

export interface TxnSpec {
  readonly type: TxnType
  readonly date: string
  readonly quantity: string
  readonly price?: string
  readonly amount?: string
  readonly fees?: string
  readonly id?: string
  readonly accountId?: string
  readonly instrumentId?: string
  readonly currency?: CurrencyCode
  readonly fxRate?: string
  readonly tz?: string | null
  readonly naturalKey?: string
  readonly sourceDocumentId?: string
}

export function txn(spec: TxnSpec): TxnRow {
  counter += 1
  const id = spec.id ?? `t${counter.toString().padStart(3, '0')}`
  return {
    id,
    accountId: spec.accountId ?? 'acc-1',
    instrumentId: spec.instrumentId ?? 'inst-1',
    type: spec.type,
    occurredAt: `${spec.date}T10:00:00+05:30`,
    occurredTz: spec.tz === undefined ? 'Asia/Kolkata' : spec.tz,
    quantity: dec(spec.quantity),
    price: spec.price === undefined ? null : dec(spec.price),
    amountMinor: spec.amount === undefined ? null : minor(spec.amount),
    feesMinor: minor(spec.fees ?? '0'),
    currency: spec.currency ?? 'INR',
    fxRate: spec.fxRate === undefined ? null : dec(spec.fxRate),
    sourceDocumentId: spec.sourceDocumentId ?? 'doc-1',
    naturalKey: spec.naturalKey ?? `nk-${id}`,
    createdAt: `${spec.date}T10:00:00+05:30`,
  }
}

/**
 * A redemption exactly as a CAMS/KFintech CAS records one: **both** the units and the amount
 * negative.
 *
 * This is not a hypothetical adapter's convention, it is the primary one. The statement prints
 * `(150.000)` and `(10,000.00)`, `canonicalDecimal` turns both into negatives,
 * `normalizeTransaction` passes the amount through with its sign, and
 * `src/ingestion/pdf/cams-kfin-cas.test.ts` pins `amountMinor === '-1000000'` as *correct* — so a
 * negative gross for a sale is a legitimate state of the store, not a corruption.
 *
 * Every `sell` fixture in this engine's tests used to be written the other way, with a positive
 * amount, which is why the fold could use a sale's amount verbatim as gross consideration for as
 * long as it did: a ₹1,000 realised gain came out as a ₹19,000 realised *loss*, flagged `measured`,
 * and XIRR read −29.76% on a portfolio that was up. Nothing in the honesty machinery could see it,
 * because a signed number is not a missing one.
 *
 * `quantity` and `amount` are given as the magnitudes a reader would say out loud; this negates
 * both, so a test cannot accidentally write the convention it is meant to be testing against.
 */
export function casRedemption(spec: Omit<TxnSpec, 'type'>): TxnRow {
  const negated: TxnSpec = { ...spec, type: 'sell', quantity: negate(spec.quantity) }
  return txn({
    ...negated,
    ...(spec.amount === undefined ? {} : { amount: negate(spec.amount) }),
    ...(spec.fees === undefined ? {} : { fees: negate(spec.fees) }),
  })
}

function negate(value: string): string {
  if (value.startsWith('-')) return value.slice(1)
  return /^0(\.0*)?$/.test(value) ? value : `-${value}`
}

/** An FX table holding nothing: INR converts to INR by identity and nothing else converts at all. */
export function inrOnlyFx(): FxService {
  return new FxTable([])
}

/** A USD/INR table, in the direction `fx.ts` fixes: INR per one USD. */
export function usdFx(...rates: readonly (readonly [string, string])[]): FxService {
  const rows: FxRateRow[] = rates.map(([asOf, rate]) => ({
    base: 'USD',
    quote: 'INR',
    asOf,
    rate: dec(rate),
    source: 'fixture',
  }))
  return new FxTable(rows)
}

export interface InstrumentSpec {
  readonly id?: string
  readonly assetClass?: AssetClass
  readonly currency?: CurrencyCode
  readonly precision?: number
  readonly taxRegime?: TaxRegime | null
  readonly fmv?: string
  readonly aliases?: readonly AliasRef[]
  readonly isin?: string
  readonly displayName?: string
}

export function instrument(spec: InstrumentSpec = {}): InstrumentRef {
  return {
    id: spec.id ?? 'inst-1',
    assetClass: spec.assetClass ?? 'indian_equity',
    displayName: spec.displayName ?? 'Test Instrument',
    isin: spec.isin ?? null,
    currency: spec.currency ?? 'INR',
    precision: spec.precision ?? 4,
    aliases: spec.aliases ?? [],
    taxRegime: spec.taxRegime === undefined ? null : spec.taxRegime,
    fmv31Jan2018: spec.fmv === undefined ? null : dec(spec.fmv),
  }
}

export function instrumentMap(...instruments: InstrumentRef[]): ReadonlyMap<string, InstrumentRef> {
  return new Map(instruments.map((i) => [i.id, i]))
}

/**
 * `asOf` is a plain date, taken as 18:00 IST — the shape almost every test wants. A test that
 * cares about the offset itself passes a whole instant instead, which is used verbatim, because
 * the fixture must not be able to launder a mixed-offset corpus into a single-offset one.
 */
export function snapshot(
  instrumentId: string,
  quantity: string,
  asOf: string,
  accountId = 'acc-1',
): PositionRow {
  counter += 1
  return {
    id: `p${counter.toString()}`,
    accountId,
    instrumentId,
    quantity: dec(quantity),
    asOf: asOf.includes('T') ? asOf : `${asOf}T18:00:00+05:30`,
    sourceDocumentId: 'doc-1',
  }
}

export function m(value: string): Minor {
  return minor(value)
}

export function d(value: string): Dec {
  return dec(value)
}
