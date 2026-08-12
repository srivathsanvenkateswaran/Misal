/**
 * Position derivation: two paths, chosen by account capability, never mixed.
 *
 * A snapshot account's `position` rows *are* the position, and it has no cost basis to speak of. A
 * ledger account's positions come from the fold, and its `position` rows are used only as an
 * independent check on our own arithmetic — consuming them as input would throw that check away.
 *
 * Everything that fails here fails towards withholding. A cost basis wrong by a factor of five
 * looks entirely plausible on screen and is discovered a year later at tax time.
 */

import { type Dec, absDec, addDec, compareDec, dec, divDec, isZeroDec, subDec } from '@domain/numeric'
import { tenPowNegative } from './arithmetic'
import { instantToDate } from './calendar'
import {
  type FoldInput,
  type LotLedger,
  buildLots,
  quantityOn,
} from './fold'
import {
  type InstrumentRef,
  type IsoDate,
  type IsoInstant,
  type MeasurementReason,
  type MeasurementStatus,
  type OpenLot,
  type PositionRow,
  type Result,
  type Warning,
  err,
  ok,
} from './types'

export interface Reconciliation {
  readonly instrumentId: string
  readonly foldedQuantity: Dec
  readonly snapshotQuantity: Dec
  readonly snapshotAsOf: IsoInstant
  readonly agrees: boolean
  /** folded / snapshot, for diagnosis. Null when the snapshot quantity is zero. */
  readonly ratio: Dec | null
}

export interface DerivedPosition {
  readonly accountId: string
  readonly instrumentId: string
  /** Signed. A negative quantity is an error condition, never a short position. */
  readonly quantity: Dec
  readonly asOf: IsoInstant
  readonly basis: 'folded' | 'snapshot'
  readonly measurement: MeasurementStatus
  readonly reason: MeasurementReason | null
  /** Empty whenever `measurement !== 'measured'`. */
  readonly lots: readonly OpenLot[]
  readonly provenance: readonly string[]
  /** True when no source corroborates the quantity. The UI must render this as unresolved. */
  readonly quantitySuspect: boolean
  readonly ledger: LotLedger | null
  readonly reconciliation: Reconciliation | null
}

const SNAPSHOT_REASON: MeasurementReason = {
  status: 'not_measured',
  code: 'SNAPSHOT_ACCOUNT',
  message:
    'This account reports holdings only as a snapshot, with no transaction history. Quantity and market value are known; cost basis, P&L and XIRR are not.',
  userFixable: false,
}

function latestSnapshots(
  snapshots: readonly PositionRow[],
  asOf: IsoInstant,
): ReadonlyMap<string, PositionRow> {
  const latest = new Map<string, PositionRow>()
  for (const row of snapshots) {
    if (row.asOf > asOf) continue
    const current = latest.get(row.instrumentId)
    if (current === undefined || row.asOf > current.asOf) latest.set(row.instrumentId, row)
  }
  return latest
}

function reconcile(
  ledger: LotLedger,
  snapshot: PositionRow,
  instrument: InstrumentRef,
): Reconciliation {
  // Compared as at the *snapshot's* date, not today's. A statement balance from three weeks ago
  // says nothing about a trade made last Tuesday, and comparing it against the current folded
  // quantity would report every recently active holding as failing reconciliation.
  const folded = quantityOn(ledger, instantToDate(snapshot.asOf))
  const difference = absDec(subDec(folded, snapshot.quantity))
  const tolerance = tenPowNegative(instrument.precision)
  return {
    instrumentId: ledger.instrumentId,
    foldedQuantity: folded,
    snapshotQuantity: snapshot.quantity,
    snapshotAsOf: snapshot.asOf,
    agrees: compareDec(difference, tolerance) <= 0,
    ratio: isZeroDec(snapshot.quantity) ? null : divDec(folded, snapshot.quantity),
  }
}

/** Within 0.1% of a recorded corporate-action multiplier, which points straight at the cause. */
function matchesActionMultiplier(ratio: Dec, ledger: LotLedger): Dec | null {
  for (const action of ledger.corporateActions) {
    if (action.multiplier === null) continue
    const relative = absDec(subDec(divDec(ratio, action.multiplier), dec('1')))
    if (compareDec(relative, dec('0.001')) <= 0) return action.multiplier
  }
  return null
}

/**
 * Derive one account's positions.
 *
 * `Err` is reserved for malformed input. Every data defect downgrades measurement and rides along
 * in the warnings list, because one unmeasurable holding must not blank the whole account.
 */
export function derivePositions(input: FoldInput): Result<readonly DerivedPosition[]> {
  const snapshots = latestSnapshots(input.snapshots, input.asOf)

  if (input.capability === 'snapshot') {
    const positions = [...snapshots.values()]
      .sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1))
      .map<DerivedPosition>((row) => ({
        accountId: input.accountId,
        instrumentId: row.instrumentId,
        quantity: row.quantity,
        asOf: row.asOf,
        basis: 'snapshot',
        measurement: 'not_measured',
        reason: SNAPSHOT_REASON,
        lots: [],
        provenance: [row.sourceDocumentId],
        quantitySuspect: false,
        ledger: null,
        reconciliation: null,
      }))
    return ok(positions)
  }

  const folded = buildLots(input)
  if (!folded.ok) return folded

  const warnings: Warning[] = [...folded.warnings]
  const positions: DerivedPosition[] = []

  for (const [instrumentId, ledger] of folded.value) {
    const instrument = input.instruments.get(instrumentId)
    if (instrument === undefined) {
      return err({
        code: 'UNKNOWN_INSTRUMENT',
        message: `No instrument metadata supplied for ${instrumentId}.`,
        ref: { instrumentId },
      })
    }
    const snapshot = snapshots.get(instrumentId)
    const reconciliation = snapshot === undefined ? null : reconcile(ledger, snapshot, instrument)

    let measurement = ledger.measurement
    let reason = ledger.reason
    let quantity = ledger.quantity
    let lots = ledger.open

    if (reconciliation !== null && !reconciliation.agrees) {
      const doubled =
        reconciliation.ratio === null ? null : matchesActionMultiplier(reconciliation.ratio, ledger)
      const explanation =
        doubled === null
          ? 'The transaction history and the statement balance disagree.'
          : `The transaction history and the statement balance differ by ${doubled}, which is a corporate-action ratio for this holding — the statement's pre-split trades were most likely already restated in post-split units and the split has been applied twice.`
      warnings.push({
        code: 'FOLD_SNAPSHOT_MISMATCH',
        message: `${explanation} Folded ${reconciliation.foldedQuantity} against a reported ${reconciliation.snapshotQuantity}.`,
        ref: { accountId: input.accountId, instrumentId },
      })
      measurement = 'not_measured'
      reason = {
        status: 'not_measured',
        code: 'FOLD_SNAPSHOT_MISMATCH',
        message: explanation,
        userFixable: true,
      }
      // The snapshot quantity is corroborated by the statement, so it is reported; cost basis and
      // P&L are withheld because the lot chain that produced the disagreement cannot be trusted.
      quantity = reconciliation.snapshotQuantity
      lots = []
    }

    positions.push({
      accountId: input.accountId,
      instrumentId,
      quantity,
      asOf: input.asOf,
      basis: 'folded',
      measurement,
      reason,
      lots: measurement === 'measured' ? lots : [],
      provenance: ledger.provenance,
      quantitySuspect: false,
      ledger,
      reconciliation,
    })
  }

  // A snapshot row for an instrument the ledger never mentions is still a holding. It is reported
  // from the snapshot rather than dropped, because dropping it would understate net worth.
  for (const [instrumentId, row] of snapshots) {
    if (folded.value.has(instrumentId)) continue
    positions.push({
      accountId: input.accountId,
      instrumentId,
      quantity: row.quantity,
      asOf: row.asOf,
      basis: 'snapshot',
      measurement: 'not_measured',
      reason: {
        status: 'not_measured',
        code: 'FOLD_SNAPSHOT_MISMATCH',
        message: 'This holding appears in a statement balance but has no transactions in the ledger.',
        userFixable: true,
      },
      lots: [],
      provenance: [row.sourceDocumentId],
      quantitySuspect: false,
      ledger: null,
      reconciliation: null,
    })
  }

  positions.sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1))
  return ok(positions, warnings)
}

interface ActionRecord {
  readonly accountId: string
  readonly date: IsoDate
}

/**
 * Derive positions across every account, then apply the one check that is only visible portfolio-
 * wide: a corporate action recorded in one account's statement and missing from another's.
 *
 * `txn` rows belong to an account, so a market-wide split is recorded once per account and only if
 * that account's statement mentioned it. An account that held the instrument across the ex-date
 * without a matching action row has a quantity that is wrong by the ratio, and it is not
 * detectable from that account alone.
 */
export function derivePortfolioPositions(
  inputs: readonly FoldInput[],
): Result<readonly DerivedPosition[]> {
  const all: DerivedPosition[] = []
  const warnings: Warning[] = []
  for (const input of inputs) {
    const derived = derivePositions(input)
    if (!derived.ok) return derived
    all.push(...derived.value)
    warnings.push(...derived.warnings)
  }

  const actionsByInstrument = new Map<string, ActionRecord[]>()
  for (const position of all) {
    if (position.ledger === null) continue
    for (const action of position.ledger.corporateActions) {
      const list = actionsByInstrument.get(position.instrumentId)
      const record: ActionRecord = { accountId: position.accountId, date: action.date }
      if (list === undefined) actionsByInstrument.set(position.instrumentId, [record])
      else list.push(record)
    }
  }

  const adjusted = all.map<DerivedPosition>((position) => {
    const actions = actionsByInstrument.get(position.instrumentId)
    const ledger = position.ledger
    if (actions === undefined || ledger === null) return position
    const missing = actions.filter(
      (action) =>
        action.accountId !== position.accountId &&
        !ledger.corporateActions.some((own) => own.date === action.date) &&
        !isZeroDec(quantityOn(ledger, action.date)),
    )
    if (missing.length === 0) return position
    const dates = missing.map((m) => m.date).join(', ')
    warnings.push({
      code: 'CORPORATE_ACTION_MISSING_IN_ACCOUNT',
      message: `A corporate action on ${dates} is recorded for this instrument in another account but not in this one, and this account held units across that date. Its quantity is out by the action's ratio.`,
      ref: { accountId: position.accountId, instrumentId: position.instrumentId },
    })
    return {
      ...position,
      measurement: 'not_measured',
      reason: {
        status: 'not_measured',
        code: 'CORPORATE_ACTION_MISSING_IN_ACCOUNT',
        message: `A corporate action on ${dates} is missing from this account's statements.`,
        userFixable: true,
      },
      lots: [],
      // No snapshot corroborates the quantity, so it is flagged rather than counted silently.
      quantitySuspect: position.reconciliation === null,
    }
  })

  return ok(adjusted, warnings)
}

/** Convenience for callers that hold instants and want the valuation date. */
export function valuationDate(asOf: IsoInstant): IsoDate {
  return instantToDate(asOf)
}

/** Total open-lot quantity of a derived position, for tests and for the UI's quantity column. */
export function positionQuantity(position: DerivedPosition): Dec {
  if (position.lots.length === 0) return position.quantity
  return addDec(...position.lots.map((lot) => lot.quantity))
}
