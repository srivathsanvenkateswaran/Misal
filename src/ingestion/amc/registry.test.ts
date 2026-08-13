/**
 * The registry is a table transcribed from an external source, and the standing lesson recorded in
 * `docs/known-issues.md` applies to it: golden arithmetic examples do not cover lookup tables, so
 * a table needs exhaustive assertion rather than sampled assertion.
 *
 * What is asserted exhaustively here is the *structure* — every id well-formed, every ISIN prefix
 * owned once, every printed name reducing to a key no other house answers to. Those are the
 * properties whose violation silently merges or forks a fund house, which is the whole failure
 * class this module exists to close.
 */

import { describe, expect, it } from 'vitest'
import {
  AMC_REGISTRY,
  assertRegistry,
  findByIsin,
  findByPrintedName,
  isinIssuerPrefix,
  registryLookupKeys,
  type AmcEntry,
} from './registry'
import { amcLookupKey, normaliseAmcName } from './names'

const entry = (over: Partial<AmcEntry>): AmcEntry => ({
  id: 'example',
  canonicalName: 'Example Mutual Fund',
  isinIssuerPrefixes: ['INF001A'],
  printedNames: ['Example Mutual Fund'],
  ...over,
})

describe('the registry table', () => {
  it('is not empty', () => {
    expect(AMC_REGISTRY.length).toBeGreaterThan(0)
  })

  it('holds a well-formed id, name and at least one printed form for every entry', () => {
    for (const amc of AMC_REGISTRY) {
      expect(amc.id, `${amc.canonicalName} id`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(amc.canonicalName.trim(), `${amc.id} canonical name`).not.toBe('')
      expect(amc.printedNames.length, `${amc.id} printed names`).toBeGreaterThan(0)
    }
  })

  it('gives every entry at least one ISIN issuer prefix of the documented shape', () => {
    for (const amc of AMC_REGISTRY) {
      // Without a prefix an entry can only ever be reached by name, which is the weak identifier
      // this whole module exists to stop relying on.
      expect(amc.isinIssuerPrefixes.length, `${amc.id}`).toBeGreaterThan(0)
      for (const prefix of amc.isinIssuerPrefixes) {
        expect(prefix, `${amc.id}`).toMatch(/^INF[0-9A-Z]{4}$/)
      }
    }
  })

  it('lets no two houses answer to the same printed name or the same ISIN prefix', () => {
    // The load-time assertion already ran on import; this states the property in the test suite so
    // a future edit that trips it fails with a readable message rather than an import error.
    expect(() => {
      assertRegistry(AMC_REGISTRY)
    }).not.toThrow()

    const keys = registryLookupKeys().map((k) => k.lookupKey)
    expect(new Set(keys).size).toBe(keys.length)

    const prefixes = AMC_REGISTRY.flatMap((a) => a.isinIssuerPrefixes)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  it('lists the canonical name among the printed forms it will recognise', () => {
    for (const amc of AMC_REGISTRY) {
      expect(findByPrintedName(amc.canonicalName)?.id, amc.id).toBe(amc.id)
    }
  })

  it('resolves every printed form it lists back to its own entry', () => {
    for (const amc of AMC_REGISTRY) {
      for (const printed of amc.printedNames) {
        expect(findByPrintedName(printed)?.id, `${amc.id}: ${printed}`).toBe(amc.id)
      }
    }
  })

  it('resolves every ISIN prefix it lists back to its own entry', () => {
    for (const amc of AMC_REGISTRY) {
      for (const prefix of amc.isinIssuerPrefixes) {
        expect(findByIsin(`${prefix}01ABC`)?.id, `${amc.id}: ${prefix}`).toBe(amc.id)
      }
    }
  })

  it('answers to the legal-entity form of every house, written out or reduced onto', () => {
    // The bug this registry fixes was two documents printing one house two ways: the CAS prints
    // the fund, the depository roster prints the company. Both must reach the same entry. Most
    // houses need no extra data for this — "HDFC Asset Management Company Limited" reduces onto
    // `hdfc` by itself — but a house whose legal name carries an extra word does, and this is
    // where a missing one shows up.
    for (const amc of AMC_REGISTRY) {
      const brand = normaliseAmcName(amc.canonicalName).replace(/ mutual fund$/, '')
      const legal = `${brand} Asset Management Company Limited`
      expect(findByPrintedName(legal)?.id, `${amc.id}: ${legal}`).toBe(amc.id)
    }
  })
})

/**
 * Real spellings, one row per (printed form, expected house).
 *
 * A table transcribed from an external source needs exhaustive assertion rather than sampled
 * assertion — the standing lesson from the tax-rules table. These are the forms that actually
 * appear on the two document families, including the renames a folio outlives.
 */
describe('printed forms observed on statements', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['HDFC Mutual Fund', 'hdfc'],
    ['HDFC Asset Management Company Limited', 'hdfc'],
    ['HDFC  Asset Management Co. Ltd.', 'hdfc'],
    ['hdfc mutual fund', 'hdfc'],
    ['ICICI Prudential Mutual Fund', 'icici-prudential'],
    ['ICICI Prudential Asset Management Company Limited', 'icici-prudential'],
    ['ICICI  Prudential Asset Management Co. Ltd.', 'icici-prudential'],
    ['SBI Mutual Fund', 'sbi'],
    ['SBI Funds Management Limited', 'sbi'],
    ['Nippon India Mutual Fund', 'nippon-india'],
    ['Nippon Life India Asset Management Limited', 'nippon-india'],
    ['Reliance Mutual Fund', 'nippon-india'],
    ['Aditya Birla Sun Life Mutual Fund', 'aditya-birla-sun-life'],
    ['Aditya Birla Sun Life AMC Limited', 'aditya-birla-sun-life'],
    ['Birla Sun Life Mutual Fund', 'aditya-birla-sun-life'],
    ['Kotak Mahindra Mutual Fund', 'kotak-mahindra'],
    ['Kotak Mahindra Asset Management Company Limited', 'kotak-mahindra'],
    ['UTI Mutual Fund', 'uti'],
    ['UTI Asset Management Company Ltd', 'uti'],
    ['Franklin Templeton Mutual Fund', 'franklin-templeton'],
    ['Franklin Templeton Asset Management (India) Private Limited', 'franklin-templeton'],
    ['Mirae Asset Mutual Fund', 'mirae-asset'],
    ['Mirae Asset Investment Managers (India) Private Limited', 'mirae-asset'],
    ['HSBC Mutual Fund', 'hsbc'],
    ['HSBC Asset Management (India) Private Limited', 'hsbc'],
    ['L&T Mutual Fund', 'hsbc'],
    ['L & T Mutual Fund', 'hsbc'],
    ['IDFC Mutual Fund', 'bandhan'],
    ['Bandhan AMC Limited', 'bandhan'],
    ['IIFL Mutual Fund', '360-one'],
    ['quant Mutual Fund', 'quant'],
    ['Quant Money Managers Limited', 'quant'],
    ['Quantum Mutual Fund', 'quantum'],
    ['PPFAS Mutual Fund', 'ppfas'],
    ['PPFAS Asset Management Private Limited', 'ppfas'],
    ['DSP Mutual Fund', 'dsp'],
    ['DSP Asset Managers Private Limited', 'dsp'],
    ['Bank of India Mutual Fund', 'bank-of-india'],
    ['Tata Asset Management Private Limited', 'tata'],
    ['Canara Robeco Asset Management Company Limited', 'canara-robeco'],
  ]

  for (const [printed, id] of cases) {
    it(`${printed} -> ${id}`, () => {
      expect(findByPrintedName(printed)?.id).toBe(id)
    })
  }

  it('does not confuse quant with Quantum, which differ by one designator-shaped word', () => {
    expect(findByPrintedName('quant Mutual Fund')?.id).toBe('quant')
    expect(findByPrintedName('Quantum Mutual Fund')?.id).toBe('quantum')
  })
})

describe('assertRegistry', () => {
  it('rejects an id that is not a stable slug', () => {
    expect(() => {
      assertRegistry([entry({ id: 'HDFC Mutual Fund' })])
    }).toThrow(/must match/)
  })

  it('rejects a duplicate id', () => {
    expect(() => {
      assertRegistry([entry({}), entry({ isinIssuerPrefixes: ['INF002A'], printedNames: ['Other MF'] })])
    }).toThrow(/duplicate id/)
  })

  it('rejects two houses claiming one ISIN prefix', () => {
    expect(() => {
      assertRegistry([
        entry({}),
        entry({ id: 'other', printedNames: ['Other Mutual Fund'], isinIssuerPrefixes: ['INF001A'] }),
      ])
    }).toThrow(/claimed by both/)
  })

  it('rejects two houses whose printed names reduce to one key', () => {
    // The dangerous one. "Example Mutual Fund" and "Example Asset Management Limited" both reduce
    // to `example`; if they named different houses, one would silently own the other's folios.
    expect(() => {
      assertRegistry([
        entry({}),
        entry({
          id: 'other',
          isinIssuerPrefixes: ['INF002A'],
          printedNames: ['Example Asset Management Limited'],
        }),
      ])
    }).toThrow(/cannot share a name/)
  })

  it('rejects an ISIN prefix of the wrong shape', () => {
    expect(() => {
      assertRegistry([entry({ isinIssuerPrefixes: ['INE001A'] })])
    }).toThrow(/expected INFxxxx/)
  })
})

describe('isinIssuerPrefix', () => {
  it('takes the seven-character issuer prefix from a mutual fund ISIN', () => {
    expect(isinIssuerPrefix('INF179K01608')).toBe('INF179K')
    expect(isinIssuerPrefix('INF109K01BL4')).toBe('INF109K')
  })

  it('returns nothing for an equity ISIN, which names a company rather than a fund house', () => {
    expect(isinIssuerPrefix('INE009A01021')).toBeNull()
  })

  it('returns nothing for a foreign or malformed identifier', () => {
    expect(isinIssuerPrefix('US0378331005')).toBeNull()
    expect(isinIssuerPrefix('INF17')).toBeNull()
    expect(isinIssuerPrefix('')).toBeNull()
  })
})

describe('amcLookupKey', () => {
  it('reduces the fund form and the legal-entity form to one key', () => {
    const forms = [
      'HDFC Mutual Fund',
      'HDFC Asset Management Company Limited',
      'HDFC  Asset Management Co. Ltd.',
      'hdfc asset management co ltd',
    ]
    expect(new Set(forms.map((f) => amcLookupKey(f))).size).toBe(1)
  })

  it('keeps a brand word that a designator list would otherwise eat', () => {
    // `india` is not a designator: "Nippon India" and "Nippon Life India" are different strings
    // naming the same house only because the registry says so, never because a rule fused them.
    expect(amcLookupKey('Nippon India Mutual Fund')).toBe('nippon india')
    expect(amcLookupKey('Nippon Life India Asset Management Limited')).toBe('nippon life india')
  })

  it('expands an ampersand rather than deleting it', () => {
    expect(amcLookupKey('L&T Mutual Fund')).toBe('l and t')
  })

  it('never reduces to nothing, so a name of pure designators matches nothing', () => {
    expect(amcLookupKey('Mutual Fund')).not.toBe('')
    expect(findByPrintedName('Mutual Fund')).toBeNull()
    expect(findByPrintedName('Asset Management Company Limited')).toBeNull()
  })
})
