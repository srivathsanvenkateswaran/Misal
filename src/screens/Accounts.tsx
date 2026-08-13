/**
 * Screen 03 — Accounts.
 *
 * Provider, label, capability badge, value, holdings count and the date the account's data
 * carries. Plus the two doors in, and the matrix explaining what each capability unlocks — footed
 * with the concrete consequence, computed rather than written: exactly how much value importing a
 * transaction history would move across the calibration line.
 *
 * H12: capability is displayed and explained, and there is no control anywhere on this screen that
 * changes it. The only way to raise coverage is to import a document with transactions, and the
 * screen says exactly that.
 */

import type { ReactNode } from 'react'
import { Metric } from '@ui/measured/Metric'
import { SourceStamp } from '@ui/provenance/SourceStamp'
import { formatMoney, money } from '@ui/format'
import { Badge, EmptyState, Panel, ScreenHead } from './chrome'
import { CAPABILITY_BADGE, formatDate } from './view-model'
import type { AccountView, PortfolioData } from './view-model'
import './screens.css'

function AccountRow({ account }: { readonly account: AccountView }): ReactNode {
  const railClass = `acct-rail r-${account.series}${account.capability === 'snapshot' ? ' r-snap' : ''}`
  return (
    <div className="acct-row" data-row-scope="account">
      <span className="pgut">
        <SourceStamp {...account.stamp} />
      </span>
      <span className={railClass} aria-hidden="true" />
      <span>
        <span className="acct-name">{account.label}</span>
        <span className="acct-prov">
          {account.providerId} · {account.shortCode}
        </span>
      </span>
      <span>
        {account.capability === 'ledger' ? (
          <Badge>{CAPABILITY_BADGE.ledger}</Badge>
        ) : (
          <Badge tone="snapshot">{CAPABILITY_BADGE.snapshot}</Badge>
        )}
      </span>
      <span className="acct-num">
        <Metric value={account.value} metric="value" scope="account" basis="derived" size="cell" />
      </span>
      <span className="acct-num">
        {account.holdings}
        {account.unpriced > 0 && (
          <span className="acct-prov">{account.unpriced} not priced</span>
        )}
      </span>
      <span>
        {account.dataAsOf === null ? 'No rows yet' : formatDate(account.dataAsOf)}
        <span className="acct-prov">{account.dataAsOfNote}</span>
      </span>
      <span />
    </div>
  )
}

const CAPABILITY_MATRIX: readonly { readonly metric: string; readonly full: boolean }[] = [
  { metric: 'Current value · weight', full: true },
  { metric: 'Cost basis (FIFO)', full: false },
  { metric: 'Unrealised P&L', full: false },
  { metric: 'Realised P&L · capital gains', full: false },
  { metric: 'XIRR', full: false },
]

/**
 * What the capability panel says at the bottom.
 *
 * "Every account supplies transaction history" is an answer to a question about *accounts*, and it
 * used to be decided by a rupee quantity: `coverageOpportunity` is null whenever the snapshot
 * accounts contribute nothing to net worth, which is true both when there are no snapshot accounts
 * and when there is one whose holdings could not be priced. The second case printed "nothing on
 * this screen is withheld" directly beneath a row badged "Holdings only · 1 not priced" — the
 * account is right there, its capability is stated in the same table, and the foot denied it.
 *
 * So the question is asked of the accounts. The rupee figure only decides *how much* can be
 * promised, and when it cannot be stated the sentence says that rather than saying nothing is
 * missing.
 */
function capabilityFoot(data: PortfolioData): string {
  const snapshotAccounts = data.accounts.filter((account) => account.capability === 'snapshot')
  if (snapshotAccounts.length === 0) {
    return 'Every account supplies transaction history, so nothing on this screen is withheld.'
  }
  if (data.coverageOpportunity !== null) return data.coverageOpportunity
  const names = snapshotAccounts.map((account) => account.label).join(', ')
  return (
    `${names} ${snapshotAccounts.length === 1 ? 'supplies' : 'supply'} holdings only. ` +
    'None of those holdings could be priced, so how much a transaction history would move across ' +
    'the calibration line is not a figure Misal can state — importing one is still the only thing ' +
    'that changes what the metrics above can measure.'
  )
}

export function Accounts({ data }: { readonly data: PortfolioData }): ReactNode {
  return (
    <>
      <ScreenHead
        title="Accounts"
        note="Capability is stated per account · nothing leaves the machine"
      />

      <div className="acct-row acct-head">
        <span className="pgut">
          <span className="tb-lab">Src</span>
        </span>
        <span />
        <span className="tb-lab">Account</span>
        <span className="tb-lab">Capability</span>
        <span className="tb-lab acct-num">Value ₹</span>
        <span className="tb-lab acct-num">Holdings</span>
        <span className="tb-lab">Data as of</span>
        <span />
      </div>

      {data.accounts.length === 0 ? (
        <EmptyState headline="No accounts yet">
          Import a statement or connect a read-only key, and the account it belongs to appears here.
        </EmptyState>
      ) : (
        data.accounts.map((account) => <AccountRow key={account.id} account={account} />)
      )}

      <div className="dashgrid-2" style={{ padding: '16px', gridTemplateColumns: '1fr 1fr' }}>
        <Panel
          title="Add an account"
          meta="Two ways in"
          foot="No sign-in, no account, no sync. Misal reads files and read-only keys, and writes one SQLite database on this machine."
        >
          <div className="panel-body">
            <div className="doors">
              <div className="door">
                <span className="lab">Option A</span>
                <div className="door-title">Import a statement</div>
                <p>
                  CAMS / KFintech CAS PDF, NSDL or CDSL holding statement, broker tradebook CSV,
                  exchange ledger CSV. A statement with transactions gives full history; a
                  holdings-only file gives a snapshot — current value only, no cost basis, no XIRR.
                </p>
                <button className="btn btn-strong" type="button">
                  Choose file…
                </button>
              </div>
              <div className="door">
                <span className="lab">Option B</span>
                <div className="door-title">Connect a read-only API key</div>
                <p>
                  Zerodha Kite, CoinDCX, WazirX. The key is stored in the OS keychain on this
                  machine and is never transmitted anywhere except to the exchange.
                  Withdrawal-enabled keys are rejected.
                </p>
                <button className="btn btn-strong" type="button">
                  Add key…
                </button>
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          title="What each capability unlocks"
          meta="Honest by construction"
          foot={capabilityFoot(data)}
        >
          <table className="dtable">
            <caption className="vh">What each account capability unlocks</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">{CAPABILITY_BADGE.ledger}</th>
                <th scope="col">{CAPABILITY_BADGE.snapshot}</th>
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_MATRIX.map((row) => (
                <tr key={row.metric}>
                  <th scope="row">{row.metric}</th>
                  <td>
                    <Badge tone="ok">Yes</Badge>
                  </td>
                  <td>
                    {row.full ? <Badge tone="ok">Yes</Badge> : <span className="na">Not measured</span>}
                  </td>
                </tr>
              ))}
              <tr className="tot">
                <th scope="row">Contribution to the calibration bar</th>
                <td>{formatMoney(money(data.ledgerBackedMinor))}</td>
                <td>{formatMoney(money(data.snapshotOnlyMinor))}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  )
}
