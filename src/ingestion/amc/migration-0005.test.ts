/**
 * Migration 0004 carries a copy of the registry, transcribed into SQL because SQLite cannot call
 * `amcLookupKey`. A copy drifts. This test is what stops it.
 *
 * The drift that matters is one-directional: a printed name added to the registry but not to the
 * migration means a folio already stored under that name's old slug is never re-keyed, so the next
 * statement that spells the house differently creates the second account this whole change exists
 * to prevent — on exactly the databases that already have the folio, which is to say on real ones.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AMC_REGISTRY } from './registry'
import { amcLookupKey } from './names'

const SQL = readFileSync(
  resolve(process.cwd(), 'src-tauri/migrations/0005-amc-identity.sql'),
  'utf-8',
)

/**
 * The slug the *old* code produced from a printed AMC name, reproduced here exactly.
 *
 * Deliberately a copy rather than an import: the function it reproduces has been deleted, and the
 * point of this test is to state what the old keys looked like, not to keep the old behaviour
 * reachable from production code. Note that it mapped `&` to a separator rather than to "and",
 * which the current lookup key does not.
 */
function legacySlug(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** The rows of one `INSERT INTO <table> ... VALUES` block, as tuples. */
function insertedInto(table: string): string[][] {
  const block = SQL.split(new RegExp(`INSERT INTO ${table}[^\\n]*VALUES`, 'i'))[1] ?? ''
  const rows: string[][] = []
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("('")) {
      if (rows.length > 0) break
      continue
    }
    rows.push([...trimmed.matchAll(/'([^']*)'/g)].map((m) => m[1] as string))
  }
  return rows
}

/**
 * Every legacy slug the migration resolves, expanded exactly as its own SQL expands it: the brand
 * table, the brand table crossed with the suffix table, and the residual list.
 */
function mappingRows(): Map<string, string> {
  const rows = new Map<string, string>()
  const brands = insertedInto('amc_brand')
  const suffixes = insertedInto('amc_suffix').map((row) => row[0] as string)
  const claims = new Map<string, Set<string>>()

  const claim = (slug: string, id: string): void => {
    const owners = claims.get(slug) ?? new Set<string>()
    owners.add(id)
    claims.set(slug, owners)
  }

  for (const [brand, id] of brands) {
    claim(brand as string, id as string)
    for (const suffix of suffixes) claim(`${brand as string}-${suffix}`, id as string)
  }
  for (const [slug, id] of insertedInto('amc_residual')) claim(slug as string, id as string)

  // The migration's own HAVING clause drops a slug two houses both claim.
  for (const [slug, owners] of claims) {
    if (owners.size === 1) rows.set(slug, [...owners][0] as string)
  }
  return rows
}

describe('migration 0004', () => {
  const rows = mappingRows()

  it('parses as a non-trivial mapping', () => {
    expect(insertedInto('amc_brand').length).toBeGreaterThanOrEqual(AMC_REGISTRY.length)
    expect(insertedInto('amc_suffix').length).toBeGreaterThan(0)
    expect(rows.size).toBeGreaterThan(AMC_REGISTRY.length * 10)
  })

  it('maps the legacy slug of every printed name in the registry', () => {
    const missing: string[] = []
    for (const amc of AMC_REGISTRY) {
      for (const printed of [amc.canonicalName, ...amc.printedNames]) {
        const slug = legacySlug(printed)
        if (rows.get(slug) !== amc.id) missing.push(`${slug} -> ${amc.id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('maps the legal-entity slug of every house, which is the spelling that forked the folio', () => {
    // The exact pairing in the bug report: the CAS printed the fund, the eCAS printed the company,
    // and the two slugs diverged. Both must now reach the same id, in an already-populated
    // database as well as in a fresh import.
    const missing: string[] = []
    for (const amc of AMC_REGISTRY) {
      const brand = amcLookupKey(amc.canonicalName).replace(/ /g, '-')
      for (const suffix of [
        'mutual-fund',
        'asset-management-company-limited',
        'asset-management-co-ltd',
        'amc-limited',
      ]) {
        const slug = `${brand}-${suffix}`
        if (rows.get(slug) !== amc.id) missing.push(`${slug} -> ${amc.id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('maps nothing onto an id the registry does not define', () => {
    const ids = new Set(AMC_REGISTRY.map((a) => a.id))
    for (const [slug, id] of rows) {
      expect(ids.has(id), `${slug} -> ${id}`).toBe(true)
    }
  })

  it('refuses to rewrite one account onto another account key', () => {
    // The collision guard is the load-bearing clause: without it the UPDATE trips the unique
    // index on identity_key and the whole migration — and therefore the upgrade — fails.
    expect(SQL).toMatch(/DELETE FROM amc_rewrite/)
    expect(SQL).toMatch(/HAVING count\(\*\) > 1/)
  })

  it('leaves every non-folio identity key alone', () => {
    // A demat key is `demat:<dp>-<client>`. Nothing here may touch it.
    expect(SQL).toMatch(/identity_key LIKE 'mf-folio:%'/)
  })
})
