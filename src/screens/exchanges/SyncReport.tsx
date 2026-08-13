/**
 * What a sync is doing, and what it produced.
 *
 * Two jobs, both of which are honesty problems rather than layout problems.
 *
 *   **While it runs**, the screen must never look hung. A first Binance sync sweeps every plausible
 *   trading pair one call at a time — that is minutes of work at weight 20 a call, by construction
 *   and not by accident — so the phase, the pair being queried, the count within the phase, the
 *   elapsed time and the age of the last update are all shown. The clock ticks even when the
 *   adapter is quiet, because the quiet part is exactly when a user decides the app has died.
 *
 *   **When it finishes**, the screen must not let the figures imply more than they are. The fold of
 *   the ingested transactions is compared against the balance the exchange reports, and every
 *   holding where those disagree is listed with the exact difference — eighteen decimals, as
 *   strings, never rounded and never summed in anything that could be a float. That gap is the
 *   evidence behind `capability: 'snapshot'`, so it is presented as the point rather than as an
 *   apology.
 */

import type { ReactNode } from 'react'
import type {
  AdapterIssue,
  ProviderId,
  ScopeReport,
  SyncOutcome,
  SyncPhase,
  SyncProgress,
  Tristate,
} from '@adapters/index'
import { Badge, EmptyState, Panel } from '../chrome'
import { CONVERT_BLIND_SPOT, SNAPSHOT_CONSEQUENCE, providerDisclosure } from './disclosure'

const PHASE_LABEL: Record<SyncPhase, string> = {
  scope: 'Checking what the key is allowed to do',
  clock: 'Measuring the difference between this machine’s clock and the exchange’s',
  markets: 'Reading the market catalogue',
  transfers: 'Reading deposits and withdrawals',
  conversions: 'Reading Convert trades',
  balances: 'Reading balances',
  fills: 'Walking the trade history',
  coverage: 'Comparing the ingested transactions against the reported balances',
}

const PHASE_ORDER: readonly SyncPhase[] = [
  'scope',
  'clock',
  'markets',
  'balances',
  'fills',
  'coverage',
]

/**
 * Elapsed time, in whole seconds, without touching a float.
 *
 * `getTime()` differences are integer milliseconds, so BigInt division is exact and the float ban
 * is not merely satisfied but unnecessary to think about.
 */
export function formatElapsed(millis: number): string {
  const seconds = BigInt(millis) / 1000n
  const minutes = seconds / 60n
  const remainder = seconds % 60n
  if (minutes === 0n) return `${String(remainder)}s`
  return `${String(minutes)}m ${remainder < 10n ? '0' : ''}${String(remainder)}s`
}

export interface SyncProgressViewProps {
  readonly providerId: ProviderId
  /** The account being synced, as the user named it. */
  readonly label: string
  readonly progress: SyncProgress | null
  readonly elapsedMillis: number
  readonly sinceUpdateMillis: number
}

export function SyncProgressView(props: SyncProgressViewProps): ReactNode {
  const disclosure = providerDisclosure(props.providerId)
  const progress = props.progress
  const phase = progress?.phase ?? 'scope'
  const index = PHASE_ORDER.indexOf(phase)

  return (
    <Panel
      title={`Syncing ${props.label}`}
      meta={`step ${String(index + 1)} of ${String(PHASE_ORDER.length)}`}
      className="exch-panel"
      foot={
        'Balances are fetched and committed before the trade history is walked, so the figures ' +
        'appear in seconds rather than after the whole crawl. The watermark advances only after ' +
        'the page it belongs to has been committed: if this is interrupted, the work already done ' +
        'is kept and the next sync resumes from it.'
      }
    >
      <div className="panel-body exch-progress">
        <p className="exch-progress-phase" role="status" aria-live="polite">
          <strong>{PHASE_LABEL[phase]}</strong>
          {progress !== null && progress.detail !== '' && (
            <span className="exch-progress-detail">{progress.detail}</span>
          )}
        </p>

        {progress !== null && progress.total !== null ? (
          <progress
            className="exch-bar"
            value={progress.done}
            max={progress.total}
            aria-label={`${PHASE_LABEL[phase]}: ${String(progress.done)} of ${String(progress.total)}`}
          >
            {String(progress.done)} of {String(progress.total)}
          </progress>
        ) : (
          <progress className="exch-bar" aria-label={`${PHASE_LABEL[phase]}: still counting`} />
        )}

        <dl className="exch-progress-facts">
          <div>
            <dt>Done in this step</dt>
            <dd>
              {progress === null
                ? 'starting'
                : progress.total === null
                  ? `${String(progress.done)} so far — the exchange does not say how many there will be`
                  : `${String(progress.done)} of ${String(progress.total)}`}
            </dd>
          </div>
          <div>
            <dt>Running for</dt>
            <dd>{formatElapsed(props.elapsedMillis)}</dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd>{formatElapsed(props.sinceUpdateMillis)} ago</dd>
          </div>
        </dl>

        <p className="conf">
          A first sync of a busy {disclosure.displayName} account takes minutes and is meant to.
          There is no endpoint that returns every trade, so Misal asks about each trading pair the
          account’s assets could plausibly have traded in, one call at a time, inside the
          exchange’s rate limit. Leaving this screen does not stop it, and closing Misal loses only
          the page in flight.
        </p>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<SyncOutcome['status'], { label: string; tone: 'ok' | 'warn' | 'crit' }> =
  {
    completed: { label: 'Sync completed', tone: 'ok' },
    failed: { label: 'Sync failed', tone: 'crit' },
    quarantined: { label: 'Refused to sync', tone: 'crit' },
  }

export interface SyncReportViewProps {
  readonly providerId: ProviderId
  readonly outcome: SyncOutcome
  readonly instrumentNames: ReadonlyMap<string, string>
  readonly onSyncAgain?: () => void
}

export function SyncReportView(props: SyncReportViewProps): ReactNode {
  const { outcome } = props
  const disclosure = providerDisclosure(props.providerId)
  const badge = STATUS_BADGE[outcome.status]
  const gaps = outcome.coverage.filter((row) => !row.matches)
  const reconciled = outcome.coverage.length - gaps.length
  const otherIssues = outcome.issues.filter(
    (issue) => issue.code !== 'coverage_gap' && issue.code !== 'coverage_note',
  )

  return (
    <Panel
      title={`${disclosure.displayName} sync report`}
      meta={outcome.partial ? 'partial — some of it landed' : badge.label.toLowerCase()}
      className="exch-panel"
      foot={
        'Every figure here was read back from what was committed, not from what was fetched. A ' +
        'duplicate is not a failure: the same trade arriving twice — from a re-fetched page or ' +
        'from a CSV import of the same history — is recognised by its natural key and counted ' +
        'once.'
      }
    >
      <div className="panel-body exch-report">
        <div className="exch-report-head">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {outcome.partial && <Badge tone="warn">Partial</Badge>}
          <Badge tone="snapshot">Snapshot account</Badge>
        </div>

        {outcome.status === 'quarantined' && (
          <p className="exch-note exch-note-bad" role="alert">
            This key can now withdraw funds. It could not when it was connected, so it was changed
            on the exchange since. Misal stopped rather than syncing, and has deleted nothing: the
            balances and trades already stored are untouched. Disconnect this account, create a new
            key with withdrawals disabled, and connect that one.
          </p>
        )}

        {outcome.errorCode !== null && outcome.status !== 'quarantined' && (
          <p className="exch-note exch-note-bad" role="alert">
            The sync stopped early: <code>{outcome.errorCode}</code>.{' '}
            {outcome.partial
              ? 'What had already been committed was kept, and the next sync resumes from there ' +
                'rather than starting again.'
              : 'Nothing was committed.'}
          </p>
        )}

        <dl className="exch-counts">
          <div>
            <dt>Balances committed</dt>
            <dd>{String(outcome.balancesCommitted)}</dd>
          </div>
          <div>
            <dt>Trades committed</dt>
            <dd>{String(outcome.fillsCommitted)}</dd>
          </div>
          <div>
            <dt>Already held</dt>
            <dd>{String(outcome.fillsDuplicate)}</dd>
          </div>
          <div>
            <dt>Rows refused</dt>
            <dd>{String(outcome.rowsFailed)}</dd>
          </div>
        </dl>

        <ScopeSummary providerId={props.providerId} scope={outcome.scope} />

        <section className="exch-coverage" aria-label="Coverage of this account">
          <span className="lab">Transactions against reported balances</span>
          {outcome.coverage.length === 0 ? (
            <p className="muted">
              Nothing to compare: no balances were committed by this sync, so there is no reported
              holding to fold transactions against.
            </p>
          ) : gaps.length === 0 ? (
            <p>
              All {String(reconciled)} holdings reconcile exactly: the transactions Misal has for
              each add up to precisely what the exchange reports. That is the strongest evidence
              this check can produce, and it still does not prove the history is complete — an
              asset bought and then entirely sold leaves no balance to be discovered by.
            </p>
          ) : (
            <>
              <p>
                {String(reconciled)} of {String(outcome.coverage.length)} holdings reconcile
                exactly. The {String(gaps.length)} below do not: the transactions Misal has for them
                do not add up to what the exchange says is held, and the difference came from
                activity Misal cannot see.
              </p>
              <table className="dtable exch-gaps">
                <caption className="vh">
                  Holdings whose transaction history does not account for the reported balance
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Holding</th>
                    <th scope="col" className="acct-num">
                      Transactions add up to
                    </th>
                    <th scope="col" className="acct-num">
                      Exchange reports
                    </th>
                    <th scope="col" className="acct-num">
                      Unexplained
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((row) => (
                    <tr key={row.instrumentId}>
                      <th scope="row">
                        {props.instrumentNames.get(row.instrumentId) ?? row.instrumentId}
                      </th>
                      {/* Exact, digit for digit. A crypto quantity carries eighteen decimals and
                          any rounding here would be the display inventing coverage. */}
                      <td className="acct-num exch-qty">{row.folded}</td>
                      <td className="acct-num exch-qty">{row.reported}</td>
                      <td className="acct-num exch-qty">{row.difference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="conf">{SNAPSHOT_CONSEQUENCE}</p>
        </section>

        {props.providerId === 'binance' && (
          <section className="exch-blindspot" aria-label={CONVERT_BLIND_SPOT.headline}>
            <strong>{CONVERT_BLIND_SPOT.headline}</strong>
            <p>{CONVERT_BLIND_SPOT.body}</p>
          </section>
        )}

        <section className="exch-gapnotes" aria-label="What this sync cannot see">
          <span className="lab">What this sync cannot see, whatever the numbers say</span>
          <ul>
            {disclosure.coverageGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </section>

        {otherIssues.length > 0 && <IssueList issues={otherIssues} />}

        {props.onSyncAgain !== undefined && (
          <div className="exch-actions">
            <button className="btn" type="button" onClick={props.onSyncAgain}>
              Sync again
            </button>
            <span className="conf">
              A second sync resumes from the watermark rather than starting again, so it is far
              shorter than the first.
            </span>
          </div>
        )}
      </div>
    </Panel>
  )
}

function IssueList({ issues }: { readonly issues: readonly AdapterIssue[] }): ReactNode {
  return (
    <section className="exch-issues" aria-label="Issues raised by this sync">
      <span className="lab">
        {String(issues.length)} issue{issues.length === 1 ? '' : 's'} recorded against this run
      </span>
      <ul>
        {issues.map((issue, position) => (
          <li key={`${issue.code}-${String(position)}`}>
            <Badge tone={issue.severity === 'error' ? 'crit' : 'warn'}>{issue.code}</Badge>{' '}
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function tristate(value: Tristate): string {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return 'not reported'
}

/**
 * What the exchange said this key can do — or, for an exchange that says nothing, that it says
 * nothing.
 *
 * The `unscopable` branch is the important one. CoinDCX's adapter fills the `ScopeReport` with
 * placeholders because the type demands values, and rendering those placeholders as a permission
 * table would put "Can withdraw: no" on screen on the authority of nothing at all. That is exactly
 * the false reassurance the contract warns about, and it is worse than silence, so this component
 * refuses to draw the table rather than drawing one that cannot be true.
 */
export function ScopeSummary({
  providerId,
  scope,
}: {
  readonly providerId: ProviderId
  readonly scope: ScopeReport | null
}): ReactNode {
  const disclosure = providerDisclosure(providerId)
  if (scope === null) {
    return (
      <p className="muted">
        The key’s permissions were not read on this run, so nothing is claimed about them here.
      </p>
    )
  }

  if (scope.verification === 'unscopable') {
    return (
      <section className="exch-scope exch-scope-blind" aria-label="What this key can do">
        <span className="lab">What this key can do</span>
        <p>
          Unknown, and unknowable. {disclosure.displayName} has no endpoint that reports a key’s
          permissions, so Misal has nothing to show you. No permission list is drawn here on
          purpose: one built from assumptions would read as a check that happened, and “withdrawals:
          no” asserted on the authority of nothing is worse than saying nothing at all.
        </p>
      </section>
    )
  }

  return (
    <section className="exch-scope" aria-label="What this key can do">
      <span className="lab">
        What this key can do · reported by {disclosure.displayName} ({scope.verification})
      </span>
      <dl className="exch-scope-flags">
        <div>
          <dt>Read balances and trades</dt>
          <dd>{tristate(scope.canRead)}</dd>
        </div>
        <div>
          <dt>Place trades</dt>
          <dd>{tristate(scope.canTrade)}</dd>
        </div>
        <div>
          <dt>Withdraw funds</dt>
          <dd>{tristate(scope.canWithdraw)}</dd>
        </div>
        <div>
          <dt>Move funds inside the exchange</dt>
          <dd>{tristate(scope.canTransferInternally)}</dd>
        </div>
        <div>
          <dt>Restricted to an IP address</dt>
          <dd>{tristate(scope.ipRestricted)}</dd>
        </div>
      </dl>
      <p className="conf">
        “Not reported” means the exchange did not say, and is never shortened to “no”. Misal itself
        cannot place a trade or a withdrawal whatever this says — it has no code that can construct
        one, and the core refuses any request outside the allowlist before a socket is opened.
      </p>
    </section>
  )
}

/** Shown when a probe came back needing an acknowledgement the user has not given. */
export function AcknowledgementRequest({
  providerId,
  scope,
  blocking,
  advisory,
}: {
  readonly providerId: ProviderId
  readonly scope: ScopeReport
  readonly blocking: readonly string[]
  readonly advisory: readonly string[]
}): ReactNode {
  return (
    <Panel
      title="This key was not stored"
      meta="nothing reached the keychain"
      className="exch-panel exch-panel-alert"
    >
      <div className="panel-body">
        <p role="alert">
          Misal asked the exchange what this key can do, and the answer needs your agreement before
          the key is stored. It was discarded rather than kept while you decide, so you will have to
          paste it again — that is the cost of never holding a secret longer than the check that
          justified it.
        </p>
        <ul className="exch-blocking">
          {blocking.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {advisory.length > 0 && (
          <>
            <span className="lab">Worth tightening, but not required</span>
            <ul className="exch-advisory">
              {advisory.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        <ScopeSummary providerId={providerId} scope={scope} />
        <p className="conf">
          To continue, tick the acknowledgement above and paste the key again. To back out, create a
          new key on the exchange with fewer permissions and connect that one instead.
        </p>
      </div>
    </Panel>
  )
}

/** The one refusal with no override, shown where the key was entered. */
export function RefusalNotice({ message }: { readonly message: string }): ReactNode {
  return (
    <Panel title="This key was refused" meta="nothing reached the keychain" className="exch-panel exch-panel-alert">
      <div className="panel-body">
        <p role="alert">{message}</p>
        <p className="conf">
          There is no override for this one. Withdrawal is the only permission that can move funds
          off the exchange, a tracker has no use for it, and a key carrying it is deliberate
          configuration rather than an oversight. The secret was discarded without being written.
        </p>
      </div>
    </Panel>
  )
}

/** Nothing connected yet. Names what is absent and the action that would fill it. */
export function NoConnections(): ReactNode {
  return (
    <EmptyState headline="No exchange account is connected">
      Connecting one reads balances and trade history over the exchange’s own API, using a key you
      create there. Misal never places an order and never moves funds — the core refuses any request
      outside a fixed allowlist before a socket is opened.
    </EmptyState>
  )
}
