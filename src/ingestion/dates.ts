/**
 * Date parsing. Strict, zoned, and English-locale by force.
 *
 * The single most consequential rule here: a date-only source produces an instant at *local*
 * midnight with the offset preserved — `2024-01-01T00:00:00+05:30` — not a UTC wall clock.
 * Converting to UTC first gives `2023-12-31T18:30:00Z`, and every downstream date-only operation
 * then reports the trade a day early. The financial-year boundary and the 31-Jan-2018
 * grandfathering date both sit on exactly this fault line.
 */

import { DateTime } from 'luxon'
import type { Parsed } from './numbers'
import { collapseWhitespace, normaliseGlyphs } from './text'

export interface Instant {
  /** ISO-8601 with an explicit offset. */
  readonly at: string
  /** Local calendar date, `YYYY-MM-DD`. The natural-key input. */
  readonly date: string
  /** IANA zone name, as declared by the source. */
  readonly tz: string
}

/**
 * Parse a printed date against the format token the record carries.
 *
 * Strict means what it says: `1-Jan-2024` against `dd-MMM-yyyy` fails rather than being
 * reinterpreted, and `31-Feb-2024` fails rather than rolling into March. Luxon is the only one of
 * the candidate libraries that does both, and its `invalidExplanation` is usable verbatim as the
 * row's error message.
 *
 * The locale is pinned to `en` so that a system locale of, say, `de-DE` does not stop `Jan`
 * parsing on a user's machine while passing in CI.
 */
export function parseDate(raw: string, format: string, timezone: string): Parsed<Instant> {
  const text = collapseWhitespace(normaliseGlyphs(raw))
  if (text === '') return { ok: false, reason: 'date is empty' }

  const parsed = DateTime.fromFormat(text, format, {
    zone: timezone,
    locale: 'en',
    numberingSystem: 'latn',
    setZone: true,
  })

  if (!parsed.isValid) {
    return {
      ok: false,
      reason: `${JSON.stringify(raw)} is not a ${format} date: ${parsed.invalidExplanation ?? parsed.invalidReason ?? 'invalid'}`,
    }
  }

  const iso = parsed.toISO({ suppressMilliseconds: true })
  if (iso === null) return { ok: false, reason: `${JSON.stringify(raw)} could not be serialised` }

  return { ok: true, value: { at: iso, date: parsed.toFormat('yyyy-MM-dd'), tz: timezone } }
}

/** Format tokens the corpus uses, named so a descriptor review can spot an invented one. */
export const KNOWN_DATE_FORMATS = {
  /** CAMS/KFintech and NSDL body text: `15-Nov-2021`. */
  casDayMonthYear: 'dd-MMM-yyyy',
  /** CDSL throughout, and NSDL holding headers: `15-11-2021`. */
  cdslNumeric: 'dd-MM-yyyy',
  /** ISO, as most broker exports write it. */
  iso: 'yyyy-MM-dd',
} as const
