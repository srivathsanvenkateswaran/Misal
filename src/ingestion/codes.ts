/**
 * The issue taxonomy.
 *
 * `E_` fails something, `W_` never does. Document-level errors fail the whole file; row-level
 * errors fail exactly one row and the import still commits everything else, which is the first
 * non-negotiable of this subsystem: one bad row never fails an import.
 *
 * Codes are a closed union rather than free strings so that a typo cannot invent a code the
 * import report has no wording for.
 */

/** Fails the document. */
export type DocumentCode =
  | 'E_PASSWORD_REQUIRED'
  | 'E_PASSWORD_INCORRECT'
  | 'E_PDF_CIPHER'
  | 'E_SCANNED_PDF'
  | 'E_UNKNOWN_FORMAT'
  | 'E_AMBIGUOUS_FORMAT'
  | 'E_DP_STATEMENT'
  | 'E_MFCENTRAL_UNSUPPORTED'
  | 'E_DESCRIPTOR_INVALID'
  | 'E_PLUGIN_CRASH'
  | 'E_HEADER_NOT_FOUND'
  /**
   * Not in the spec's table. A descriptor postcondition of severity `error` has to land
   * somewhere, and reusing E_UNKNOWN_FORMAT would tell the user the file was unrecognised when
   * in fact it was recognised and found wanting.
   */
  | 'E_POSTCONDITION_FAILED'

/** Fails one row. */
export type RowCode =
  | 'E_DATE_PARSE'
  | 'E_NUMERIC_PARSE'
  | 'E_AMOUNT_PRECISION'
  | 'E_MISSING_COLUMN'
  | 'E_MISSING_REQUIRED_FIELD'
  | 'E_UNCLASSIFIED_TRANSACTION'
  | 'E_ROW_SHAPE'

export type WarningCode =
  | 'W_UNRESOLVED_INSTRUMENT'
  | 'W_BALANCE_MISMATCH'
  | 'W_INCOMPLETE_HISTORY'
  | 'W_AMOUNT_ROUNDED'
  | 'W_DUPLICATE_IN_DOCUMENT'
  | 'W_POSITION_RESTATED'
  | 'W_FEES_ABSENT'
  | 'W_CAPABILITY_DOWNGRADE'
  | 'W_UNKNOWN_SECTION'
  /**
   * A mutual fund folio's AMC is not in the canonical registry, so the folio holds a provisional
   * identity rather than a canonical one. Never silent: an unrecognised house is the one case
   * where the identity key cannot promise that two statements will agree, and the user is the
   * person who finds out first when they do not.
   */
  | 'W_AMC_UNRECOGNISED'
  /** The AMC name printed against a folio names a different house than its ISIN does. */
  | 'W_AMC_NAME_CONFLICT'

export type IssueCode = DocumentCode | RowCode | WarningCode

export type Severity = 'error' | 'warning'

/**
 * User-facing copy for the document-level failures.
 *
 * Held here rather than in the UI so that a new failure mode ships its own wording, and so that
 * the message the user reads is reviewable in the same diff as the code that raises it.
 */
export const DOCUMENT_MESSAGE: Record<DocumentCode, string> = {
  E_PASSWORD_REQUIRED: 'This statement is password protected.',
  E_PASSWORD_INCORRECT: 'That password did not open the statement.',
  E_PDF_CIPHER: 'Unsupported PDF encryption.',
  E_SCANNED_PDF:
    'This looks like a scan or a photo, so there is no text to read. Request a fresh statement ' +
    'from the registrar, or import the broker CSV instead.',
  E_UNKNOWN_FORMAT: 'Not a statement Misal recognises.',
  E_AMBIGUOUS_FORMAT: 'Two parsers claim this file. This is a bug in Misal, not in your file.',
  E_DP_STATEMENT:
    'This is a depository participant transaction statement, not a consolidated account ' +
    'statement. Misal does not read it.',
  E_MFCENTRAL_UNSUPPORTED: 'MF Central statements are not supported.',
  E_DESCRIPTOR_INVALID: 'The mapping descriptor for this file is not valid.',
  E_PLUGIN_CRASH: 'The parser failed partway through. Everything read before the failure was kept.',
  E_HEADER_NOT_FOUND: 'Could not find the header row in this file.',
  E_POSTCONDITION_FAILED: 'This file did not satisfy a check its mapping declares.',
}
