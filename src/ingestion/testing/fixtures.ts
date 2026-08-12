/**
 * Fixture and golden-file plumbing.
 *
 * The corpus is the project's most valuable asset after the schema, and also the one most likely
 * to leak somebody's net worth. Everything under `tests/fixtures/` is synthetic or produced by
 * the redaction tool; a real statement never enters the repository. There is prior art for how
 * badly this goes — several public repositories contain unredacted CAS text dumps with live PANs,
 * folio numbers and holdings.
 *
 * `MISAL_UPDATE_GOLDEN=1 pnpm test` rewrites the golden files. That is `misal fixtures record`:
 * the contributor eyeballs the resulting JSON and commits it, and the reviewer reads that diff
 * rather than the parser logic.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadDescriptor } from '../csv/load'
import type { CsvDescriptor } from '../csv/descriptor'
import type { RawPdfPage } from '../types'

// `import.meta.url` is an http URL under the jsdom environment, so paths are resolved from the
// working directory instead. Vitest runs from the repository root.
export function repoPath(relative: string): string {
  return resolve(process.cwd(), relative)
}

export function fixturePath(relative: string): string {
  return repoPath(`tests/fixtures/${relative}`)
}

export function readFixtureBytes(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(relative)))
}

export function readFixtureText(relative: string): string {
  return readFileSync(fixturePath(relative), 'utf-8')
}

export function readPdfTextFixture(relative: string): RawPdfPage[] {
  return JSON.parse(readFixtureText(relative)) as RawPdfPage[]
}

/** Load one of the descriptors shipped in the repository, failing loudly if it is invalid. */
export function builtinDescriptor(id: string): CsvDescriptor {
  const source = readFileSync(repoPath(`src/ingestion/csv/descriptors/${id}.yaml`), 'utf-8')
  const result = loadDescriptor(source, `${id}.yaml`)
  if (!result.ok) throw new Error(`${id}.yaml is not a valid descriptor:\n${result.text}`)
  return result.descriptor
}

export const BUILTIN_DESCRIPTOR_IDS = [
  'zerodha-console-tradebook',
  'mybroker-account-statement',
] as const

const UPDATING = process.env['MISAL_UPDATE_GOLDEN'] === '1'

/**
 * Compare against a golden file, or rewrite it when recording.
 *
 * Returns the expected text so the caller can assert on it, which keeps the assertion in the test
 * where a failure message is readable.
 */
export function golden(relative: string, actual: string): string {
  const path = fixturePath(relative)
  if (UPDATING) {
    writeFileSync(path, actual, 'utf-8')
    return actual
  }
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    throw new Error(
      `golden file ${relative} does not exist. Run MISAL_UPDATE_GOLDEN=1 pnpm test and review the diff.`,
    )
  }
}
