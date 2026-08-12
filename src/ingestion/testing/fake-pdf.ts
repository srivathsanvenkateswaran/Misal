/**
 * A PdfSource that serves fixture pages instead of decoding a real file.
 *
 * The password rules, the scanned-file detector and the failure taxonomy are all exercised
 * through this: they are logic about *responses*, and testing them against real encrypted PDFs
 * would mean committing PDFs, which the CI secrets scan refuses and the data policy forbids.
 * `pdfjs-source.test.ts` covers the real library separately, against a PDF built in memory.
 */

import type { LoadedPdf, PdfSource } from '../pdf/source'
import { PdfCipherError, PdfPasswordError } from '../pdf/source'
import type { PdfMeta, RawPdfPage } from '../types'

export interface FakePdfOptions {
  /** The password that opens it. An empty string means it is not encrypted. */
  readonly password?: string
  readonly info?: Record<string, string>
  /** Whether the page operator lists paint images, for the scanned-file check. */
  readonly hasImages?: boolean
  /** Fail with an unsupported-cipher error whatever the password. */
  readonly cipherUnsupported?: boolean
}

export function fakePdfSource(pages: readonly RawPdfPage[], options: FakePdfOptions = {}): PdfSource {
  const expected = options.password ?? ''
  return {
    open(_bytes: Uint8Array, password: string): Promise<LoadedPdf> {
      if (options.cipherUnsupported === true) {
        return Promise.reject(new PdfCipherError('unsupported encryption handler'))
      }
      if (password !== expected) {
        // Code 1 versus code 2: "needs a password" versus "wrong password", which is what lets
        // the UI word its prompt correctly.
        return Promise.reject(new PdfPasswordError(password === '', 'password required'))
      }
      const meta: PdfMeta = {
        pageCount: pages.length,
        info: options.info ?? {},
        encrypted: expected !== '',
        hasTextLayer: pages.some((page) => page.items.length > 0),
      }
      return Promise.resolve({
        meta,
        pages,
        hasImageOperators: () => Promise.resolve(options.hasImages ?? false),
      })
    },
  }
}

/**
 * Bytes that look like a PDF and hash differently per name.
 *
 * The pipeline hashes the bytes it was handed, so two fixtures that parse identically still need
 * different bytes to be two documents — which is also the real-world case the spec calls out: the
 * same statement re-downloaded with a different password hashes differently, and the natural key
 * is what catches the resulting duplicates.
 */
export function fakePdfBytes(name: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% synthetic fixture: ${name}\n`)
}
