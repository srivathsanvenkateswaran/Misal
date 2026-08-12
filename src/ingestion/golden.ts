/**
 * Golden files: the canonical JSON of the **normalized** records.
 *
 * Stopping at normalize is deliberate. Resolution depends on the local instrument catalogue, so a
 * golden file carrying an `instrument_id` would encode one machine's database state and break for
 * every contributor. Resolve, reconcile and commit are tested separately against a seeded store.
 *
 * Serialisation is canonical — keys sorted, records sorted by (accountKey, date, ref), two-space
 * indent, trailing newline — because the diff *is* the review. A reviewer reads the change in
 * expected output, not the parser logic that produced it.
 */

import { CollectingSink, type ExtractPlugin } from './plugin'
import { IssueCollector, type Issue } from './issues'
import { normalizeRecord } from './normalize'
import type { DecodedInput, NormalizedRecord } from './types'

export interface GoldenRun {
  readonly records: readonly NormalizedRecord[]
  readonly issues: readonly Issue[]
  readonly skipped: readonly { ref: string; reason: string }[]
}

/** Run a plugin through extract and normalize. The implementation of `misal fixtures record`. */
export async function recordGolden(plugin: ExtractPlugin, input: DecodedInput): Promise<GoldenRun> {
  const sink = new CollectingSink()
  await plugin.extract(input, sink)

  const issues = new IssueCollector()
  for (const raw of sink.issues) {
    issues.add({
      severity: raw.severity,
      code: raw.code,
      message: raw.message,
      ...(raw.ref !== undefined ? { ref: raw.ref } : {}),
      ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
    })
  }

  const records: NormalizedRecord[] = []
  for (const record of sink.records) {
    records.push(...normalizeRecord(record, (issue) => issues.add(issue)))
  }

  return { records, issues: issues.all(), skipped: sink.skips }
}

export function serializeGolden(run: GoldenRun): string {
  const body = {
    records: [...run.records].sort(compareRecords).map(canonical),
    issues: run.issues.map(canonical),
    skipped: run.skipped.map(canonical),
  }
  return `${JSON.stringify(canonical(body), null, 2)}\n`
}

function compareRecords(a: NormalizedRecord, b: NormalizedRecord): number {
  const byAccount = a.accountKey.localeCompare(b.accountKey)
  if (byAccount !== 0) return byAccount
  const byDate = dateOf(a).localeCompare(dateOf(b))
  if (byDate !== 0) return byDate
  return a.origin.ref.localeCompare(b.origin.ref)
}

function dateOf(record: NormalizedRecord): string {
  if (record.kind === 'transaction') return record.occurredDate
  if (record.kind === 'position') return record.asOfDate
  return ''
}

/** Sort every object's keys, recursively. Arrays keep their order, which is meaningful. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const out: Record<string, unknown> = {}
  for (const [key, item] of entries) out[key] = canonical(item)
  return out
}
