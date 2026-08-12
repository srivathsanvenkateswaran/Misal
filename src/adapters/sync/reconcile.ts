/**
 * Coverage reconciliation: folding the transactions we ingested and comparing them against the
 * balance the exchange reports.
 *
 * A mismatch is expected, not exceptional - a deposit from an external wallet, a staking reward,
 * a Binance Convert trade that never appears in trade history, a fill in a pair we never
 * enumerated. So it is recorded as a warning, never an error, and the sync completes.
 *
 * This is the feature, not the consolation prize. It measures exactly how incomplete the trade
 * history is, and that measurement is the evidence behind keeping crypto accounts `snapshot`:
 * `ledger` unlocks XIRR and realised P&L, and claiming it on a history we cannot demonstrate is
 * complete produces confidently wrong numbers. When the fold matches the balance exactly across
 * the full history, an account could be upgraded - that is v2, but the check that would justify
 * it is built now.
 */

import { type Dec, ZERO_DEC, compareDec, isZeroDec, subDec } from '@domain/numeric'
import type { SyncStore } from './store'

export interface CoverageRow {
  readonly instrumentId: string
  /** Sum of ingested transaction quantities. */
  readonly folded: Dec
  /** What the exchange says is held. */
  readonly reported: Dec
  /** reported - folded. Positive means holdings we have no transactions for. */
  readonly difference: Dec
  readonly matches: boolean
}

export async function reconcileCoverage(
  store: SyncStore,
  accountId: string,
  reportedByInstrument: ReadonlyMap<string, Dec>,
): Promise<readonly CoverageRow[]> {
  const folded = await store.foldQuantities(accountId)

  const instrumentIds = new Set<string>([...folded.keys(), ...reportedByInstrument.keys()])
  const rows: CoverageRow[] = []

  for (const instrumentId of [...instrumentIds].sort()) {
    const foldedQuantity = folded.get(instrumentId) ?? ZERO_DEC
    const reported = reportedByInstrument.get(instrumentId) ?? ZERO_DEC
    const difference = subDec(reported, foldedQuantity)
    rows.push({
      instrumentId,
      folded: foldedQuantity,
      reported,
      difference,
      // Exact comparison. A tolerance here would be a threshold below which we quietly claim
      // coverage we do not have, and the whole point of the check is that it does not do that.
      matches: isZeroDec(difference),
    })
  }

  return rows
}

/** Instruments the exchange reports but we have no transactions for at all. */
export function unexplainedHoldings(rows: readonly CoverageRow[]): readonly CoverageRow[] {
  return rows.filter((row) => isZeroDec(row.folded) && compareDec(row.reported, ZERO_DEC) !== 0)
}
