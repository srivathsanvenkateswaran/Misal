/**
 * Shared vocabulary for the valuation engine.
 *
 * These are the engine-side shapes of the rows defined by the core schema spec, already parsed:
 * money is `Minor`, quantities/prices/rates are `Dec`, and nothing is a JavaScript number except
 * counts of things (days, iterations, rows) that were never money to begin with.
 *
 * The engine never sees SQL. A caller reads rows, parses them at the boundary with `minor()` and
 * `dec()`, and hands them here; that keeps the whole subsystem pure and testable without a
 * database, which is the property the spec's "it never fetches" rule depends on.
 */

import type { CurrencyCode, Dec, Minor } from '@domain/numeric'

/** 'YYYY-MM-DD' */
export type IsoDate = string
/** 'YYYY-MM-DDTHH:mm:ss±HH:mm' */
export type IsoInstant = string

export type AssetClass =
  | 'indian_equity'
  | 'mutual_fund'
  | 'us_equity'
  | 'crypto'
  | 'gold'
  | 'bond'
  | 'cash'

export type AccountCapability = 'ledger' | 'snapshot'

export type TxnType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'split'
  | 'bonus'
  | 'transfer_in'
  | 'transfer_out'
  | 'fee'
  | 'interest'
  | 'tds'

export type AliasScheme =
  | 'isin'
  | 'nse'
  | 'bse'
  | 'amfi'
  | 'ticker'
  | 'coingecko'
  | 'provider-local'

export interface AliasRef {
  readonly scheme: AliasScheme
  readonly value: string
  readonly providerId: string | null
}

/**
 * Tax regimes, as classification labels for reporting. Not a tax computation — see the spec's
 * "Out of scope".
 */
export type TaxRegime =
  | 's112a_listed_equity'
  | 's50aa_specified_mf'
  | 'other_mf_listed'
  | 'other_mf_unlisted'
  | 'foreign_equity'
  | 's115bbh_vda'
  | 'other_asset'

/**
 * Instrument metadata as the engine needs it.
 *
 * `taxRegime` and `fmv31Jan2018` are not columns in the core schema (open questions 1 and 2). They
 * are carried here as explicit, nullable inputs so that "we do not know" is representable and
 * reaches the user as a withheld metric rather than as a guessed classification.
 */
export interface InstrumentRef {
  readonly id: string
  readonly assetClass: AssetClass
  readonly displayName: string
  readonly isin: string | null
  readonly currency: CurrencyCode
  /** Display precision for quantity; also the reconciliation tolerance exponent. */
  readonly precision: number
  readonly aliases: readonly AliasRef[]
  /** User classification. `null` means unknown, which withholds realised P&L. */
  readonly taxRegime: TaxRegime | null
  /** Highest quoted price on 31-Jan-2018, for section 55(2)(ac). `null` blocks grandfathering. */
  readonly fmv31Jan2018: Dec | null
}

export interface TxnRow {
  readonly id: string
  readonly accountId: string
  readonly instrumentId: string
  readonly type: TxnType
  readonly occurredAt: IsoInstant
  readonly occurredTz: string | null
  /** Signed. For `split` this is the multiplier; for `bonus`, the units credited. */
  readonly quantity: Dec
  readonly price: Dec | null
  readonly amountMinor: Minor | null
  readonly feesMinor: Minor
  readonly currency: CurrencyCode
  readonly fxRate: Dec | null
  readonly sourceDocumentId: string
  readonly naturalKey: string
  readonly createdAt: IsoInstant
}

export interface PositionRow {
  readonly id: string
  readonly accountId: string
  readonly instrumentId: string
  readonly quantity: Dec
  readonly asOf: IsoInstant
  readonly sourceDocumentId: string
}

export interface UnresolvedInstrumentRow {
  readonly id: string
  readonly accountId: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly observedQuantity: Dec | null
  readonly observedValueMinor: Minor | null
  readonly currency: CurrencyCode | null
  readonly resolvedAt: IsoInstant | null
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Stable, user-visible codes. Every one maps to a UI string; none produces a substituted zero. */
export type WarningCode =
  | 'NO_PRICE'
  | 'NO_PRICE_SOURCE'
  | 'PRICE_CURRENCY_MISMATCH'
  | 'PRICE_STALE'
  | 'PRICE_VERY_STALE'
  | 'NO_FX_RATE'
  | 'NO_FX_SOURCE'
  | 'FX_RATE_IMPUTED'
  | 'FX_DIRECTION_INVALID'
  | 'MISSING_FX'
  | 'MISSING_ACQUISITION_COST'
  | 'NEGATIVE_INVENTORY'
  | 'FOLD_SNAPSHOT_MISMATCH'
  | 'CORPORATE_ACTION_MISSING_IN_ACCOUNT'
  | 'BONUS_UNITS_MISMATCH'
  | 'GRANDFATHER_FMV_UNAVAILABLE'
  | 'UNKNOWN_TAX_REGIME'
  | 'XIRR_NOT_CONVERGED'
  | 'XIRR_NO_SIGN_CHANGE'
  | 'XIRR_MULTIPLE_ROOTS'
  | 'XIRR_UNSTABLE'
  | 'SCOPE_NOT_MEASURED'
  | 'TRADING_CALENDAR_STALE'
  | 'PLAN_RESTRICTED'
  | 'RATE_LIMITED'
  | 'SNAPSHOT_ACCOUNT'
  | 'INVALID_SPLIT_RATIO'

export interface RowRef {
  readonly txnId?: string
  readonly accountId?: string
  readonly instrumentId?: string
  readonly sourceDocumentId?: string
}

export interface Warning {
  readonly code: WarningCode
  readonly message: string
  readonly ref?: RowRef
}

export type ValuationErrorCode =
  | 'ACCOUNT_MISMATCH'
  | 'UNKNOWN_INSTRUMENT'
  | 'INVALID_INPUT'

export interface ValuationError {
  readonly code: ValuationErrorCode
  readonly message: string
  readonly ref?: RowRef
}

export type Ok<T> = { readonly ok: true; readonly value: T; readonly warnings: readonly Warning[] }
export type Err<E> = { readonly ok: false; readonly error: E; readonly warnings: readonly Warning[] }
export type Result<T, E = ValuationError> = Ok<T> | Err<E>

export function ok<T>(value: T, warnings: readonly Warning[] = []): Ok<T> {
  return { ok: true, value, warnings }
}

export function err<E>(error: E, warnings: readonly Warning[] = []): Err<E> {
  return { ok: false, error, warnings }
}

/**
 * Thrown only for programmer error — a malformed decimal that got past ingestion, an impossible
 * branch. Absent data is never an exception; it is an `Err` or a `Measured` false branch.
 */
export class ValuationAssertionError extends Error {
  override readonly name = 'ValuationAssertionError'
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type MeasurementStatus = 'measured' | 'partially_measured' | 'not_measured'

export interface MeasurementReason {
  readonly status: MeasurementStatus
  readonly code: WarningCode
  readonly message: string
  /** Whether the user can close this gap themselves, so the UI can sort actionable gaps first. */
  readonly userFixable: boolean
}

export interface PairRef {
  readonly accountId: string
  readonly instrumentId: string
}

export type LotOrigin = 'buy' | 'transfer_in' | 'bonus' | 'synthetic_opening'

export interface OpenLot {
  readonly lotId: string
  readonly accountId: string
  readonly instrumentId: string
  readonly openingTxnId: string
  readonly acquiredOn: IsoDate
  readonly quantity: Dec
  readonly costMinor: Minor
  readonly currency: CurrencyCode
  readonly fxRate: Dec | null
  readonly costKnown: boolean
  readonly origin: LotOrigin
}
