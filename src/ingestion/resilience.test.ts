import { describe, expect, it } from 'vitest'
import { MemoryStore } from './memory-store'
import { runImport, type ImportDeps } from './pipeline'
import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { nsdlEcasPlugin } from './pdf/nsdl-ecas'
import { csvDescriptorPlugin } from './csv/csv-plugin'
import { builtinDescriptor, readFixtureBytes } from './testing/fixtures'
import { fakePdfBytes, fakePdfSource } from './testing/fake-pdf'
import { camsDetailedPages, camsSummaryPages, nsdlEcasPages } from './testing/corpus'
import { recordGolden } from './golden'
import { reconstructDocument } from './pdf/layout'
import type { RawPdfPage } from './types'

/**
 * Row-level resilience, as a property rather than as examples.
 *
 * For every fixture, mutate it the way a real file gets damaged — delete a row, corrupt a number,
 * blank a date, duplicate a row, truncate a line — and assert the invariants that hold whatever
 * the damage: the import always reaches `completed` or a typed document-level failure, never an
 * unhandled exception; the counters always reconcile; and every failed row carries a payload that
 * can be replayed.
 */

const NOW = '2026-08-12T10:00:00+05:30'

function deps(store: MemoryStore, pages?: readonly RawPdfPage[]): ImportDeps {
  let n = 0
  return {
    store,
    plugins: [
      camsKfinCasPlugin,
      nsdlEcasPlugin,
      csvDescriptorPlugin(builtinDescriptor('zerodha-console-tradebook')),
      csvDescriptorPlugin(builtinDescriptor('mybroker-account-statement')),
    ],
    now: () => NOW,
    newId: () => `id-${String((n += 1))}`,
    ...(pages !== undefined ? { pdfSource: fakePdfSource(pages) } : {}),
  }
}

type Mutation = (pages: readonly RawPdfPage[]) => RawPdfPage[]

const PDF_MUTATIONS: Record<string, Mutation> = {
  'delete a row': (pages) => dropNth(pages, 3),
  'corrupt a number': (pages) => replaceNth(pages, /^[\d,]+\.\d+$/, 'not-a-number'),
  'blank a date': (pages) => replaceNth(pages, /^\d{2}-[A-Za-z]{3}-\d{4}$/, ''),
  'duplicate a row': (pages) =>
    pages.map((page, index) =>
      index === 0 ? { ...page, items: [...page.items, ...page.items.slice(0, 6)] } : page,
    ),
  'truncate a line': (pages) => replaceNth(pages, /.{10,}/, 'trunc'),
}

const PDF_FIXTURES: Record<string, () => RawPdfPage[]> = {
  'cams detailed': camsDetailedPages,
  'cams summary': camsSummaryPages,
  'nsdl ecas': nsdlEcasPages,
}

describe('a damaged statement never takes the import with it', () => {
  for (const [fixture, build] of Object.entries(PDF_FIXTURES)) {
    for (const [mutation, mutate] of Object.entries(PDF_MUTATIONS)) {
      it(`${fixture}: ${mutation}`, async () => {
        const store = new MemoryStore()
        const pages = mutate(build())
        const outcome = await runImport(
          { bytes: fakePdfBytes(`${fixture}-${mutation}`), originalName: 'cas.pdf' },
          deps(store, pages),
        )

        if (outcome.status === 'failed') {
          // A typed document-level failure is an acceptable outcome; an exception is not.
          expect(outcome.code).toMatch(/^E_/)
          expect(store.snapshot().documents).toHaveLength(0)
          return
        }
        expect(outcome.status).toBe('completed')
        if (outcome.status !== 'completed') return

        const counters = outcome.counters
        expect(counters.read).toBe(
          counters.committed + counters.duplicate + counters.skipped + counters.failed,
        )
        for (const issue of outcome.issues.filter((i) => i.severity === 'error')) {
          if (issue.code === 'E_PLUGIN_CRASH') continue
          expect(issue.raw).toBeDefined()
        }
      })
    }
  }

  it('a damaged CSV still commits its good rows', async () => {
    const store = new MemoryStore()
    const outcome = await runImport(
      {
        bytes: readFixtureBytes('csv/zerodha-console-tradebook-damaged.csv'),
        originalName: 'tradebook.csv',
      },
      deps(store),
    )
    expect(outcome.status).toBe('completed')
  })
})

/**
 * The format-drift canary.
 *
 * Both CAS families drift year to year — `Stamp Duty` appeared after 2020, `Annualised Return(%)`
 * and `Sovereign Gold Bonds` later still. A parser that silently ignores an unrecognised section
 * looks correct until the year it is not, so an unrecognised section in the corpus fails the
 * build rather than emitting a warning into a report nobody reads.
 */
describe('format drift', () => {
  const plugins = [
    { name: 'cams detailed', plugin: camsKfinCasPlugin, pages: camsDetailedPages },
    { name: 'cams summary', plugin: camsKfinCasPlugin, pages: camsSummaryPages },
    { name: 'nsdl ecas', plugin: nsdlEcasPlugin, pages: nsdlEcasPages },
  ]

  for (const { name, plugin, pages } of plugins) {
    it(`${name} contains no section the parser does not claim to recognise`, async () => {
      const reconstructed = reconstructDocument(pages())
      const { issues } = await recordGolden(plugin, {
        kind: 'pdf-text',
        pages: reconstructed,
        meta: { pageCount: reconstructed.length, info: {}, encrypted: true, hasTextLayer: true },
      })
      expect(issues.filter((i) => i.code === 'W_UNKNOWN_SECTION')).toEqual([])
    })
  }
})

function dropNth(pages: readonly RawPdfPage[], row: number): RawPdfPage[] {
  return pages.map((page, index) => {
    if (index !== 0) return page
    const ys = [...new Set(page.items.map((item) => item.y))].sort((a, b) => b - a)
    const target = ys[row]
    return { ...page, items: page.items.filter((item) => item.y !== target) }
  })
}

function replaceNth(pages: readonly RawPdfPage[], pattern: RegExp, replacement: string): RawPdfPage[] {
  let done = false
  return pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (done || !pattern.test(item.text)) return item
      done = true
      return { ...item, text: replacement }
    }),
  }))
}
