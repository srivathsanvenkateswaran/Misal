/**
 * The synthetic fixture corpus.
 *
 * Every folio number, PAN, name and amount below is invented. ISINs are real, and deliberately
 * so: an ISIN names a public security rather than a person, and it is the thing under test.
 *
 * The fixtures carry the hazards on purpose — a rotated watermark, a doubled glyph, a soft hyphen
 * inside an ISIN, repeated page furniture, and a scheme whose rows continue across a page break.
 * A fixture without them tests a parser against a document that does not exist.
 */

import type { FixturePage, FixtureRow } from './pdf-builder'
import { buildPages, right } from './pdf-builder'
import type { RawPdfPage } from '../types'

/** U+00AD, inserted mid-ISIN at a wrap point by both CAS families. */
const SOFT_HYPHEN = String.fromCharCode(0x00ad)

const AMOUNT = 360
const UNITS = 425
const NAV = 480
const BALANCE = 545

const TABLE_HEADER: FixtureRow = [
  { text: 'Date', x: 40 },
  { text: 'Transaction', x: 110 },
  right('Amount (INR)', AMOUNT),
  right('Units', UNITS),
  right('NAV', NAV),
  right('Unit Balance', BALANCE),
]

function txnRow(
  date: string,
  description: string,
  amount: string,
  units: string,
  nav: string,
  balance: string,
): FixtureRow {
  const cells: (string | ReturnType<typeof right> | { text: string; x: number })[] = [
    { text: date, x: 40 },
    { text: description, x: 110 },
  ]
  if (amount !== '') cells.push(right(amount, AMOUNT))
  if (units !== '') cells.push(right(units, UNITS))
  if (nav !== '') cells.push(right(nav, NAV))
  if (balance !== '') cells.push(right(balance, BALANCE))
  return cells
}

const FOOTER: FixtureRow = [{ text: 'CAMSCASWS Consolidated Account Statement', x: 40 }]

/**
 * The same fund houses, printed the way real documents print them.
 *
 * This exists because the corpus previously printed "HDFC Mutual Fund" in *both* the CAMS fixture
 * and the NSDL one, so the folio-doubling bug the identity key exists to prevent could not be
 * observed: the two slugs happened to agree. A real NSDL eCAS roster prints the legal entity, a
 * CAMS section header prints the fund, and templates differ in punctuation and spacing.
 *
 * Three forms per house, in the order [fund, legal entity, punctuation/whitespace variant]. A
 * parser change that resolves any one of them to a different identity than the others reintroduces
 * the bug, and `amc-identity.test.ts` runs every pairing.
 */
export const AMC_SPELLINGS = {
  hdfc: [
    'HDFC Mutual Fund',
    'HDFC Asset Management Company Limited',
    'HDFC  Asset Management Co. Ltd.',
  ],
  iciciPrudential: [
    'ICICI Prudential Mutual Fund',
    'ICICI Prudential Asset Management Company Limited',
    "ICICI  Prudential Asset Management Co. Ltd.",
  ],
} as const

export interface CorpusSpellings {
  /** How this document prints the house that owns folio 12345678/0. */
  readonly hdfc?: string
  /** How this document prints the house that owns folio 91012424/0. */
  readonly iciciPrudential?: string
  /** An AMC no registry entry covers, used to exercise the provisional path. */
  readonly hdfcIsin?: string
}

function spellings(overrides: CorpusSpellings = {}): { hdfc: string; icici: string; hdfcIsin: string } {
  return {
    hdfc: overrides.hdfc ?? AMC_SPELLINGS.hdfc[0],
    icici: overrides.iciciPrudential ?? AMC_SPELLINGS.iciciPrudential[0],
    hdfcIsin: overrides.hdfcIsin ?? 'INF179K01608',
  }
}

/**
 * A CAMS Detailed statement from inception: zero opening balances, reconciling checksums, and
 * therefore the only shape that yields `capability = 'ledger'`.
 *
 * Deliberately includes two identical SIP instalments on the same date, at the same NAV, for the
 * same amount. Both are real, and both must survive.
 */
export function camsDetailedPages(overrides: CorpusSpellings = {}): RawPdfPage[] {
  const amc = spellings(overrides)
  const page1: FixturePage = {
    rows: [
      [{ text: 'CAMS', x: 40 }, { text: 'Consolidated Account Statement', x: 200 }],
      [{ text: 'CONFIDENTIAL COPY', x: 560, rotated: true }],
      '01-Apr-1990 To 31-Mar-2025',
      'Email Id: investor@example.com',
      'PORTFOLIO SUMMARY',
      [{ text: 'Mutual Fund', x: 40 }, right('Cost Value', 400), right('Market Value', 545)],
      [{ text: amc.hdfc, x: 40 }, right('5,000.00', 400), right('8,838.00', 545)],
      [{ text: amc.icici, x: 40 }, right('25,000.00', 400), right('27,500.00', 545)],
      [{ text: 'Total', x: 40 }, right('30,000.00', 400), right('36,338.00', 545)],
      amc.hdfc,
      'Folio No: 12345678 / 0 PAN: AAAAA0000A KYC: OK PAN: OK',
      `H123-HDFC Flexi Cap Fund - Growth Plan - ISIN: ${amc.hdfcIsin} (Advisor: DIRECT) Registrar : CAMS`,
      'Opening Unit Balance: 0.000',
      TABLE_HEADER,
      txnRow('15-Apr-2021', 'Purchase-SIP (ECS) - Instalment 1/60', '4,999.75', '100.500', '49.7488', '100.500'),
      txnRow('15-Apr-2021', '*** Stamp Duty ***', '0.25', '', '', ''),
      txnRow('15-May-2021', 'Systematic Investment (2/60)', '5,000.00', '98.400', '50.8130', '198.900'),
      txnRow('15-May-2021', 'Systematic Investment (2/60)', '5,000.00', '98.400', '50.8130', '297.300'),
    ],
    footer: ['Page 1 of 2', FOOTER],
  }

  const page2: FixturePage = {
    rows: [
      [{ text: 'CAMS', x: 40 }, { text: 'Consolidated Account Statement', x: 200 }],
      // The column header repeats; the scheme header does not. Context must carry over.
      TABLE_HEADER,
      txnRow('20-Jun-2022', 'Redemption Of Units', '(10,000.00)', '(150.000)', '66.6667', '147.300'),
      txnRow('10-Jul-2023', '*** IDCW Payout @ Rs.2.00 per unit ***', '294.60', '', '', '147.300'),
      'Closing Unit Balance: 147.300 NAV on 31-Mar-2025: INR 60.0000',
      'Total Cost Value: 5,000.00 Market Value on 31-Mar-2025: INR 8,838.00',
      amc.icici,
      'Folio No: 91012424 / 0 PAN: AAAAA0000A KYC: OK',
      // The ISIN carries a soft hyphen at a wrap point, exactly as a real one does.
      `P0Z1-ICICI Prudential Bluechip Fund (Demat) - ISIN: INF109K01${SOFT_HYPHEN}BL4 (Advisor: DIRECT) Registrar : CAMS`,
      'Opening Unit Balance: 0.000',
      TABLE_HEADER,
      // `2024` is drawn twice at a sub-point offset, which naive extraction renders as `22002244`.
      [
        { text: '05-Jan-2024', x: 40, overlaid: true },
        { text: 'Purchase', x: 110 },
        right('25,000.00', AMOUNT),
        right('500.000', UNITS),
        right('50.0000', NAV),
        right('500.000', BALANCE),
      ],
      'Closing Unit Balance: 500.000 NAV on 31-Mar-2025: INR 55.0000',
      'Total Cost Value: 25,000.00 Market Value on 31-Mar-2025: INR 27,500.00',
    ],
    footer: ['Page 2 of 2', FOOTER],
  }

  return buildPages([page1, page2])
}

/** The same statement with one scheme opening at a non-zero balance: history is incomplete. */
export function camsDetailedPartialHistoryPages(): RawPdfPage[] {
  return mutate(camsDetailedPages(), 'Opening Unit Balance: 0.000', 'Opening Unit Balance: 40.000')
}

/** The same statement with one transaction row deleted: the checksums must catch it. */
export function camsDetailedDroppedRowPages(): RawPdfPage[] {
  const pages = camsDetailedPages()
  const page = pages[0]
  if (page === undefined) throw new Error('unreachable')
  const dropped = page.items.filter((item) => item.y !== yOf(page.items, 'Redemption Of Units'))
  const second = pages[1]
  if (second === undefined) throw new Error('unreachable')
  const secondDropped = second.items.filter((item) => item.y !== yOf(second.items, 'Redemption Of Units'))
  return [
    { ...page, items: dropped },
    { ...second, items: secondDropped },
  ]
}

/** A CAMS Summary: holdings only, no transactions, and the folio glued to the ISIN. */
export function camsSummaryPages(overrides: CorpusSpellings = {}): RawPdfPage[] {
  const amc = spellings(overrides)
  const page: FixturePage = {
    rows: [
      [{ text: 'CAMS', x: 40 }, { text: 'Consolidated Account Summary', x: 200 }],
      'As on 31-Mar-2025',
      amc.hdfc,
      [
        { text: 'Folio No. ISIN', x: 40 },
        { text: 'Scheme Name', x: 170 },
        right('Cost Value', 320),
        right('Closing Unit Balance', 430),
        right('NAV', 470),
        right('Market Value', 545),
      ],
      [
        // Folio and ISIN print with no separator between them.
        { text: `12345678/0${amc.hdfcIsin}`, x: 40 },
        { text: 'HDFC Flexi Cap Fund - Growth Plan', x: 170 },
        right('5,000.00', 320),
        right('147.300', 430),
        right('60.0000', 470),
        right('8,838.00', 545),
      ],
    ],
    footer: ['Page 1 of 1', FOOTER],
  }
  return buildPages([page])
}

/**
 * An NSDL eCAS naming the *same* HDFC folio as the CAMS statement above.
 *
 * This is the fixture that catches the worst bug available to this product: if the folio becomes
 * two accounts, every overlapping transaction gets a different natural key and the user's net
 * worth doubles.
 *
 * Its roster prints the **legal entity** by default, not the fund name, because that is what a
 * real eCAS prints and because the two fixtures agreeing on "HDFC Mutual Fund" is precisely why
 * the doubling bug survived a full test suite.
 */
export function nsdlEcasPages(overrides: CorpusSpellings = {}): RawPdfPage[] {
  const amc = spellings({ hdfc: AMC_SPELLINGS.hdfc[1], ...overrides })
  const page: FixturePage = {
    rows: [
      'NSDL Consolidated Account Statement',
      'National Securities Depository Limited',
      'Statement for the period from 01-Mar-2025 to 31-Mar-2025',
      'Your Demat Account and Mutual Fund Folios',
      // The DP Name column is given real width because the legal-entity form of an AMC name is
      // long — "HDFC Asset Management Company Limited" is 36 characters — and a roster laid out
      // for the fund form alone is a fixture that only the fund form fits.
      [
        { text: 'Account Type', x: 40 },
        { text: 'DP Name', x: 150 },
        { text: 'DP ID', x: 380 },
        { text: 'Client ID', x: 440 },
        { text: 'Folio No', x: 505 },
      ],
      [
        { text: 'Demat Account', x: 40 },
        { text: 'EXAMPLE SECURITIES', x: 150 },
        { text: 'IN300394', x: 380 },
        { text: '12345678', x: 440 },
      ],
      [
        { text: 'Mutual Fund Folio', x: 40 },
        { text: amc.hdfc, x: 150 },
        { text: '', x: 380 },
        { text: '', x: 440 },
        { text: '12345678 / 0', x: 505 },
      ],
      [
        { text: 'ISIN / Stock Symbol', x: 40 },
        { text: 'Company Name', x: 170 },
        right('Face Value in ₹', 310),
        right('No. of Shares', 380),
        right('Market Price in ₹', 470),
        right('Value in ₹', 545),
      ],
      [
        { text: 'INE009A01021 INFY.NSE', x: 40 },
        { text: 'INFOSYS LIMITED', x: 170 },
        right('5.00', 310),
        right('8.000', 380),
        right('1,610.75', 470),
        right('12,886.00', 545),
      ],
      'Mutual Fund Folios (F)',
      [
        { text: 'Folio No', x: 40 },
        { text: 'Scheme Name', x: 130 },
        { text: 'ISIN', x: 300 },
        right('Closing Balance', 420),
        right('NAV', 470),
        right('Value', 545),
      ],
      [
        { text: '12345678 / 0', x: 40 },
        { text: 'HDFC Flexi Cap Fund - Growth', x: 130 },
        { text: amc.hdfcIsin, x: 300 },
        right('147.300', 420),
        right('60.0000', 470),
        right('8,838.00', 545),
      ],
    ],
    footer: ['Page 1 of 1', 'About NSDL'],
  }
  return buildPages([page])
}

/** A photographed statement: a text layer with almost nothing in it. */
export function scannedPages(): RawPdfPage[] {
  return buildPages([{ rows: ['scan'] }])
}

function mutate(pages: readonly RawPdfPage[], from: string, to: string): RawPdfPage[] {
  let replaced = false
  return pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (replaced || item.text !== from) return item
      replaced = true
      return { ...item, text: to }
    }),
  }))
}

function yOf(items: readonly { text: string; y: number }[], text: string): number | null {
  return items.find((item) => item.text === text)?.y ?? null
}
