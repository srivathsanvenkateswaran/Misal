/**
 * Which AMC is this folio's, and therefore what is the folio's account identity?
 *
 * A mutual fund folio number is RTA-scoped rather than globally unique, so the account identity
 * key has to name the fund house as well as the folio. That is the *only* reason the AMC appears
 * in an identity key, and it is why getting it wrong is expensive: one folio arriving in a CAMS
 * statement and again in an NSDL eCAS must land on one account, or every overlapping transaction
 * gets a different `account_id`, therefore a different `natural_key`, therefore no deduplication —
 * and the user's net worth doubles.
 *
 * Two documents naming the same house do not agree on how to spell it. CAMS prints the fund form
 * ("HDFC Mutual Fund"); a depository roster prints the legal entity ("HDFC Asset Management
 * Company Limited"); templates differ in punctuation and spacing. Slugifying whatever was printed
 * therefore produced a different identity per document. This module replaces that with a lookup
 * into a canonical registry, and the precedence is deliberate:
 *
 *   1. **The ISIN issuer prefix.** Machine-assigned, printed per scheme by both families, and
 *      byte-identical across documents. It is the only AMC identifier on these statements that
 *      does not vary with the template, so it wins outright.
 *   2. **The printed name**, reduced to a lookup key and matched against the registry's alias
 *      list. Exact match after reduction — never fuzzy, never "closest".
 *   3. **Provisional**, clearly marked as such, plus a warning. Never a third thing that looks
 *      like a canonical id.
 *
 * When the name and the ISIN disagree the ISIN still wins and a warning is raised, rather than the
 * pair being demoted to provisional. Demoting would reintroduce exactly the bug this module
 * exists to fix: the document that spelled the house unrecognisably would fork away from the one
 * that spelled it well, and the folio would be two accounts again. The ISIN is document-invariant,
 * so resolving on it keeps one folio on one account whatever the disagreement turns out to mean.
 */

import type { RawIssue } from '../issues'
import { amcLookupKey, nameToken } from './names'
import { findByIsin, findByPrintedName, isinIssuerPrefix, type AmcEntry } from './registry'

/**
 * The marker that separates a provisional AMC token from a canonical registry id.
 *
 * `~` cannot appear in a registry id — `assertRegistry` enforces `^[a-z0-9-]+$` — so an identity
 * key carrying it can never be mistaken for a resolved one, by a human reading the database or by
 * a query. That is requirement two of this fix: an unrecognised AMC may produce a *marked*
 * provisional identity, but never a plausible-looking counterfeit of a real one.
 */
export const PROVISIONAL_MARKER = 'unverified~'

/** Everything a document said about a folio's fund house, gathered before any key is built. */
export interface AmcEvidence {
  /** The AMC name as printed, in whatever form this template uses. */
  readonly printedNames: readonly string[]
  /** Every ISIN seen under this folio. All schemes in a folio belong to one house. */
  readonly isins: readonly string[]
}

export type ProvisionalReason =
  /** An ISIN was printed but its issuer prefix is not in the registry: a house Misal cannot name. */
  | 'unknown-isin-issuer'
  /** A name was printed and matched nothing; no ISIN was available to rescue it. */
  | 'unknown-name'
  /** The document named neither. */
  | 'no-evidence'

export type AmcResolution =
  | {
      readonly kind: 'canonical'
      readonly amcId: string
      readonly canonicalName: string
      readonly matchedBy: 'isin' | 'printed-name'
      /** Set when the printed name resolved to a *different* house than the ISIN did. */
      readonly disagreedWith?: { readonly printedName: string; readonly amcId: string }
    }
  | {
      readonly kind: 'provisional'
      readonly token: string
      readonly reason: ProvisionalReason
      readonly printedName: string | null
      readonly isinPrefix: string | null
    }

/**
 * Resolve the fund house from everything the document said about one folio.
 *
 * Deterministic in the evidence, not in the order it arrived: names and ISINs are considered as
 * sets, so two documents that print the same facts in a different order resolve identically.
 */
export function resolveAmc(evidence: AmcEvidence): AmcResolution {
  const prefixes = distinct(
    evidence.isins.map((isin) => isinIssuerPrefix(isin)).filter((p): p is string => p !== null),
  )
  const names = distinct(evidence.printedNames.filter((name) => name.trim() !== ''))

  const byName = firstEntry(names.map((name) => findByPrintedName(name)))
  const byIsin = firstEntry(prefixes.map((prefix) => findByIsin(prefix)))

  if (byIsin !== null) {
    const nameEntry = byName
    const conflicting =
      nameEntry !== null && nameEntry.id !== byIsin.id
        ? names.find((name) => findByPrintedName(name)?.id === nameEntry.id)
        : undefined
    return {
      kind: 'canonical',
      amcId: byIsin.id,
      canonicalName: byIsin.canonicalName,
      matchedBy: 'isin',
      ...(conflicting !== undefined && nameEntry !== null
        ? { disagreedWith: { printedName: conflicting, amcId: nameEntry.id } }
        : {}),
    }
  }

  if (byName !== null) {
    return {
      kind: 'canonical',
      amcId: byName.id,
      canonicalName: byName.canonicalName,
      matchedBy: 'printed-name',
    }
  }

  // An unrecognised ISIN prefix beats an unrecognised name as the provisional token, and the
  // difference matters: the prefix is the same in every document, so a fund house Misal does not
  // know yet still gets one stable provisional identity instead of one per spelling. A name-only
  // provisional cannot offer that, which is stated in the warning the caller raises.
  const prefix = prefixes[0] ?? null
  const printedName = names[0] ?? null
  if (prefix !== null) {
    return {
      kind: 'provisional',
      token: `${PROVISIONAL_MARKER}isin-${prefix.toLowerCase()}`,
      reason: 'unknown-isin-issuer',
      printedName,
      isinPrefix: prefix,
    }
  }
  if (printedName !== null) {
    return {
      kind: 'provisional',
      token: `${PROVISIONAL_MARKER}name-${nameToken(printedName)}`,
      reason: 'unknown-name',
      printedName,
      isinPrefix: null,
    }
  }
  return {
    kind: 'provisional',
    token: `${PROVISIONAL_MARKER}unnamed`,
    reason: 'no-evidence',
    printedName: null,
    isinPrefix: null,
  }
}

/** The token that goes into the identity key: a registry id, or a marked provisional one. */
export function amcKeySegment(resolution: AmcResolution): string {
  return resolution.kind === 'canonical' ? resolution.amcId : resolution.token
}

/**
 * The realm-qualified identity key for a folio: `mf-folio:<amc>:<folio>`.
 *
 * The sub-account suffix (`/0`) is part of the folio and is preserved — folios differing only in
 * suffix are different accounts.
 */
export function mfFolioIdentityKey(resolution: AmcResolution, folio: string): string {
  return `mf-folio:${amcKeySegment(resolution)}:${folio}`
}

/**
 * The issues a resolution owes the import report.
 *
 * A provisional identity is never silent. The user is told which house Misal could not name and
 * what the consequence is, because the consequence — the same folio possibly landing twice if the
 * next statement spells it differently — is theirs to understand, not ours to hide.
 */
export function amcIssues(resolution: AmcResolution, folio: string, ref: string): RawIssue[] {
  if (resolution.kind === 'canonical') {
    const disagreement = resolution.disagreedWith
    if (disagreement === undefined) return []
    return [
      {
        severity: 'warning',
        code: 'W_AMC_NAME_CONFLICT',
        message:
          `folio ${folio} is printed under "${disagreement.printedName}", which Misal knows as ` +
          `${disagreement.amcId}, but its ISIN belongs to ${resolution.amcId}. The ISIN decides, ` +
          `because it is the same in every statement; the name is not.`,
        ref,
      },
    ]
  }

  const named =
    resolution.printedName === null ? 'an unnamed fund house' : `"${resolution.printedName}"`
  const stability =
    resolution.reason === 'unknown-name'
      ? 'and no ISIN was printed for it, so a statement spelling the name differently would ' +
        'create a second account for this folio'
      : 'so this folio keeps one identity across statements, but the holding is not attributed ' +
        'to a known fund house'
  return [
    {
      severity: 'warning',
      code: 'W_AMC_UNRECOGNISED',
      message:
        `${named} is not in Misal's AMC registry, so folio ${folio} was given a provisional ` +
        `identity (${resolution.token}) ${stability}.`,
      ref,
    },
  ]
}

// ---------------------------------------------------------------------------
// Per-folio evidence, gathered before any key is built
// ---------------------------------------------------------------------------

/**
 * Accumulates the evidence for each folio in one document, so that a key is only built once the
 * whole document has been read.
 *
 * This exists because of the order the CAMS CAS prints things: the AMC section header, then the
 * folio line, then the scheme line carrying the ISIN. The folio's identity needs the ISIN, and the
 * ISIN arrives after the folio. Rather than key on whatever was known at the time — which is how
 * the name-slug bug survived — every plugin scans first and keys afterwards.
 *
 * Folios are scoped by the printed AMC name as well as the number, because folio numbers are
 * RTA-scoped: two houses can legitimately issue the same number.
 */
export class FolioAmcIndex {
  private readonly evidence = new Map<string, { names: string[]; isins: string[] }>()

  /**
   * Scope key for a folio. Two spellings of one house merge later, at resolution.
   *
   * The separator is ASCII unit separator, which occurs in neither a lookup key nor a folio
   * number, so `hdfc` + `12345678` cannot collide with `hdfc1` + `2345678`.
   */
  static scope(printedName: string, folio: string): string {
    return `${amcLookupKey(printedName)}${folio}`
  }

  observeName(printedName: string, folio: string): void {
    this.bucket(printedName, folio).names.push(printedName)
  }

  observeIsin(printedName: string, folio: string, isin: string): void {
    this.bucket(printedName, folio).isins.push(isin)
  }

  resolve(printedName: string, folio: string): AmcResolution {
    const bucket = this.evidence.get(FolioAmcIndex.scope(printedName, folio))
    return resolveAmc({
      printedNames: bucket?.names ?? [printedName],
      isins: bucket?.isins ?? [],
    })
  }

  identityKey(printedName: string, folio: string): string {
    return mfFolioIdentityKey(this.resolve(printedName, folio), folio)
  }

  private bucket(printedName: string, folio: string): { names: string[]; isins: string[] } {
    const key = FolioAmcIndex.scope(printedName, folio)
    const found = this.evidence.get(key)
    if (found !== undefined) return found
    const created = { names: [] as string[], isins: [] as string[] }
    this.evidence.set(key, created)
    return created
  }
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function firstEntry(entries: readonly (AmcEntry | null)[]): AmcEntry | null {
  return entries.find((entry): entry is AmcEntry => entry !== null) ?? null
}
