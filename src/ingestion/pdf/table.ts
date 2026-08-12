/**
 * Column reconstruction for PDF tables.
 *
 * Column x-bands are seeded from the header row and cells are assigned by band, because the
 * alternative — splitting the joined line on whitespace — cannot tell a description containing
 * `Instalment 100/156` from the numeric columns that follow it.
 *
 * For right-aligned numeric columns the band is anchored on the header's right edge, because
 * left-aligned description text bleeds well past the amount column's nominal midpoint while a
 * number never crosses its own right edge.
 */

import { countTokenHits } from '../text'
import type { TextItem, TextLine } from '../types'

export interface ColumnBand {
  readonly label: string
  readonly left: number
  readonly right: number
}

export interface HeaderMatch {
  /** First line of the header. */
  readonly firstLine: number
  /** Last line consumed by the header, so the body starts after it. */
  readonly lastLine: number
  readonly bands: readonly ColumnBand[]
}

/**
 * Find a table header, allowing it to span two physical lines.
 *
 * The registrar templates wrap `Amount (INR)` and `Unit Balance` onto a second line, and the
 * fifth column is labelled `NAV` in older templates and `Price` in current ones. Both are handled
 * by scoring token hits over adjacent lines rather than matching a fixed string.
 */
export function findHeader(
  lines: readonly TextLine[],
  labels: readonly string[],
  minimumHits: number,
  from = 0,
): HeaderMatch | null {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || looksLikeData(line)) continue
    const hits = countTokenHits(line.text, labels)
    if (hits >= minimumHits) {
      return { firstLine: i, lastLine: i, bands: bandsOf(line.cells) }
    }
    const next = lines[i + 1]
    if (next === undefined || hits === 0 || looksLikeData(next)) continue
    // Only merge two lines when neither is a header on its own. Without this, the line above a
    // header — `Opening Unit Balance: 0.000` contributes `unit` and `balance` — gets swallowed
    // into the header, taking its own x positions into the column bands with it.
    if (countTokenHits(next.text, labels) >= minimumHits) continue
    if (hits + countTokenHits(next.text, labels) >= minimumHits) {
      return { firstLine: i, lastLine: i + 1, bands: bandsOf([...line.cells, ...next.cells]) }
    }
  }
  return null
}

/**
 * Every header on a page, not just the first.
 *
 * A page routinely carries two: the tail of one scheme's table and the head of the next. Reading
 * only the first leaves the second scheme's rows assigned to the wrong columns, which is a class
 * of bug that produces plausible-looking wrong numbers rather than an error.
 */
export function findHeaders(
  lines: readonly TextLine[],
  labels: readonly string[],
  minimumHits: number,
): HeaderMatch[] {
  const out: HeaderMatch[] = []
  let from = 0
  for (;;) {
    const match = findHeader(lines, labels, minimumHits, from)
    if (match === null) return out
    out.push(match)
    from = match.lastLine + 1
  }
}

/**
 * A header carries labels, not values.
 *
 * Without this test, a body row is a header candidate whenever its own words happen to hit the
 * label set — `*** IDCW Payout @ Rs.2.00 per unit ***` contributes `unit` — and it then eats the
 * line below it as the second half of a two-line header. The rows that follow are assigned to
 * bands derived from a data row, which produces wrong numbers rather than an error.
 */
function looksLikeData(line: TextLine): boolean {
  return line.cells.some((cell) => VALUE.test(cell.text.trim()))
}

/** A printed figure or a date: `1,723.45`, `(150.000)`, `15-Apr-2021`, `31-03-2025`. */
const VALUE = /^\(?-?[\d,]+\.\d+\)?$|^\d{2}-[A-Za-z]{3}-\d{4}$|^\d{2}-\d{2}-\d{4}$/

/**
 * Bands from header cells: each column owns the space up to the midpoint of the gap to its
 * neighbour. Cells that stack vertically (a two-line header) merge into one band.
 */
export function bandsOf(cells: readonly TextItem[]): ColumnBand[] {
  const sorted = [...cells].sort((a, b) => a.x - b.x)
  const merged: { label: string; left: number; right: number }[] = []
  for (const cell of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && cell.x <= last.right) {
      last.right = cell.x + cell.width > last.right ? cell.x + cell.width : last.right
      last.label = `${last.label} ${cell.text}`
      continue
    }
    merged.push({ label: cell.text, left: cell.x, right: cell.x + cell.width })
  }

  return merged.map((column, index) => {
    const previous = merged[index - 1]
    const next = merged[index + 1]
    const left = previous === undefined ? Number.NEGATIVE_INFINITY : (previous.right + column.left) / 2
    const right = next === undefined ? Number.POSITIVE_INFINITY : (column.right + next.left) / 2
    return { label: column.label.trim(), left, right }
  })
}

/** Assign a line's cells to the bands, joining anything that lands in the same column. */
export function readRow(line: TextLine, bands: readonly ColumnBand[]): string[] {
  const out = bands.map(() => '')
  for (const cell of line.cells) {
    const centre = cell.x + cell.width / 2
    let index = bands.findIndex((band) => centre >= band.left && centre < band.right)
    if (index === -1) index = centre < (bands[0]?.left ?? 0) ? 0 : bands.length - 1
    out[index] = out[index] === '' ? cell.text : `${out[index] ?? ''} ${cell.text}`
  }
  return out.map((cell) => cell.trim())
}

/** The index of the band whose label carries every one of `tokens`. */
export function bandIndex(bands: readonly ColumnBand[], tokens: readonly string[]): number {
  return bands.findIndex((band) => countTokenHits(band.label, tokens) === tokens.length)
}

/**
 * The *last* band matching `tokens`.
 *
 * `Value in ₹` is the holding's value and `Face Value in ₹` is the security's denomination, and
 * both match `value`. The one the reader wants is always the rightmost, because that is where
 * every statement in the corpus puts the total.
 */
export function bandIndexLast(bands: readonly ColumnBand[], tokens: readonly string[]): number {
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    const band = bands[i]
    if (band !== undefined && countTokenHits(band.label, tokens) === tokens.length) return i
  }
  return -1
}
