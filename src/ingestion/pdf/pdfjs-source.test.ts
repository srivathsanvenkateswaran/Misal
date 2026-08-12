import { describe, expect, it } from 'vitest'
import { pdfjsSource } from './pdfjs-source'
import { reconstructPage } from './layout'

/**
 * A minimal, uncompressed, unencrypted PDF built in memory.
 *
 * Built rather than committed: CI refuses any `.pdf` in the repository, and rightly — a committed
 * PDF is how a real statement eventually gets in. This exercises the one thing the fake PdfSource
 * cannot, which is that pdf.js itself is wired up correctly: the legacy build loads, text items
 * come back with usable coordinates, and the operator list is reachable.
 */
function buildPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 770 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}endstream`,
  ]

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

describe('the real pdf.js source', () => {
  it('reads text with coordinates from the legacy build', async () => {
    const pdf = await pdfjsSource().open(buildPdf('Consolidated Account Statement'), '')
    expect(pdf.meta.pageCount).toBe(1)
    expect(pdf.meta.hasTextLayer).toBe(true)
    expect(pdf.meta.encrypted).toBe(false)

    const page = pdf.pages[0]
    expect(page?.width).toBe(595)
    expect(page?.height).toBe(842)

    const item = page?.items[0]
    expect(item?.text).toBe('Consolidated Account Statement')
    expect(item?.x).toBe(72)
    expect(item?.y).toBe(770)
    // The transform components the layout engine needs to reject rotated watermarks.
    expect(item?.matrixA).toBe(12)
    expect(item?.matrixB).toBe(0)
  })

  it('feeds the shared layout engine', async () => {
    const pdf = await pdfjsSource().open(buildPdf('Folio No: 12345678 / 0'), '')
    const page = pdf.pages[0]
    expect(page).toBeDefined()
    if (page === undefined) return
    expect(reconstructPage(page).lines[0]?.text).toBe('Folio No: 12345678 / 0')
  })

  it('can answer the scanned-file question', async () => {
    const pdf = await pdfjsSource().open(buildPdf('text only'), '')
    await expect(pdf.hasImageOperators()).resolves.toBe(false)
  })
})
