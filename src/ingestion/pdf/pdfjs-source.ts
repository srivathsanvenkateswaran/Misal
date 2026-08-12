/**
 * The real PdfSource, on pdf.js.
 *
 * **The legacy build, not the modern one.** The modern worker calls `Math.sumPrecise`, which
 * shipped only in Safari 26.2, so macOS WKWebView — the Tauri default — throws at load on
 * anything older. The legacy build ships the polyfill. This import path is load-bearing and must
 * not be "simplified".
 *
 * pdf.js is used because it is the only maintained, permissively licensed JavaScript library that
 * both decrypts and exposes per-item coordinates, and this subsystem needs both. MuPDF is
 * technically the better tool and is disqualified by AGPL-3.0: shipping a desktop application is
 * distribution, and the licence would propagate to the whole of Misal.
 */

import type { DocumentInitParameters, TextItem as PdfTextItem } from 'pdfjs-dist/types/src/display/api'
import type { LoadedPdf, PdfSource } from './source'
import { PdfCipherError, PdfPasswordError } from './source'
import type { PdfMeta, RawPdfPage, TextItem } from '../types'

/**
 * Where the bundled font data lives.
 *
 * Indian CAS PDFs rely on non-embedded standard fonts and produce garbled text without them, so
 * these are bundled locally rather than fetched: a desktop application under a strict CSP cannot
 * reach a CDN, and should not want to.
 */
export interface PdfjsAssets {
  readonly cMapUrl?: string
  readonly standardFontDataUrl?: string
}

export function pdfjsSource(assets: PdfjsAssets = {}): PdfSource {
  return {
    async open(bytes: Uint8Array, password: string): Promise<LoadedPdf> {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const parameters: DocumentInitParameters = {
        data: new Uint8Array(bytes),
        password,
        // System fonts are off so that rendering is identical on every machine; the CAS families
        // rely on non-embedded standard fonts, which is what the bundled font data is for.
        useSystemFonts: false,
        ...(assets.cMapUrl !== undefined ? { cMapUrl: assets.cMapUrl, cMapPacked: true } : {}),
        ...(assets.standardFontDataUrl !== undefined
          ? { standardFontDataUrl: assets.standardFontDataUrl }
          : {}),
      }

      const task = pdfjs.getDocument(parameters)
      let document
      try {
        document = await task.promise
      } catch (error) {
        throw translate(error, pdfjs.PasswordResponses.NEED_PASSWORD)
      }

      const pages: RawPdfPage[] = []
      let characters = 0
      const imageOperators: number[] = [
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
      ]

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        const content = await page.getTextContent()
        const items: TextItem[] = []
        for (const raw of content.items) {
          if (!('str' in raw)) continue
          const item = toTextItem(raw)
          if (item !== null) {
            items.push(item)
            characters += item.text.replace(/\s+/g, '').length
          }
        }
        const view = page.view
        pages.push({
          pageNumber,
          width: (view[2] ?? 0) - (view[0] ?? 0),
          height: (view[3] ?? 0) - (view[1] ?? 0),
          rotation: page.rotate,
          items,
        })
      }

      const metadata = await document.getMetadata().catch(() => null)
      const meta: PdfMeta = {
        pageCount: document.numPages,
        info: infoOf(metadata?.info),
        encrypted: password !== '',
        hasTextLayer: characters > 0,
      }

      return {
        meta,
        pages,
        async hasImageOperators(): Promise<boolean> {
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber)
            const operators = await page.getOperatorList()
            if (operators.fnArray.some((fn) => imageOperators.includes(fn))) return true
          }
          return false
        },
      }
    },
  }
}

/**
 * pdf.js reports "needs a password" and "wrong password" as codes 1 and 2 on the same exception.
 * The distinction is what lets the UI word its prompt correctly, so it is preserved rather than
 * flattened into a single failure.
 */
function translate(error: unknown, needPasswordCode: number): Error {
  if (error instanceof Error && error.name === 'PasswordException') {
    const code = (error as Error & { code?: number }).code
    return new PdfPasswordError(code === needPasswordCode, error.message)
  }
  if (error instanceof Error && /encrypt|cipher|crypt/i.test(error.message)) {
    return new PdfCipherError(error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function toTextItem(raw: PdfTextItem): TextItem | null {
  const transform = raw.transform
  const a = numberAt(transform, 0)
  const b = numberAt(transform, 1)
  const x = numberAt(transform, 4)
  const y = numberAt(transform, 5)
  if (x === null || y === null) return null
  return {
    text: raw.str,
    x,
    y,
    width: raw.width,
    height: raw.height,
    fontName: raw.fontName,
    ...(a !== null ? { matrixA: a } : {}),
    ...(b !== null ? { matrixB: b } : {}),
  }
}

function numberAt(transform: unknown[], index: number): number | null {
  const value: unknown = transform[index]
  return typeof value === 'number' ? value : null
}

function infoOf(info: unknown): Record<string, string> {
  if (info === null || typeof info !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(info)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}
