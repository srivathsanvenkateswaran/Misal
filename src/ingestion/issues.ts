/**
 * Issues and the sinks that collect them.
 *
 * An issue is the only way anything in this subsystem reports a problem. Nothing throws across a
 * stage boundary except a document-level failure, because a throw would take the whole import
 * with it and the whole design says one bad row must not do that.
 */

import type { DocumentCode, IssueCode, Severity } from './codes'

export interface Issue {
  readonly severity: Severity
  readonly code: IssueCode
  readonly message: string
  /** Human-locatable origin: 'p.7 r.12', 'row 341'. */
  readonly ref?: string
  /** JSON-able copy of the offending row, sufficient to replay it from normalize. */
  readonly raw?: Readonly<Record<string, string>>
}

/** What a plugin may report. Narrower than Issue: a plugin cannot fail a document. */
export interface RawIssue {
  readonly severity: Severity
  readonly code: IssueCode
  readonly message: string
  readonly ref?: string
  readonly raw?: Readonly<Record<string, string>>
}

/**
 * A document-level failure.
 *
 * Thrown only by acquire and by the runner itself. Carries no cause chain on purpose: a cause
 * from pdf.js can contain a fragment of the file, and this object is shown to the user.
 */
export class DocumentFailure extends Error {
  override readonly name = 'DocumentFailure'
  readonly code: DocumentCode

  constructor(code: DocumentCode, message: string) {
    super(message)
    this.code = code
  }
}

export class IssueCollector {
  private readonly items: Issue[] = []

  add(issue: Issue): void {
    this.items.push(issue)
  }

  all(): readonly Issue[] {
    return this.items
  }

  count(severity: Severity): number {
    return this.items.filter((i) => i.severity === severity).length
  }

  has(code: IssueCode): boolean {
    return this.items.some((i) => i.code === code)
  }
}
