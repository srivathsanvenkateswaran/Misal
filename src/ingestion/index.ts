/**
 * Subsystem B — statement ingestion.
 *
 * The public surface: run an import, register a plugin, load a descriptor. Everything else in
 * this directory is an implementation detail of the six stages.
 */

export type {
  AcquiredSource,
  Capability,
  DecimalString,
  DecodedInput,
  FeeBreakdown,
  NormalizedAccount,
  NormalizedPosition,
  NormalizedRecord,
  NormalizedTransaction,
  PdfPage,
  RawAccount,
  RawInstrumentRef,
  RawPdfPage,
  RawPosition,
  RawRecord,
  RawTransaction,
  SourceKind,
  TxnType,
} from './types'

export type { DocumentCode, IssueCode, RowCode, Severity, WarningCode } from './codes'
export { DOCUMENT_MESSAGE } from './codes'
export { DocumentFailure, type Issue, type RawIssue } from './issues'
export { type ExtractPlugin, type RecordSink, CollectingSink, selectPlugin } from './plugin'
export { runImport, type ImportCounters, type ImportDeps, type ImportOutcome, type ImportRequest } from './pipeline'
export { MemoryStore } from './memory-store'
export type * from './store'
export { recordGolden, serializeGolden, type GoldenRun } from './golden'

export { loadDescriptor, type DescriptorError, type DescriptorResult } from './csv/load'
export { csvDescriptorSchema, type CsvDescriptor } from './csv/descriptor'
export { csvDescriptorPlugin } from './csv/csv-plugin'

/**
 * The canonical AMC registry. Exported because a folio's fund house is now a resolved fact rather
 * than a string the document happened to print, and the UI should name it from here.
 */
export {
  AMC_REGISTRY,
  findByIsin,
  findByPrintedName,
  isinIssuerPrefix,
  type AmcEntry,
} from './amc/registry'
export {
  PROVISIONAL_MARKER,
  mfFolioIdentityKey,
  resolveAmc,
  type AmcResolution,
} from './amc/identity'

export { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
export { nsdlEcasPlugin } from './pdf/nsdl-ecas'
export { pdfjsSource, type PdfjsAssets } from './pdf/pdfjs-source'
export {
  GENERIC_PASSWORD_HINT,
  PASSWORD_HINTS,
  type PasswordAttempt,
  type PasswordHint,
  type PasswordPrompt,
  type PdfSource,
} from './pdf/source'

import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { csvDescriptorPlugin } from './csv/csv-plugin'
import { nsdlEcasPlugin } from './pdf/nsdl-ecas'
import type { CsvDescriptor } from './csv/descriptor'
import type { ExtractPlugin } from './plugin'

/**
 * Every plugin the application ships.
 *
 * CSV descriptors are passed in rather than imported, because loading them is I/O and this module
 * must stay importable from anywhere. The application reads `src/ingestion/csv/descriptors/` at
 * startup; the tests read the same directory.
 */
export function defaultPlugins(descriptors: readonly CsvDescriptor[] = []): ExtractPlugin[] {
  return [camsKfinCasPlugin, nsdlEcasPlugin, ...descriptors.map(csvDescriptorPlugin)]
}
