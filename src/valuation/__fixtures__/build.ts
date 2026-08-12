/**
 * Fixture builders for the valuation tests.
 *
 * They exist so that a test reads as the transaction table in the spec rather than as twelve lines
 * of object literal, and so that every fixture goes through `dec()` and `minor()` — the float ban
 * applies to test data too, because a fixture built from a float would validate the wrong thing.
 */

import { type CurrencyCode, type Dec, type Minor, dec, minor } from '@domain/numeric'
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
    asOf: `${asOf}T18:00:00+05:30`,
    sourceDocumentId: 'doc-1',
  }
}

export function m(value: string): Minor {
  return minor(value)
}

export function d(value: string): Dec {
  return dec(value)
}
