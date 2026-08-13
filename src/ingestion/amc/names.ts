/**
 * Turning a printed AMC name into a *lookup key*, and nothing else.
 *
 * The distinction is the whole point of this module. The previous implementation slugified the
 * printed name and used the slug **as the identity**, so "HDFC Mutual Fund" and "HDFC Asset
 * Management Company Limited" — the same fund house, printed differently by CAMS and by NSDL —
 * produced two account identity keys, two accounts for one folio, and a doubled holding.
 *
 * Nothing here ever produces an identity. These functions produce a key that is looked up in the
 * canonical registry; a miss is a miss, and the caller goes to the provisional path rather than
 * coining something that looks legitimate. See `registry.ts` and `identity.ts`.
 */

import { collapseWhitespace, normaliseGlyphs } from '../text'

/**
 * Casefold, repair glyphs, and reduce to spaced ASCII words.
 *
 * `&` becomes ` and ` before punctuation is stripped, because "L&T" and "L and T" are the same
 * house printed two ways and dropping the ampersand outright would fuse it to "lt".
 */
export function normaliseAmcName(raw: string): string {
  return collapseWhitespace(
    normaliseGlyphs(raw)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' '),
  )
}

/**
 * Corporate and fund designators, stripped **only from the tail** of a name.
 *
 * Fixed and exhaustive rather than a pattern, and trailing-only rather than anywhere, because a
 * designator in the middle of a name is part of the name: "Nippon Life India Asset Management" is
 * not "Nippon Life India". Anything this list fails to reduce is handled by writing the printed
 * form out in the registry's alias list, which is a data change a reviewer can check.
 *
 * `india` is deliberately absent. It distinguishes real entities — "Nippon India" from "Nippon
 * Life India" — and stripping it would merge names that name different things.
 */
const TRAILING_DESIGNATORS = new Set([
  'amc',
  'asset',
  'assets',
  'co',
  'companies',
  'company',
  'corp',
  'corporation',
  'fund',
  'funds',
  'incorporated',
  'inc',
  'investment',
  'investments',
  'limited',
  'ltd',
  'management',
  'manager',
  'managers',
  'mf',
  'mutual',
  'private',
  'pvt',
  'trustee',
  'trustees',
])

/**
 * The registry lookup key: a normalised name with its trailing designators removed.
 *
 * "HDFC Mutual Fund", "HDFC Asset Management Company Limited" and "HDFC  Asset Management Co. Ltd."
 * all reduce to `hdfc`. That reduction is *not* an identity — `hdfc` is only ever used to look up
 * an entry in the registry, and an unmatched reduction never becomes an account key.
 *
 * At least one token always survives, so a name consisting entirely of designators ("Mutual Fund")
 * reduces to its last token rather than to the empty string, and therefore matches nothing.
 */
export function amcLookupKey(raw: string): string {
  const tokens = normaliseAmcName(raw)
    .split(' ')
    .filter((token) => token !== '')
  let end = tokens.length
  while (end > 1 && TRAILING_DESIGNATORS.has(tokens[end - 1] as string)) end -= 1
  return tokens.slice(0, end).join(' ')
}

/**
 * A URL-safe token derived from a printed name.
 *
 * Used **only** inside a provisional identity key, where it is prefixed with a marker that says it
 * is not a registry id. It is never a canonical identity.
 */
export function nameToken(raw: string): string {
  return normaliseAmcName(raw).replace(/ /g, '-')
}
