/**
 * The CSV mapping descriptor, as a Zod schema.
 *
 * The bet this makes: a stranger can add a broker without breaking anyone's numbers. Procedural
 * parsing code makes that a review of arbitrary logic with database access. A descriptor makes it
 * a data review against a schema, testable purely from a fixture, with no way to express "guess
 * this instrument" or "round this number".
 *
 * Three constraints on the format are load-bearing and are enforced here rather than by
 * convention:
 *
 *   - `ComputedExpr` is four operations, not an expression language. A descriptor that can run
 *     arbitrary arithmetic is a code review again.
 *   - Delimiter and encoding are mandatory and never sniffed. Auto-detection silently corrupts a
 *     file with an embedded semicolon or a lone BOM.
 *   - Every object is strict. A typo'd key that passes silently is a mapping the contributor
 *     believes is active and is not.
 */

import { z } from 'zod'

/** Numeric field names the pipeline understands. A descriptor cannot invent one. */
export const TRANSACTION_FIELDS = [
  'date',
  'description',
  'quantity',
  'price',
  'amount',
  'fees',
  'brokerage',
  'stt',
  'gst',
  'stampDuty',
  'tds',
  'fxRate',
  'balanceAfter',
] as const

export const POSITION_FIELDS = ['asOf', 'quantity', 'marketValue'] as const

const numericTransform = z.strictObject({
  /** Characters stripped before parsing, on top of the always-stripped grouping and glyphs. */
  strip: z.array(z.string()).optional(),
  /** How the source encodes a negative value. */
  negative: z.enum(['leading-minus', 'trailing-minus', 'parentheses', 'never']).optional(),
  /** Flip the sign when another column matches. Anchored regexes or literals. */
  signFrom: z
    .strictObject({ column: z.string(), negativeWhen: z.array(z.string()).min(1) })
    .optional(),
  /** Reject rather than round when precision exceeds the currency's exponent. */
  onExcessPrecision: z.enum(['round-half-up', 'error']).optional(),
})

const computedExpr = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('multiply'), left: z.string(), right: z.string() }),
  z.strictObject({ op: z.literal('add'), terms: z.array(z.string()).min(2) }),
  z.strictObject({ op: z.literal('negate'), of: z.string() }),
  z.strictObject({ op: z.literal('abs'), of: z.string() }),
])

const columnRule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('date'), column: z.string(), format: z.string() }),
  z.strictObject({ kind: z.literal('decimal'), column: z.string(), transform: numericTransform.optional() }),
  z.strictObject({ kind: z.literal('money'), column: z.string(), transform: numericTransform.optional() }),
  z.strictObject({ kind: z.literal('text'), column: z.string() }),
  z.strictObject({ kind: z.literal('constant'), value: z.string() }),
  z.strictObject({ kind: z.literal('computed'), expr: computedExpr }),
])

export type MatchExpr =
  | { readonly column: string; readonly equals: readonly string[]; readonly ignoreCase?: boolean | undefined }
  | { readonly column: string; readonly matches: string }
  | { readonly column: string; readonly sign: 'positive' | 'negative' | 'zero' }
  | { readonly all: readonly MatchExpr[] }
  | { readonly any: readonly MatchExpr[] }

const matchExpr: z.ZodType<MatchExpr> = z.lazy(() =>
  z.union([
    z.strictObject({
      column: z.string(),
      equals: z.array(z.string()).min(1),
      ignoreCase: z.boolean().optional(),
    }),
    z.strictObject({ column: z.string(), matches: z.string() }),
    z.strictObject({ column: z.string(), sign: z.enum(['positive', 'negative', 'zero']) }),
    z.strictObject({ all: z.array(matchExpr).min(1) }),
    z.strictObject({ any: z.array(matchExpr).min(1) }),
  ]),
)

const txnType = z.enum([
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

export const csvDescriptorSchema = z.strictObject({
  descriptorVersion: z.literal(1),
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  emits: z.enum(['transactions', 'positions']),
  capability: z.enum(['ledger', 'snapshot']),

  detect: z.strictObject({
    /** All must be present, case- and whitespace-insensitively. */
    requiredHeaders: z.array(z.string()).min(1),
    /** Optional headers that raise confidence when present. */
    signalHeaders: z.array(z.string()).optional(),
    /** Literal text that must appear somewhere in the preamble rows. */
    preambleContains: z.array(z.string()).optional(),
  }),

  file: z.strictObject({
    delimiter: z.string().min(1),
    encoding: z.enum(['utf-8', 'utf-16le', 'windows-1252']),
    headerRow: z.union([z.literal('auto'), z.number().int().nonnegative()]),
    /** Anchored regexes; a matching row is skipped, not failed. */
    skipRowsMatching: z.array(z.string()).optional(),
    timezone: z.string().min(1),
    currency: z.union([z.string().min(1), z.strictObject({ column: z.string() })]),
  }),

  account: z.strictObject({
    realm: z.enum(['demat', 'mf-folio', 'broker', 'exchange']),
    /** Template over column names: 'demat:{dp_id}-{client_id}'. */
    keyTemplate: z.string().optional(),
    /** Single-account exports. */
    constant: z.string().optional(),
    labelTemplate: z.string().min(1),
  }),

  instrument: z.strictObject({
    isin: z.string().optional(),
    amfiCode: z.string().optional(),
    symbol: z.string().optional(),
    exchange: z
      .union([z.string(), z.strictObject({ constant: z.enum(['NSE', 'BSE', 'NASDAQ', 'NYSE']) })])
      .optional(),
    providerLocalId: z.string().optional(),
    name: z.string().min(1),
    assetClassHint: z.union([z.string(), z.strictObject({ constant: z.string() })]).optional(),
  }),

  columns: z.record(z.string(), columnRule),
  typeRules: z.array(z.strictObject({ when: matchExpr, type: txnType })).optional(),
  postconditions: z
    .array(
      z.strictObject({
        kind: z.enum(['running-balance', 'row-total', 'non-empty']),
        params: z.record(z.string(), z.string()),
        severity: z.enum(['error', 'warning']),
      }),
    )
    .optional(),
})

export type CsvDescriptor = z.infer<typeof csvDescriptorSchema>
export type ColumnRule = z.infer<typeof columnRule>
export type NumericTransform = z.infer<typeof numericTransform>
export type ComputedExpr = z.infer<typeof computedExpr>
export type Postcondition = NonNullable<CsvDescriptor['postconditions']>[number]
