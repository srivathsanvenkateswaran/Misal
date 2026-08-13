/**
 * The canonical AMC registry — the authority for "which fund house is this folio's?".
 *
 * ## Why a registry and not normalisation
 *
 * The identity key for a mutual fund folio has to name the fund house, because folio numbers are
 * RTA-scoped rather than globally unique. It used to name it with a slug of whatever the document
 * printed, and the two document families do not print the same string: the CAMS/KFintech CAS
 * prints a fund name as its section header ("HDFC Mutual Fund"), a depository roster prints the
 * legal entity ("HDFC Asset Management Company Limited"). Two slugs, two identity keys, two
 * accounts for one folio, and the units counted twice.
 *
 * No amount of string normalisation fixes that safely, because the safe direction and the useful
 * direction point opposite ways: a rule loose enough to fuse "HDFC Mutual Fund" with "HDFC Asset
 * Management Company Limited" is loose enough to fuse two houses that merely share a first word,
 * and the failure it produces — one account holding two houses' folios — is worse than the one it
 * fixes. So the reduction in `names.ts` produces a *lookup key* and this table decides identity. A
 * name that is not in the table resolves to nothing, and the caller marks the folio provisional
 * rather than coining a key that looks canonical.
 *
 * ## What the statements actually print
 *
 * Researched rather than assumed, because the whole design depends on which identifiers exist:
 *
 * - **The ISIN, on both families.** The CAMS/KFintech scheme line carries `- ISIN: INF179K01608`,
 *   and the NSDL eCAS mutual fund folios table has an ISIN column. Indian mutual fund ISINs are
 *   `IN` + `F` (the mutual fund security-type letter) + a four-character **issuer code** allotted
 *   per fund house, then the scheme/plan/option suffix and a check digit. The first seven
 *   characters — `INF179K` — therefore identify the AMC and nothing else, and they are printed
 *   identically by every document that mentions the scheme. This is the only AMC identifier on
 *   these statements that does not vary with the template, which is why `identity.ts` lets it win.
 *
 *   That prefixes are AMC-scoped is not an assumption. It was checked against AMFI's own complete
 *   NAV file (`portal.amfiindia.com/spages/NAVAll.txt`, 12-Aug-2026: 51 fund houses, ~17,800
 *   scheme rows, both the growth and the reinvestment ISIN of each): **no seven-character prefix
 *   appears under two fund houses.** The prefix data below is transcribed from that file, which is
 *   also why several houses carry more than one — a prefix follows the schemes through a merger,
 *   so the acquiring house owns both.
 * - **The AMC name**, as a section header (MF CAS) or in the roster's DP Name column (NSDL eCAS).
 *   Free text, and the thing that varies.
 * - **`Registrar :`**, valued `CAMS`, `KFINTECH`, `KARVY` or `FTAMIL`. This names the *registrar*,
 *   not the fund house — one RTA services dozens of AMCs — so it cannot contribute to identity.
 *
 * Two identifiers that a first design might reach for are deliberately **not** used, because the
 * research did not establish them:
 *
 * - **The RTA scheme code** (`B92`, `D767`, `128TSDGG`, `PP001ZG`), the leading token of the CAMS
 *   scheme line. Registrars do assign these per scheme, and the codes of one AMC do tend to share
 *   a prefix, but neither CAMS nor KFintech publishes the allocation, the two registrars' code
 *   spaces overlap, and the same AMC's schemes carry different prefixes across registrars. Nothing
 *   here infers a fund house from a scheme code.
 * - **An AMFI AMC code.** AMFI's NAV file is scheme-level — scheme code, ISIN Growth, ISIN Div
 *   Reinvestment, scheme name, NAV, date — grouped under fund-house *headings* rather than under
 *   fund-house codes. AMFI publishes no stable numeric AMC code, and SEBI's registered mutual fund
 *   list is names only. The ids below are therefore Misal's own: chosen once, never derived from a
 *   printed name at runtime, and never renamed.
 *
 * ## Sources
 *
 * - Canonical names and ISIN issuer prefixes: AMFI, `portal.amfiindia.com/spages/NAVAll.txt`.
 * - Former names: SEBI's registered mutual fund list, `sebi.gov.in/filings/mutual-funds.html`,
 *   which prints them parenthetically ("Nippon India Mutual Fund (formerly Reliance Mutual Fund)").
 * - Legal-entity forms: listed only where `amcLookupKey` does not already reduce them onto the
 *   fund form. "HDFC Asset Management Company Limited" needs no entry because it reduces to `hdfc`
 *   exactly as "HDFC Mutual Fund" does; "Nippon Life India Asset Management Limited" does need one,
 *   because it has a word of brand the fund form lacks.
 *
 * ## Adding an AMC
 *
 * Add an entry with every printed form you have actually seen, and the ISIN issuer prefixes you
 * have actually observed on that house's schemes. Do not invent either. `assertRegistry` runs at
 * module load and refuses ambiguity: two entries reducing to the same lookup key, or claiming the
 * same ISIN prefix, is a bug that would silently merge two houses' folios.
 *
 * Renames and mergers are handled by keeping the old printed names and the old ISIN prefixes on
 * the surviving entry, because the folios and the ISINs survive the rename: units bought under
 * "Reliance Mutual Fund" still carry `INF204K` ISINs after the house became Nippon India, and a
 * statement printed before the rename must resolve to the same account as one printed after.
 */

import { amcLookupKey } from './names'

export interface AmcEntry {
  /**
   * Misal's own stable identifier, and the segment that lands in `account.identity_key`.
   *
   * Lowercase, hyphenated, `^[a-z0-9-]+$`. Never derived from a printed name at runtime and never
   * changed afterwards: changing one forks every folio already stored under it.
   */
  readonly id: string
  /** How Misal names the house in the UI, regardless of which document introduced it. */
  readonly canonicalName: string
  /** Observed `INFnnnX` ISIN issuer prefixes. A house may hold more than one, usually via merger. */
  readonly isinIssuerPrefixes: readonly string[]
  /** Printed forms observed on statements, including pre-rename and pre-merger names. */
  readonly printedNames: readonly string[]
}

/**
 * Every fund house AMFI's NAV file lists, ordered by scheme count so the ones a user is most
 * likely to hold read first.
 *
 * `printedNames` is the curated part. It always contains the canonical name; it contains a former
 * name where SEBI records one, and a legal-entity form only where the reduction in `names.ts` does
 * not already produce the same lookup key. Adding more as they are observed on real statements is
 * a data change, and a missing one is not a correctness hole — the ISIN resolves the folio anyway,
 * and a folio that resolves through neither is marked provisional and warned about rather than
 * guessed at.
 */
export const AMC_REGISTRY: readonly AmcEntry[] = [
  {
    id: 'icici-prudential',
    canonicalName: 'ICICI Prudential Mutual Fund',
    isinIssuerPrefixes: ['INF109K', 'INF613Q', 'INF346A'],
    printedNames: ['ICICI Prudential Mutual Fund'],
  },
  {
    id: 'nippon-india',
    canonicalName: 'Nippon India Mutual Fund',
    isinIssuerPrefixes: ['INF204K', 'INF732E', 'INF457M'],
    printedNames: [
      'Nippon India Mutual Fund',
      // The legal entity carries a word of brand the fund name does not, so the reduction cannot
      // reach it and it has to be written out.
      'Nippon Life India Asset Management Limited',
      // SEBI: "Nippon India Mutual Fund (formerly Reliance Mutual Fund)". Folios and ISINs
      // survived the 2019 rename, so a statement printed before it must reach the same account.
      'Reliance Mutual Fund',
      'Reliance Nippon Life Mutual Fund',
    ],
  },
  {
    id: 'uti',
    canonicalName: 'UTI Mutual Fund',
    isinIssuerPrefixes: ['INF789F', 'INF189A'],
    printedNames: ['UTI Mutual Fund'],
  },
  {
    id: 'kotak-mahindra',
    canonicalName: 'Kotak Mahindra Mutual Fund',
    isinIssuerPrefixes: ['INF174K', 'INF178L'],
    printedNames: ['Kotak Mahindra Mutual Fund', 'Kotak Mutual Fund'],
  },
  {
    id: 'sbi',
    canonicalName: 'SBI Mutual Fund',
    isinIssuerPrefixes: ['INF200K'],
    printedNames: ['SBI Mutual Fund'],
  },
  {
    id: 'bandhan',
    canonicalName: 'Bandhan Mutual Fund',
    isinIssuerPrefixes: ['INF194K'],
    // SEBI: "Bandhan Mutual Fund (Formerly IDFC Mutual Fund)".
    printedNames: ['Bandhan Mutual Fund', 'IDFC Mutual Fund'],
  },
  {
    id: 'hdfc',
    canonicalName: 'HDFC Mutual Fund',
    isinIssuerPrefixes: ['INF179K'],
    printedNames: ['HDFC Mutual Fund'],
  },
  {
    id: 'axis',
    canonicalName: 'Axis Mutual Fund',
    isinIssuerPrefixes: ['INF846K'],
    printedNames: ['Axis Mutual Fund'],
  },
  {
    id: 'aditya-birla-sun-life',
    canonicalName: 'Aditya Birla Sun Life Mutual Fund',
    isinIssuerPrefixes: ['INF209K', 'INF084M'],
    printedNames: [
      'Aditya Birla Sun Life Mutual Fund',
      // SEBI spells it as one word; the reduction treats the two as different keys, correctly.
      'Aditya Birla Sunlife Mutual Fund',
      'Birla Sun Life Mutual Fund',
    ],
  },
  {
    id: 'dsp',
    canonicalName: 'DSP Mutual Fund',
    isinIssuerPrefixes: ['INF740K'],
    printedNames: ['DSP Mutual Fund', 'DSP BlackRock Mutual Fund'],
  },
  {
    id: 'tata',
    canonicalName: 'Tata Mutual Fund',
    isinIssuerPrefixes: ['INF277K'],
    printedNames: ['Tata Mutual Fund'],
  },
  {
    id: 'edelweiss',
    canonicalName: 'Edelweiss Mutual Fund',
    isinIssuerPrefixes: ['INF754K', 'INF843K'],
    printedNames: ['Edelweiss Mutual Fund'],
  },
  {
    id: 'franklin-templeton',
    canonicalName: 'Franklin Templeton Mutual Fund',
    isinIssuerPrefixes: ['INF090I'],
    printedNames: [
      'Franklin Templeton Mutual Fund',
      'Franklin Templeton Asset Management (India) Private Limited',
    ],
  },
  {
    id: 'hsbc',
    canonicalName: 'HSBC Mutual Fund',
    isinIssuerPrefixes: ['INF336L', 'INF917K', 'INF677K'],
    printedNames: [
      'HSBC Mutual Fund',
      'HSBC Asset Management (India) Private Limited',
      // AMFI now lists the L&T schemes' prefix under HSBC, which is the merger showing up in the
      // data rather than a recollection of it.
      'L&T Mutual Fund',
    ],
  },
  {
    id: 'mirae-asset',
    canonicalName: 'Mirae Asset Mutual Fund',
    isinIssuerPrefixes: ['INF769K'],
    printedNames: [
      'Mirae Asset Mutual Fund',
      'Mirae Asset Investment Managers (India) Private Limited',
    ],
  },
  {
    id: 'sundaram',
    canonicalName: 'Sundaram Mutual Fund',
    isinIssuerPrefixes: ['INF903J', 'INF173K'],
    printedNames: ['Sundaram Mutual Fund', 'Principal Mutual Fund'],
  },
  {
    id: 'baroda-bnp-paribas',
    canonicalName: 'Baroda BNP Paribas Mutual Fund',
    isinIssuerPrefixes: ['INF251K', 'INF955L'],
    printedNames: [
      'Baroda BNP Paribas Mutual Fund',
      'Baroda BNP Paribas Asset Management India Private Limited',
      'Baroda Mutual Fund',
      'BNP Paribas Mutual Fund',
    ],
  },
  {
    id: 'invesco',
    canonicalName: 'Invesco Mutual Fund',
    isinIssuerPrefixes: ['INF205K'],
    // SEBI: "Invesco (Formerly Religare) Mutual Fund".
    printedNames: [
      'Invesco Mutual Fund',
      'Invesco Asset Management (India) Private Limited',
      'Religare Invesco Mutual Fund',
      'Religare Mutual Fund',
      'Lotus India Mutual Fund',
    ],
  },
  {
    id: 'groww',
    canonicalName: 'Groww Mutual Fund',
    isinIssuerPrefixes: ['INF666M'],
    // SEBI: "Groww Mutual Fund (Formerly known as Indiabulls Mutual Fund)".
    printedNames: ['Groww Mutual Fund', 'Indiabulls Mutual Fund'],
  },
  {
    id: 'lic',
    canonicalName: 'LIC Mutual Fund',
    isinIssuerPrefixes: ['INF767K', 'INF397L'],
    printedNames: ['LIC Mutual Fund', 'IDBI Mutual Fund'],
  },
  {
    id: 'pgim-india',
    canonicalName: 'PGIM India Mutual Fund',
    isinIssuerPrefixes: ['INF223J', 'INF663L'],
    printedNames: ['PGIM India Mutual Fund', 'DHFL Pramerica Mutual Fund', 'Pramerica Mutual Fund'],
  },
  {
    id: 'motilal-oswal',
    canonicalName: 'Motilal Oswal Mutual Fund',
    isinIssuerPrefixes: ['INF247L'],
    printedNames: ['Motilal Oswal Mutual Fund'],
  },
  {
    id: 'jm-financial',
    canonicalName: 'JM Financial Mutual Fund',
    isinIssuerPrefixes: ['INF192K', 'INF137A'],
    printedNames: ['JM Financial Mutual Fund'],
  },
  {
    id: 'union',
    canonicalName: 'Union Mutual Fund',
    isinIssuerPrefixes: ['INF582M'],
    printedNames: ['Union Mutual Fund', 'Union KBC Mutual Fund'],
  },
  {
    id: 'canara-robeco',
    canonicalName: 'Canara Robeco Mutual Fund',
    isinIssuerPrefixes: ['INF760K'],
    printedNames: ['Canara Robeco Mutual Fund'],
  },
  {
    id: 'bank-of-india',
    canonicalName: 'Bank of India Mutual Fund',
    isinIssuerPrefixes: ['INF761K'],
    // SEBI: "Bank of India Mutual Fund (Formerly BOI AXA Mutual Fund)".
    printedNames: ['Bank of India Mutual Fund', 'BOI AXA Mutual Fund'],
  },
  {
    id: 'quant',
    canonicalName: 'quant Mutual Fund',
    isinIssuerPrefixes: ['INF966L', 'INF206A'],
    // Both spellings of the legal entity are listed because both appear in filings, and the
    // reduction keeps `quant money` distinct from `quant` either way.
    printedNames: [
      'quant Mutual Fund',
      'Quant Money Managers Limited',
      'Quant Money Manager Limited',
      'Escorts Mutual Fund',
    ],
  },
  {
    id: 'iti',
    canonicalName: 'ITI Mutual Fund',
    isinIssuerPrefixes: ['INF00XX'],
    printedNames: ['ITI Mutual Fund'],
  },
  {
    id: 'mahindra-manulife',
    canonicalName: 'Mahindra Manulife Mutual Fund',
    isinIssuerPrefixes: ['INF174V'],
    // SEBI: "Mahindra Manulife Mutual Fund (formerly known as Mahindra Mutual Fund)".
    printedNames: ['Mahindra Manulife Mutual Fund', 'Mahindra Mutual Fund'],
  },
  {
    id: 'bajaj-finserv',
    canonicalName: 'Bajaj Finserv Mutual Fund',
    isinIssuerPrefixes: ['INF0QA7'],
    printedNames: ['Bajaj Finserv Mutual Fund', 'Bajaj Asset Management Limited'],
  },
  {
    id: 'navi',
    canonicalName: 'Navi Mutual Fund',
    isinIssuerPrefixes: ['INF959L'],
    printedNames: ['Navi Mutual Fund', 'Essel Mutual Fund', 'Peerless Mutual Fund'],
  },
  {
    id: 'whiteoak-capital',
    canonicalName: 'WhiteOak Capital Mutual Fund',
    isinIssuerPrefixes: ['INF03VN'],
    // SEBI: "WhiteOak Mutual Fund (Formerly known as Yes Mutual Fund)".
    printedNames: ['WhiteOak Capital Mutual Fund', 'WhiteOak Mutual Fund', 'YES Mutual Fund'],
  },
  {
    id: 'the-wealth-company',
    canonicalName: 'The Wealth Company Mutual Fund',
    isinIssuerPrefixes: ['INF2F00'],
    printedNames: ['The Wealth Company Mutual Fund'],
  },
  {
    id: '360-one',
    canonicalName: '360 ONE Mutual Fund',
    isinIssuerPrefixes: ['INF579M'],
    // SEBI: "360 ONE Mutual Fund (formerly known as IIFL Mutual Fund)".
    printedNames: ['360 ONE Mutual Fund', 'IIFL Mutual Fund'],
  },
  {
    id: 'trust',
    canonicalName: 'Trust Mutual Fund',
    isinIssuerPrefixes: ['INF0GCD'],
    printedNames: ['Trust Mutual Fund', 'TRUSTMF Mutual Fund'],
  },
  {
    id: 'taurus',
    canonicalName: 'Taurus Mutual Fund',
    isinIssuerPrefixes: ['INF044D'],
    printedNames: ['Taurus Mutual Fund'],
  },
  {
    id: 'quantum',
    canonicalName: 'Quantum Mutual Fund',
    isinIssuerPrefixes: ['INF082J'],
    printedNames: ['Quantum Mutual Fund'],
  },
  {
    id: 'helios',
    canonicalName: 'Helios Mutual Fund',
    isinIssuerPrefixes: ['INF0R87'],
    printedNames: ['Helios Mutual Fund'],
  },
  {
    id: 'shriram',
    canonicalName: 'Shriram Mutual Fund',
    isinIssuerPrefixes: ['INF680P'],
    printedNames: ['Shriram Mutual Fund'],
  },
  {
    id: 'ppfas',
    canonicalName: 'PPFAS Mutual Fund',
    isinIssuerPrefixes: ['INF879O'],
    printedNames: ['PPFAS Mutual Fund', 'Parag Parikh Mutual Fund'],
  },
  {
    id: 'samco',
    canonicalName: 'Samco Mutual Fund',
    isinIssuerPrefixes: ['INF0K1H'],
    printedNames: ['Samco Mutual Fund'],
  },
  {
    id: 'nj',
    canonicalName: 'NJ Mutual Fund',
    isinIssuerPrefixes: ['INF0J8L'],
    // SEBI prints it space-separated, AMFI does not, and the reduction keeps `n j` and `nj` apart.
    printedNames: ['NJ Mutual Fund', 'N J Mutual Fund'],
  },
  {
    id: 'abakkus',
    canonicalName: 'Abakkus Mutual Fund',
    isinIssuerPrefixes: ['INF2JJD'],
    printedNames: ['Abakkus Mutual Fund'],
  },
  {
    id: 'zerodha',
    canonicalName: 'Zerodha Mutual Fund',
    isinIssuerPrefixes: ['INF0R8F'],
    printedNames: ['Zerodha Mutual Fund'],
  },
  {
    id: 'old-bridge',
    canonicalName: 'Old Bridge Mutual Fund',
    isinIssuerPrefixes: ['INF0S5R'],
    printedNames: ['Old Bridge Mutual Fund'],
  },
  {
    id: 'capitalmind',
    canonicalName: 'Capitalmind Mutual Fund',
    isinIssuerPrefixes: ['INF2264'],
    printedNames: ['Capitalmind Mutual Fund'],
  },
  {
    id: 'angel-one',
    canonicalName: 'Angel One Mutual Fund',
    isinIssuerPrefixes: ['INF1J2R'],
    printedNames: ['Angel One Mutual Fund'],
  },
  {
    id: 'jio-blackrock',
    canonicalName: 'Jio BlackRock Mutual Fund',
    isinIssuerPrefixes: ['INF22M0'],
    printedNames: ['Jio BlackRock Mutual Fund'],
  },
  {
    id: 'alphagrep',
    canonicalName: 'AlphaGrep Mutual Fund',
    isinIssuerPrefixes: ['INF2VOA'],
    printedNames: ['AlphaGrep Mutual Fund'],
  },
  {
    id: 'choice',
    canonicalName: 'Choice Mutual Fund',
    isinIssuerPrefixes: ['INF2KCX'],
    printedNames: ['Choice Mutual Fund'],
  },
  {
    id: 'unifi',
    canonicalName: 'Unifi Mutual Fund',
    isinIssuerPrefixes: ['INF1MIY'],
    printedNames: ['Unifi Mutual Fund'],
  },
]

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * The seven-character ISIN issuer prefix, or null when the ISIN is not an Indian mutual fund one.
 *
 * `INE...` is an Indian *equity* ISIN and names a company, not a fund house; returning null for it
 * is correct rather than defensive.
 */
const ISIN_ISSUER = /^INF[0-9A-Z]{4}$/

export function isinIssuerPrefix(isin: string): string | null {
  const prefix = isin.replace(/\s+/g, '').slice(0, 7).toUpperCase()
  return ISIN_ISSUER.test(prefix) ? prefix : null
}

const BY_ISIN = new Map<string, AmcEntry>()
const BY_NAME = new Map<string, AmcEntry>()

/** The entry that issued this ISIN prefix, or null. Never a guess. */
export function findByIsin(isinOrPrefix: string): AmcEntry | null {
  const prefix = isinIssuerPrefix(isinOrPrefix)
  return prefix === null ? null : (BY_ISIN.get(prefix) ?? null)
}

/** The entry a printed name names, matched exactly after reduction, or null. */
export function findByPrintedName(printedName: string): AmcEntry | null {
  const key = amcLookupKey(printedName)
  return key === '' ? null : (BY_NAME.get(key) ?? null)
}

export function findById(id: string): AmcEntry | null {
  return AMC_REGISTRY.find((entry) => entry.id === id) ?? null
}

/** Every lookup key the registry answers to, for the migration-coverage test. */
export function registryLookupKeys(): { readonly amcId: string; readonly lookupKey: string }[] {
  return [...BY_NAME.entries()].map(([lookupKey, entry]) => ({ amcId: entry.id, lookupKey }))
}

// ---------------------------------------------------------------------------
// Load-time validation
// ---------------------------------------------------------------------------

const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Refuse an ambiguous registry at import time rather than at the moment a user's folio is keyed.
 *
 * Every check here guards a specific way this table could silently merge two fund houses into one
 * account, or fork one into two. A duplicate lookup key is the dangerous one: it means two entries
 * answer to the same printed name, and whichever the map happened to keep would quietly own the
 * other's folios.
 */
export function assertRegistry(entries: readonly AmcEntry[]): void {
  const ids = new Set<string>()
  const isins = new Map<string, string>()
  const names = new Map<string, string>()

  for (const entry of entries) {
    if (!ID_SHAPE.test(entry.id)) {
      throw new Error(`AMC registry: id ${JSON.stringify(entry.id)} must match ${String(ID_SHAPE)}`)
    }
    if (ids.has(entry.id)) throw new Error(`AMC registry: duplicate id ${entry.id}`)
    ids.add(entry.id)

    if (entry.printedNames.length === 0) {
      throw new Error(`AMC registry: ${entry.id} lists no printed name`)
    }

    for (const prefix of entry.isinIssuerPrefixes) {
      if (!ISIN_ISSUER.test(prefix)) {
        throw new Error(`AMC registry: ${entry.id} has ISIN prefix ${prefix}, expected INFxxxx`)
      }
      const owner = isins.get(prefix)
      if (owner !== undefined) {
        throw new Error(`AMC registry: ISIN prefix ${prefix} claimed by both ${owner} and ${entry.id}`)
      }
      isins.set(prefix, entry.id)
    }

    for (const printed of entry.printedNames) {
      const key = amcLookupKey(printed)
      if (key === '') {
        throw new Error(`AMC registry: ${entry.id} lists an empty printed name`)
      }
      const owner = names.get(key)
      if (owner !== undefined && owner !== entry.id) {
        throw new Error(
          `AMC registry: ${JSON.stringify(printed)} reduces to ${JSON.stringify(key)}, which ` +
            `${owner} already answers to. Two houses cannot share a name.`,
        )
      }
      names.set(key, entry.id)
    }
  }
}

function buildIndexes(entries: readonly AmcEntry[]): void {
  assertRegistry(entries)
  BY_ISIN.clear()
  BY_NAME.clear()
  for (const entry of entries) {
    for (const prefix of entry.isinIssuerPrefixes) BY_ISIN.set(prefix, entry)
    for (const printed of entry.printedNames) BY_NAME.set(amcLookupKey(printed), entry)
  }
}

buildIndexes(AMC_REGISTRY)
