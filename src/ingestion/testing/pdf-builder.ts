/**
 * Builds Tier-1 text-layer fixtures: the `RawPdfPage[]` structure as it exists after extraction
 * and before layout reconstruction.
 *
 * These are the primary corpus. They need no PDF, no password and no decryption, so the parser
 * tests are fast, deterministic and impossible to leak a real statement through — the fixture is
 * written here, in code, from synthetic data.
 *
 * Real fixtures are produced from a real statement by the redaction tool on a contributor's own
 * machine. This builder is the other half of the same contract: it is how a *synthetic* fixture,
 * or a mutation of an existing one, is produced without hand-editing coordinates.
 */

import type { RawPdfPage, TextItem } from '../types'

/** Points per character at the fixture's nominal 10pt font. Only the ordering matters. */
const CHARACTER_WIDTH = 5
const FONT_HEIGHT = 10
const LINE_SPACING = 14
const TOP = 780
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842

export interface FixtureCell {
  readonly text: string
  /** Left edge. Mutually exclusive with `rightAt`. */
  readonly x?: number
  /** Right edge, for the numeric columns every statement right-aligns. */
  readonly rightAt?: number
  /** Drawn vertically, like a watermark. The layout engine must reject it. */
  readonly rotated?: boolean
  /** Drawn a second time at a sub-point offset, like the faux-bold columns both families use. */
  readonly overlaid?: boolean
}

export type FixtureRow = string | readonly (string | FixtureCell)[]

export interface FixturePage {
  readonly rows: readonly FixtureRow[]
  /** Drawn at the foot of the page, where a generator footer and a page number actually sit. */
  readonly footer?: readonly FixtureRow[]
}

const BOTTOM = 40

export function buildPages(pages: readonly FixturePage[]): RawPdfPage[] {
  return pages.map((page, index) => ({
    pageNumber: index + 1,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    rotation: 0,
    items: [
      ...page.rows.flatMap((row, rowIndex) => itemsOf(row, TOP - rowIndex * LINE_SPACING)),
      ...(page.footer ?? []).flatMap((row, rowIndex) => itemsOf(row, BOTTOM - rowIndex * LINE_SPACING)),
    ],
  }))
}

function itemsOf(row: FixtureRow, y: number): TextItem[] {
  const cells: (string | FixtureCell)[] = typeof row === 'string' ? [row] : [...row]
  const out: TextItem[] = []
  let cursor = 40

  for (const cell of cells) {
    const spec: FixtureCell = typeof cell === 'string' ? { text: cell } : cell
    const width = spec.text.length * CHARACTER_WIDTH
    const x = spec.rightAt !== undefined ? spec.rightAt - width : (spec.x ?? cursor)
    cursor = x + width + CHARACTER_WIDTH * 2

    const item: TextItem = {
      text: spec.text,
      x,
      y,
      width,
      height: FONT_HEIGHT,
      fontName: 'g_d0_f1',
      matrixA: spec.rotated === true ? 0 : 1,
      matrixB: spec.rotated === true ? 1 : 0,
    }
    out.push(item)
    if (spec.overlaid === true) out.push({ ...item, x: x + 0.4, y: y + 0.3 })
  }

  return out
}

/** A right-aligned numeric cell, which is how every amount column in the corpus is drawn. */
export function right(text: string, rightAt: number): FixtureCell {
  return { text, rightAt }
}
