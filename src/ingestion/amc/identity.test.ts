import { describe, expect, it } from 'vitest'
import {
  FolioAmcIndex,
  PROVISIONAL_MARKER,
  amcIssues,
  mfFolioIdentityKey,
  resolveAmc,
} from './identity'
import { AMC_REGISTRY, findByPrintedName } from './registry'

const HDFC = findByPrintedName('HDFC Mutual Fund')
const HDFC_ISIN = 'INF179K01608'

describe('resolveAmc', () => {
  it('resolves every printed form of a house to one id', () => {
    for (const amc of AMC_REGISTRY) {
      const ids = amc.printedNames.map(
        (printedName) => resolveAmc({ printedNames: [printedName], isins: [] }),
      )
      expect(new Set(ids.map((r) => (r.kind === 'canonical' ? r.amcId : r.token))).size, amc.id).toBe(1)
    }
  })

  it('resolves on the ISIN alone, with no name printed at all', () => {
    const resolved = resolveAmc({ printedNames: [], isins: [HDFC_ISIN] })
    expect(resolved.kind).toBe('canonical')
    expect(resolved.kind === 'canonical' && resolved.amcId).toBe(HDFC?.id)
    expect(resolved.kind === 'canonical' && resolved.matchedBy).toBe('isin')
  })

  it('lets the ISIN rescue a name the registry has never seen', () => {
    // This is the case that actually bites: a template prints a spelling nobody wrote down, and
    // the folio would otherwise fork away from the statement that spelled it recognisably.
    const resolved = resolveAmc({
      printedNames: ['HDFC Asset Mgmt Co (India) Pvt Ltd'],
      isins: [HDFC_ISIN],
    })
    expect(resolved.kind === 'canonical' && resolved.amcId).toBe(HDFC?.id)
  })

  it('is order-independent in its evidence', () => {
    const a = resolveAmc({ printedNames: ['HDFC Mutual Fund', 'Nonsense'], isins: [HDFC_ISIN] })
    const b = resolveAmc({ printedNames: ['Nonsense', 'HDFC Mutual Fund'], isins: [HDFC_ISIN] })
    expect(a).toEqual(b)
  })

  it('lets the ISIN win a disagreement, and records it', () => {
    // Demoting the pair to provisional would fork the folio again, which is the bug. The ISIN is
    // identical in every document, so resolving on it keeps one folio on one account.
    const other = AMC_REGISTRY.find((a) => a.id !== HDFC?.id)
    const resolved = resolveAmc({
      printedNames: [other?.printedNames[0] ?? 'ICICI Prudential Mutual Fund'],
      isins: [HDFC_ISIN],
    })
    expect(resolved.kind === 'canonical' && resolved.amcId).toBe(HDFC?.id)
    expect(resolved.kind === 'canonical' && resolved.disagreedWith?.amcId).toBe(other?.id)
    expect(amcIssues(resolved, '12345678/0', 'p.1').map((i) => i.code)).toEqual([
      'W_AMC_NAME_CONFLICT',
    ])
  })
})

describe('never guessing', () => {
  it('marks an unknown name provisional rather than coining a plausible id', () => {
    const resolved = resolveAmc({ printedNames: ['Novus Capital Mutual Fund'], isins: [] })
    expect(resolved.kind).toBe('provisional')
    const key = mfFolioIdentityKey(resolved, '99999999/0')
    expect(key).toContain(PROVISIONAL_MARKER)
    // The marker character cannot occur in a registry id, so a provisional key is never mistaken
    // for a resolved one by a human or by a query.
    expect(key.includes('~')).toBe(true)
    for (const amc of AMC_REGISTRY) expect(key).not.toContain(`:${amc.id}:`)
  })

  it('says so in the import report, every time', () => {
    const resolved = resolveAmc({ printedNames: ['Novus Capital Mutual Fund'], isins: [] })
    const issues = amcIssues(resolved, '99999999/0', 'p.1 r.4')
    expect(issues.map((i) => i.code)).toEqual(['W_AMC_UNRECOGNISED'])
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.message).toContain('Novus Capital Mutual Fund')
  })

  it('prefers an unknown ISIN prefix to an unknown name, because the prefix is stable', () => {
    // A fund house Misal has not catalogued yet still gets one provisional identity rather than
    // one per spelling, provided the statement printed an ISIN.
    const one = resolveAmc({ printedNames: ['Novus Capital Mutual Fund'], isins: ['INF999Z01019'] })
    const two = resolveAmc({
      printedNames: ['Novus Capital Asset Management Ltd'],
      isins: ['INF999Z01027'],
    })
    expect(one.kind).toBe('provisional')
    expect(one.kind === 'provisional' && one.reason).toBe('unknown-isin-issuer')
    expect(mfFolioIdentityKey(one, '1/0')).toBe(mfFolioIdentityKey(two, '1/0'))
  })

  it('warns that a name-only provisional identity is not stable, and why', () => {
    const resolved = resolveAmc({ printedNames: ['Novus Capital Mutual Fund'], isins: [] })
    expect(amcIssues(resolved, '1/0', 'p.1')[0]?.message).toMatch(/second account/)
  })

  it('resolves nothing at all when the document named nothing', () => {
    const resolved = resolveAmc({ printedNames: [], isins: [] })
    expect(resolved.kind === 'provisional' && resolved.reason).toBe('no-evidence')
    expect(mfFolioIdentityKey(resolved, '1/0')).toBe(`mf-folio:${PROVISIONAL_MARKER}unnamed:1/0`)
  })

  it('ignores an equity ISIN, which names a company rather than a fund house', () => {
    const resolved = resolveAmc({ printedNames: [], isins: ['INE009A01021'] })
    expect(resolved.kind === 'provisional' && resolved.reason).toBe('no-evidence')
  })
})

describe('the identity key', () => {
  it('keeps the sub-account suffix, because folios differing only in suffix differ', () => {
    const resolved = resolveAmc({ printedNames: ['HDFC Mutual Fund'], isins: [] })
    expect(mfFolioIdentityKey(resolved, '12345678/0')).not.toBe(
      mfFolioIdentityKey(resolved, '12345678/1'),
    )
  })

  it('keeps two houses apart even when they share a folio number', () => {
    // Folio numbers are RTA-scoped, which is the entire reason the house appears in the key.
    const [first, second] = AMC_REGISTRY
    if (first === undefined || second === undefined) throw new Error('registry too small')
    const a = resolveAmc({ printedNames: [first.printedNames[0] as string], isins: [] })
    const b = resolveAmc({ printedNames: [second.printedNames[0] as string], isins: [] })
    expect(mfFolioIdentityKey(a, '12345678/0')).not.toBe(mfFolioIdentityKey(b, '12345678/0'))
  })
})

describe('FolioAmcIndex', () => {
  it('keys a folio on evidence gathered after the folio line was read', () => {
    // The CAMS CAS prints the folio line before the scheme line that carries the ISIN. Keying at
    // the folio line is what made one folio two accounts.
    const index = new FolioAmcIndex()
    index.observeName('Some House Nobody Wrote Down Asset Management Ltd', '12345678/0')
    index.observeIsin('Some House Nobody Wrote Down Asset Management Ltd', '12345678/0', HDFC_ISIN)
    expect(index.identityKey('Some House Nobody Wrote Down Asset Management Ltd', '12345678/0')).toBe(
      `mf-folio:${HDFC?.id ?? ''}:12345678/0`,
    )
  })

  it('merges two spellings of one house within a document', () => {
    const index = new FolioAmcIndex()
    index.observeName('HDFC Mutual Fund', '12345678/0')
    index.observeName('HDFC Asset Management Company Limited', '12345678/0')
    expect(index.identityKey('HDFC Mutual Fund', '12345678/0')).toBe(
      index.identityKey('HDFC Asset Management Company Limited', '12345678/0'),
    )
  })

  it('resolves a folio it never saw from the name alone, rather than throwing', () => {
    const index = new FolioAmcIndex()
    expect(index.identityKey('HDFC Mutual Fund', '77777777/0')).toBe(
      `mf-folio:${HDFC?.id ?? ''}:77777777/0`,
    )
  })
})
