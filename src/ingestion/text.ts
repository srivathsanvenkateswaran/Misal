/**
 * Text repair shared by every parser.
 *
 * None of this is defensive tidying. Each function below exists because a real statement family
 * emits text that breaks a downstream parse in a specific, observed way, and because the repair
 * has to happen in exactly one place or the parsers will each get it subtly differently.
 *
 * The four character classes below are, in order: U+00AD soft hyphen; U+2010..U+2015 dashes plus
 * U+2212 minus; U+00A0, U+2007 and U+202F non-breaking spaces; U+2018 and U+2019 curly quotes.
 * They are named because several of them are invisible in a diff.
 */

const SOFT_HYPHEN = new RegExp('\\u00ad', 'g')
const UNICODE_DASHES = new RegExp('[\\u2010-\\u2015\\u2212]', 'g')
const NON_BREAKING_SPACES = new RegExp('[\\u00a0\\u2007\\u202f]', 'g')
const CURLY_QUOTES = new RegExp('[\\u2018\\u2019]', 'g')

/**
 * Repair the character-level damage both CAS families produce.
 *
 * - U+00AD soft hyphens are inserted mid-ISIN at wrap points, so `INF209K01<shy>BR9` must become
 *   `INF209K01BR9` or the ISIN never matches.
 * - U+2010..U+2015 and U+2212 all render as a minus and must become ASCII `-`, or a negative
 *   quantity parses as text.
 * - Both depositories emit a backtick where the font would have drawn a rupee sign.
 */
export function normaliseGlyphs(text: string): string {
  return text
    .replace(SOFT_HYPHEN, '')
    .replace(UNICODE_DASHES, '-')
    .replace(NON_BREAKING_SPACES, ' ')
    .replace(CURLY_QUOTES, "'")
    .replace(/`/g, '₹')
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Undo bold-rendering glyph doubling: `TTrraannssaaccttiioonn` -> `Transaction`.
 *
 * Only applied when the whole string is exactly doubled, because a legitimate `AA` inside a
 * security name must survive. A doubled BO ID collapses the same way, which is why this is
 * applied to identifiers as well as to headers.
 */
export function undouble(text: string): string {
  if (text.length < 4 || text.length % 2 !== 0) return text
  for (let i = 0; i < text.length; i += 2) {
    if (text[i] !== text[i + 1]) return text
  }
  let out = ''
  for (let i = 0; i < text.length; i += 2) out += text[i]
  return out
}

/**
 * Rejoin issuer letter-spacing: `S ystematic Investment` -> `Systematic Investment`,
 * `S T P In` -> `STP In`.
 *
 * KFintech statements letter-space the first character of many descriptions, and `S T P In` is
 * letter-spaced by the issuer rather than by extraction damage. Both break any classifier that
 * matches on whole words. This is for classification only; the description stored on the issue
 * and shown to the user is always the source's own text.
 */
export function rejoinLetterSpacing(text: string): string {
  const tokens = text.split(' ').filter((t) => t.length > 0)
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    let run = 0
    while (i + run < tokens.length && isSingleLetter(tokens[i + run])) run += 1
    if (run === 0) {
      out.push(tokens[i] as string)
      i += 1
      continue
    }
    const joined = tokens.slice(i, i + run).join('')
    const next = tokens[i + run]
    if (run === 1 && next !== undefined && !isSingleLetter(next)) {
      // A lone letter split off the front of a word: `S ystematic`.
      out.push(joined + next)
      i += run + 1
    } else {
      out.push(joined)
      i += run
    }
  }
  return out.join(' ')
}

function isSingleLetter(token: string | undefined): boolean {
  return token !== undefined && token.length === 1 && /[A-Za-z]/.test(token)
}

/**
 * The form a description is classified against: glyph-repaired, whitespace-collapsed, lowercase,
 * letter-spacing rejoined. Never stored, never displayed.
 */
export function classificationForm(description: string): string {
  return rejoinLetterSpacing(collapseWhitespace(normaliseGlyphs(description))).toLowerCase()
}

/** ASCII word tokens, for matching a header row that carries an interleaved translation. */
export function asciiTokens(text: string): string[] {
  return normaliseGlyphs(text)
    .split(' ')
    .map((t) => undouble(t))
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/**
 * True when every token in `wanted` appears in `text`.
 *
 * CDSL interleaves a Devanagari translation into header cells character by character, so a header
 * is never matched by string equality. Matching on an ASCII token subset survives the interleave,
 * the doubling and the column reflow all at once.
 */
export function containsTokens(text: string, wanted: readonly string[]): boolean {
  const have = new Set(asciiTokens(text))
  return wanted.every((w) => have.has(w.toLowerCase()))
}

/** How many of `labels` appear as tokens. Used to score a candidate header line. */
export function countTokenHits(text: string, labels: readonly string[]): number {
  const have = new Set(asciiTokens(text))
  return labels.filter((l) => have.has(l.toLowerCase())).length
}

/**
 * An ISIN, anchored on its fixed 12-character shape rather than on a word boundary.
 *
 * The CAMS Summary layout glues the folio and the ISIN together with no separator at all
 * (`910124242826/0INF846K01859`), so a `\b` anchor would never fire. Two leading letters mean a
 * run of digits cannot start a false match, and the trailing lookahead stops a 13-character token
 * from yielding its first 12.
 */
const ISIN_PATTERN = /[A-Z]{2}[A-Z0-9]{9}[0-9](?![A-Z0-9])/

export function findIsin(text: string): string | null {
  return ISIN_PATTERN.exec(collapseWhitespace(normaliseGlyphs(text)))?.[0] ?? null
}
