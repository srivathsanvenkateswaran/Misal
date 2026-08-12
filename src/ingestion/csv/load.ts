/**
 * Loading a descriptor from YAML, with errors a contributor can act on.
 *
 * Zod gives an issue path; the `yaml` parser exposes source ranges for every node. Joining the two
 * turns "invalid enum value at columns.date.kind" into a line, a column and the offending text.
 * That pairing is the single highest-leverage thing available for descriptor authoring, and it is
 * why `ajv` was rejected as well as why the YAML is parsed as a document rather than with a plain
 * `parse`.
 *
 * One YAML trap worth stating for contributors: both major YAML libraries coerce `007` to `7` and
 * `1234.5000` to `1234.5`. Descriptors hold column names and format tokens rather than values, so
 * this is mostly theoretical — but any value-bearing field must be quoted.
 */

import { LineCounter, parseDocument } from 'yaml'
import { z } from 'zod'
import { csvDescriptorSchema, type CsvDescriptor } from './descriptor'

export interface DescriptorError {
  readonly path: string
  readonly message: string
  readonly line: number | null
  readonly column: number | null
}

export type DescriptorResult =
  | { readonly ok: true; readonly descriptor: CsvDescriptor }
  | { readonly ok: false; readonly errors: readonly DescriptorError[]; readonly text: string }

export function loadDescriptor(source: string, fileName = '<descriptor>'): DescriptorResult {
  const counter = new LineCounter()
  const document = parseDocument(source, { lineCounter: counter, keepSourceTokens: true })

  if (document.errors.length > 0) {
    return {
      ok: false,
      text: document.errors.map((e) => `${fileName}: ${e.message}`).join('\n'),
      errors: document.errors.map((e) => {
        const position = counter.linePos(e.pos[0])
        return { path: '', message: e.message, line: position.line, column: position.col }
      }),
    }
  }

  const parsed = csvDescriptorSchema.safeParse(document.toJS())
  if (parsed.success) return { ok: true, descriptor: parsed.data }

  const errors = parsed.error.issues.map((issue) => {
    const node: unknown = issue.path.length === 0 ? null : document.getIn(issue.path as never, true)
    const range = rangeOf(node)
    const position = range === null ? null : counter.linePos(range)
    return {
      path: issue.path.join('.'),
      message: issue.message,
      line: position?.line ?? null,
      column: position?.col ?? null,
    }
  })

  return {
    ok: false,
    errors,
    text: [
      z.prettifyError(parsed.error),
      ...errors
        .filter((e) => e.line !== null)
        .map((e) => `  ${fileName}:${String(e.line)}:${String(e.column)} — ${e.path}`),
    ].join('\n'),
  }
}

function rangeOf(node: unknown): number | null {
  if (node === null || typeof node !== 'object') return null
  const range: unknown = (node as { range?: unknown }).range
  if (!Array.isArray(range)) return null
  const start: unknown = range[0]
  return typeof start === 'number' ? start : null
}
