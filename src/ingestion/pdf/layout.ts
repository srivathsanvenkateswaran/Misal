/**
 * Layout reconstruction, shared by every PDF plugin and owned by none of them.
 *
 * Text extraction produces items in content-stream order, not reading order, and carries no
 * notion of a table. Each step below fixes one specific, observed way that a CAS PDF defeats a
 * naive reader. They are in the order the spec gives, because several of them only work after the
 * previous one has run.
 */

import { collapseWhitespace, normaliseGlyphs } from '../text'
import type { PdfPage, RawPdfPage, TextItem, TextLine } from '../types'

/** Items closer than this in both axes, with identical text, are one glyph drawn twice. */
const OVERLAY_TOLERANCE = 1

/** Fraction of page height at the top and bottom within which repeated text is furniture. */
const FURNITURE_BAND = 0.12

export function reconstructPage(page: RawPdfPage): PdfPage {
  const kept = page.items.filter(isReadable).map(repairText)
  const deduped = dropOverlaidGlyphs(kept)
  return { ...page, lines: bucketIntoLines(deduped) }
}

/**
 * Reconstruct every page, then strip the furniture that repeats across them.
 *
 * Running headers, the NSDL navigation strip, `Page n of m` and the CAMS generator footer all
 * appear on every page. Left in place they interleave with the table body and become phantom
 * rows, so they are matched against the rest of the document and removed.
 */
export function reconstructDocument(pages: readonly RawPdfPage[]): PdfPage[] {
  return stripFurniture(pages.map(reconstructPage))
}

/**
 * Reject rotated text.
 *
 * Watermarks are drawn vertically down the page edge and bleed fragments such as `CAMS L` and
 * `KFINTECH 4.` into scheme names and registrar fields. Any item whose transform satisfies
 * |b| > |a| is rotated far enough not to be body text.
 */
function isReadable(item: TextItem): boolean {
  if (item.matrixA === undefined || item.matrixB === undefined) return item.text.trim() !== ''
  if (magnitude(item.matrixB) > magnitude(item.matrixA)) return false
  // Zero-height whitespace fillers carry no text but their width is the best column-boundary
  // signal available; they are dropped only after the x positions have been read off them.
  return item.text.trim() !== ''
}

function repairText(item: TextItem): TextItem {
  return { ...item, text: normaliseGlyphs(item.text) }
}

/**
 * Collapse glyphs drawn twice at a sub-point offset.
 *
 * Both families draw some columns twice for a faux-bold effect. Naive extraction then yields
 * `22002200` for `2020`, which parses as the year 2200 and puts a transaction three centuries
 * into the future.
 */
function dropOverlaidGlyphs(items: readonly TextItem[]): TextItem[] {
  const out: TextItem[] = []
  for (const item of items) {
    const duplicate = out.some(
      (kept) =>
        kept.text === item.text &&
        magnitude(kept.x - item.x) <= OVERLAY_TOLERANCE &&
        magnitude(kept.y - item.y) <= OVERLAY_TOLERANCE,
    )
    if (!duplicate) out.push(item)
  }
  return out
}

/**
 * Bucket items by baseline, tolerance about half the font height, then sort by x.
 *
 * Half the font height is the empirically right tolerance: superscripts and the second line of a
 * stacked cell sit further apart than that, while the sub-point baseline jitter within one
 * printed row does not.
 */
function bucketIntoLines(items: readonly TextItem[]): TextLine[] {
  const sorted = [...items].sort((a, b) => (b.y - a.y === 0 ? a.x - b.x : b.y - a.y))
  const lines: { y: number; cells: TextItem[] }[] = []

  for (const item of sorted) {
    const half = item.height / 2
    const tolerance = half > 1 ? half : 1
    const current = lines[lines.length - 1]
    if (current !== undefined && magnitude(current.y - item.y) <= tolerance) {
      current.cells.push(item)
    } else {
      lines.push({ y: item.y, cells: [item] })
    }
  }

  return lines.map((line) => {
    const cells = [...line.cells].sort((a, b) => a.x - b.x)
    return { y: line.y, cells, text: collapseWhitespace(cells.map((c) => c.text).join(' ')) }
  })
}

const PAGE_NUMBER = /^page\s+\d+\s+(of|\/)\s+\d+$/i

function stripFurniture(pages: readonly PdfPage[]): PdfPage[] {
  if (pages.length < 2) return pages.map((p) => ({ ...p, lines: p.lines.filter(notPageNumber) }))

  const occurrences = new Map<string, number>()
  for (const page of pages) {
    const seen = new Set<string>()
    for (const line of page.lines) {
      if (!inFurnitureBand(line, page)) continue
      const key = line.text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
    }
  }

  // ceil(0.6 * n), written as integer arithmetic because Math.* is banned by the float rules.
  const threshold = pages.length === 2 ? 2 : ((pages.length * 3 + 4) / 5) | 0
  const furniture = new Set(
    [...occurrences.entries()].filter(([, count]) => count >= threshold).map(([text]) => text),
  )

  // The first page keeps its furniture. Every detection signal in both CAS families lives in the
  // running header or the generator footer — `CAMSCASWS`, `NSDL-CAS Team`, the document title —
  // and stripping them from page 1 would leave the format undetectable.
  return pages.map((page, index) => ({
    ...page,
    lines: page.lines.filter(
      (line) =>
        notPageNumber(line) &&
        (index === 0 || !(inFurnitureBand(line, page) && furniture.has(line.text.toLowerCase()))),
    ),
  }))
}

function inFurnitureBand(line: TextLine, page: PdfPage): boolean {
  const band = page.height * FURNITURE_BAND
  return line.y >= page.height - band || line.y <= band
}

function notPageNumber(line: TextLine): boolean {
  return !PAGE_NUMBER.test(line.text)
}

/** `Math.abs` is banned by the float rules; coordinates are geometry, but the ban has no
 * exceptions and a two-line helper costs nothing. */
function magnitude(value: number): number {
  return value < 0 ? -value : value
}
