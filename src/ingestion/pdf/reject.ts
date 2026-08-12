/**
 * Documents that are recognised and refused by name.
 *
 * Silently half-parsing one of these is worse than refusing it: the user would get a partial
 * holding they had no reason to distrust. Both are detected before any plugin runs, because both
 * resemble a CAS closely enough that a detector might claim them.
 */

import { DOCUMENT_MESSAGE } from '../codes'
import { DocumentFailure } from '../issues'
import type { PdfPage } from '../types'

export function assertSupportedDocument(pages: readonly PdfPage[]): void {
  const text = pages
    .slice(0, 3)
    .flatMap((page) => page.lines.map((line) => line.text))
    .join('\n')
    .toUpperCase()

  // Issued by the depository participant rather than the depository, terminated by `~~~` rather
  // than `***`, and carrying two settlement-ID columns the CAS does not have.
  if (text.includes('~~~END OF STATEMENT~~~') || /\bTRANSACTION STATEMENT\b/.test(text)) {
    if (!text.includes('CONSOLIDATED ACCOUNT')) {
      throw new DocumentFailure('E_DP_STATEMENT', DOCUMENT_MESSAGE.E_DP_STATEMENT)
    }
  }

  // A different template from a portal whose future is uncertain: no running unit balance, so no
  // checksum and no ledger.
  if (text.includes('LOAD STRUCTURES') && text.includes('SUMMARY OF HOLDINGS AS ON')) {
    throw new DocumentFailure('E_MFCENTRAL_UNSUPPORTED', DOCUMENT_MESSAGE.E_MFCENTRAL_UNSUPPORTED)
  }
}
