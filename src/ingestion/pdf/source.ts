/**
 * Opening a PDF: passwords, ciphers and scans.
 *
 * The password rules here are the part of this subsystem most likely to be got wrong by
 * borrowing from prior art. The widely repeated claim that "CAS PDFs are encrypted with the
 * investor's PAN" — it appears in the docstring of the reference Python implementation — is true
 * only for the depository eCAS. The CAMS/KFintech request form has explicit PASSWORD and CONFIRM
 * PASSWORD fields and the delivery email says to use the password submitted with the request.
 * Prompting a CAMS user for their PAN is wrong, and will make them think the app is asking for
 * something it should not.
 *
 * A password is a function argument and nothing else. It is never persisted, never written to
 * `import_issue.raw_payload`, never logged. What *is* recorded is which form succeeded, because
 * that is diagnostically useful and carries no secret.
 */

import { DOCUMENT_MESSAGE } from '../codes'
import { DocumentFailure } from '../issues'
import type { PdfMeta, RawPdfPage } from '../types'

export type PasswordStyle = 'user-chosen' | 'pan-uppercase'

export interface PasswordHint {
  readonly providerId: string
  readonly style: PasswordStyle
  readonly message: string
}

/** What the user typed. The date of birth is only ever used to compose a candidate in memory. */
export interface PasswordAttempt {
  readonly password: string
  /** DDMMYYYY, for the depository PAN+DOB variant. Never stored. */
  readonly dateOfBirth?: string
}

export type PasswordPrompt = (
  attempt: number,
  hint: PasswordHint,
) => Promise<string | PasswordAttempt | null>

export const PASSWORD_HINTS: Record<string, PasswordHint> = {
  'cams-kfin-cas': {
    providerId: 'cams-kfin-cas',
    style: 'user-chosen',
    message: 'Enter the password you chose when you requested the statement.',
  },
  'nsdl-ecas': {
    providerId: 'nsdl-ecas',
    style: 'pan-uppercase',
    message: 'Enter the PAN of the first account holder, in capitals.',
  },
  'cdsl-ecas': {
    providerId: 'cdsl-ecas',
    style: 'pan-uppercase',
    message: 'Enter the PAN of the first account holder, in capitals.',
  },
}

export const GENERIC_PASSWORD_HINT: PasswordHint = {
  providerId: 'unknown',
  style: 'user-chosen',
  message: 'This statement is password protected.',
}

/** pdf.js distinguishes "needs a password" (code 1) from "wrong password" (code 2). */
export class PdfPasswordError extends Error {
  override readonly name = 'PdfPasswordError'
  readonly needsPassword: boolean

  constructor(needsPassword: boolean, message: string) {
    super(message)
    this.needsPassword = needsPassword
  }
}

export class PdfCipherError extends Error {
  override readonly name = 'PdfCipherError'
}

export interface LoadedPdf {
  readonly meta: PdfMeta
  readonly pages: readonly RawPdfPage[]
  /**
   * Whether the page operator lists paint images. Expensive, so it is only asked when the cheap
   * character-count test already suspects a scan.
   */
  hasImageOperators(): Promise<boolean>
}

export interface PdfSource {
  open(bytes: Uint8Array, password: string): Promise<LoadedPdf>
}

/** Which candidate opened the file. Recorded; the value never is. */
export type PasswordForm = 'empty' | 'as-typed' | 'uppercased' | 'pan-with-dob'

export interface OpenedPdf {
  readonly pdf: LoadedPdf
  readonly form: PasswordForm
}

const MAX_ROUNDS = 3

/**
 * Open a PDF, prompting for a password up to three times.
 *
 * Rule 1 is to try the empty password first: some depository files and most re-prints are not
 * encrypted at all, and prompting for a password a file does not have is the fastest way to make
 * a user distrust an application that handles their money.
 */
export async function openPdf(
  source: PdfSource,
  bytes: Uint8Array,
  hint: PasswordHint,
  prompt: PasswordPrompt | undefined,
): Promise<OpenedPdf> {
  try {
    return { pdf: await source.open(bytes, ''), form: 'empty' }
  } catch (error) {
    if (error instanceof PdfCipherError) {
      throw new DocumentFailure('E_PDF_CIPHER', DOCUMENT_MESSAGE.E_PDF_CIPHER)
    }
    if (!(error instanceof PdfPasswordError)) throw error
  }

  if (prompt === undefined) {
    throw new DocumentFailure('E_PASSWORD_REQUIRED', `${DOCUMENT_MESSAGE.E_PASSWORD_REQUIRED} ${hint.message}`)
  }

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const answer = await prompt(round, hint)
    if (answer === null) {
      throw new DocumentFailure(
        'E_PASSWORD_REQUIRED',
        `${DOCUMENT_MESSAGE.E_PASSWORD_REQUIRED} ${hint.message}`,
      )
    }
    const attempt: PasswordAttempt = typeof answer === 'string' ? { password: answer } : answer

    for (const candidate of candidates(attempt, hint.style)) {
      try {
        return { pdf: await source.open(bytes, candidate.value), form: candidate.form }
      } catch (error) {
        if (error instanceof PdfCipherError) {
          throw new DocumentFailure('E_PDF_CIPHER', DOCUMENT_MESSAGE.E_PDF_CIPHER)
        }
        if (!(error instanceof PdfPasswordError)) throw error
      }
    }
  }

  throw new DocumentFailure('E_PASSWORD_INCORRECT', `${DOCUMENT_MESSAGE.E_PASSWORD_INCORRECT} ${hint.message}`)
}

interface Candidate {
  readonly value: string
  readonly form: PasswordForm
}

/**
 * The candidates tried for one prompt round.
 *
 * For a depository file the uppercase PAN is tried first because that is what both depositories'
 * published FAQs state. The PAN+DDMMYYYY variant is repeated widely enough on forums that one
 * silent retry is cheaper than a support thread, and it only ever happens when the user has
 * supplied a date of birth to compose it from.
 */
function candidates(attempt: PasswordAttempt, style: PasswordStyle): Candidate[] {
  const typed = attempt.password
  if (style === 'user-chosen') return [{ value: typed, form: 'as-typed' }]

  const upper = typed.toUpperCase()
  const out: Candidate[] = [{ value: upper, form: 'uppercased' }]
  if (upper !== typed) out.push({ value: typed, form: 'as-typed' })
  if (attempt.dateOfBirth !== undefined && attempt.dateOfBirth !== '') {
    out.push({ value: `${upper}${attempt.dateOfBirth}`, form: 'pan-with-dob' })
  }
  return out
}

/** Below this many non-whitespace characters per page, a text layer is suspect. */
const CHARACTERS_PER_PAGE = 50

/**
 * Refuse a scan.
 *
 * Two stages because the reliable test is the expensive one: count characters first, and only ask
 * for the operator list when the count already looks wrong. CAS PDFs are always text-based, so a
 * scan means the user has photographed or re-printed something, and the message must offer the
 * two real remedies rather than just refusing.
 */
export async function assertNotScanned(pdf: LoadedPdf): Promise<void> {
  let characters = 0
  for (const page of pdf.pages) {
    for (const item of page.items) characters += item.text.replace(/\s+/g, '').length
  }
  const pageCount = pdf.pages.length === 0 ? 1 : pdf.pages.length
  if (characters >= CHARACTERS_PER_PAGE * pageCount) return
  if (await pdf.hasImageOperators()) {
    throw new DocumentFailure('E_SCANNED_PDF', DOCUMENT_MESSAGE.E_SCANNED_PDF)
  }
  // Sparse but genuinely textual: a cover page, or a one-holding statement. Not a scan.
}
