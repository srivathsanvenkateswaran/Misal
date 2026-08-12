import { describe, expect, it } from 'vitest'
import { reconstructDocument, reconstructPage } from './layout'
import { buildPages } from '../testing/pdf-builder'
import { camsDetailedPages } from '../testing/corpus'

describe('layout reconstruction', () => {
  it('rejects rotated watermark text', () => {
    const [page] = buildPages([{ rows: [[{ text: 'Body text', x: 40 }, { text: 'CAMS L', x: 560, rotated: true }]] }])
    const lines = reconstructPage(page!).lines
    expect(lines).toHaveLength(1)
    expect(lines[0]?.text).toBe('Body text')
  })

  it('collapses a glyph drawn twice at a sub-point offset', () => {
    const [page] = buildPages([{ rows: [[{ text: '2020', x: 40, overlaid: true }]] }])
    // Naive extraction yields `20202020`, which parses as a year three centuries out.
    expect(reconstructPage(page!).lines[0]?.text).toBe('2020')
  })

  it('buckets items into rows by baseline and orders them by x', () => {
    const [page] = buildPages([{ rows: [[{ text: 'right', x: 300 }, { text: 'left', x: 40 }]] }])
    expect(reconstructPage(page!).lines[0]?.text).toBe('left right')
  })

  it('strips furniture that repeats across pages, and page numbers', () => {
    const pages = reconstructDocument(camsDetailedPages())
    const text = pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n')
    // Page 1 keeps its own furniture, because every detection signal lives in it.
    expect(pages[0]?.lines.some((l) => l.text.includes('CAMSCASWS'))).toBe(true)
    expect(pages[1]?.lines.some((l) => l.text.includes('CAMSCASWS'))).toBe(false)
    expect(text).not.toMatch(/Page \d of \d/)
    // The column header repeats too, and must survive: it is inside the body, not the furniture.
    expect(pages[1]?.lines.some((l) => l.text.startsWith('Date Transaction'))).toBe(true)
  })

  it('keeps furniture when there is only one page to compare against', () => {
    const pages = reconstructDocument(buildPages([{ rows: ['CAMSCASWS footer'] }]))
    expect(pages[0]?.lines[0]?.text).toBe('CAMSCASWS footer')
  })
})
