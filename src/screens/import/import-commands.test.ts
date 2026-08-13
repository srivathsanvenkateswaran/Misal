/**
 * The commands the import screen depends on, checked by name.
 *
 * `defaultRuntime` wires the pipeline's stand-aside to `ingest_outstanding_for_document`, and every
 * screen test injects its own runtime instead — so a misspelled command name would be invisible
 * until a user re-imported a statement whose rows never landed and was told nothing happened. The
 * argument key matters as much: Tauri matches parameters by name.
 */

import { describe, expect, it } from 'vitest'
import {
  outstandingForDocument,
  withheldForDocument,
  type Invoker,
} from '../../data/import'

function recorder(answer: unknown): { call: Invoker; seen: { command: string; args?: unknown }[] } {
  const seen: { command: string; args?: unknown }[] = []
  const call: Invoker = <T,>(command: string, args?: Record<string, unknown>) => {
    seen.push({ command, ...(args === undefined ? {} : { args }) })
    return Promise.resolve(answer as T)
  }
  return { call, seen }
}

describe('the review-queue reads the import screen makes', () => {
  it('asks the core whether this document still owes the ledger rows', async () => {
    const { call, seen } = recorder(true)
    await expect(outstandingForDocument('doc-1', call)).resolves.toBe(true)
    expect(seen).toEqual([
      { command: 'ingest_outstanding_for_document', args: { documentId: 'doc-1' } },
    ])
  })

  it('still asks what the queue is withholding, which is a different question', async () => {
    const { call, seen } = recorder(2)
    await expect(withheldForDocument('doc-1', call)).resolves.toBe(2)
    expect(seen).toEqual([
      { command: 'ingest_withheld_for_document', args: { documentId: 'doc-1' } },
    ])
  })
})
