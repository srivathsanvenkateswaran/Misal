/**
 * The accounts that are already connected, and the one destructive action on this screen.
 *
 * Disconnecting removes the key from the operating system's keychain. It does not remove the
 * balances and trades already synced — those are the user's data, and deleting them is a different
 * decision that this button does not get to make on their behalf. The confirmation says exactly
 * that, because "disconnect" is ambiguous between the two and a user who expects one and gets the
 * other has been misled by a word.
 *
 * The date shown is the `as_of` of the most recent balance set committed, not a "last synced at"
 * timestamp: that column is written by the sync but no read command exposes it, and inventing a
 * time from the data would misreport a sync that ran and committed nothing. The column is labelled
 * for what it is.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { Badge, Panel } from '../chrome'
import { providerDisclosure } from './disclosure'
import type { ConnectionView } from './runtime'

export interface ConnectionsProps {
  readonly connections: readonly ConnectionView[]
  /** The account a sync or a disconnect is currently running for. */
  readonly busyAccountId: string | null
  readonly note: { readonly text: string; readonly bad: boolean } | null
  readonly onSync: (connection: ConnectionView) => void
  readonly onDisconnect: (connection: ConnectionView) => void
}

export function Connections(props: ConnectionsProps): ReactNode {
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <Panel
      title="Connected accounts"
      meta={
        props.connections.length === 1
          ? '1 account'
          : `${String(props.connections.length)} accounts`
      }
      className="exch-panel"
      foot={
        'Disconnecting deletes the API key and secret from the operating system’s keychain and the ' +
        'reference that names them. It leaves the balances and trades already synced in place: ' +
        'they are your records, and removing them is a separate decision this button does not ' +
        'make for you.'
      }
    >
      <div className="panel-body">
        <table className="dtable exch-connections">
          <caption className="vh">Exchange accounts with a key stored on this machine</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Exchange</th>
              <th scope="col">Key</th>
              <th scope="col">Balances as of</th>
              <th scope="col">
                <span className="vh">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.connections.map((connection) => {
              const disclosure = providerDisclosure(connection.providerId)
              const busy = props.busyAccountId === connection.accountId
              return (
                <tr key={connection.accountId}>
                  <th scope="row">
                    {connection.label}
                    <span className="acct-prov">
                      {connection.baseCurrency} ·{' '}
                      {connection.capability === 'snapshot'
                        ? 'snapshot — no cost basis or XIRR'
                        : 'ledger'}
                    </span>
                  </th>
                  <td>{disclosure.displayName}</td>
                  <td>
                    {connection.credentialStored ? (
                      <Badge tone="ok">In the keychain</Badge>
                    ) : (
                      <Badge tone="warn">No key stored</Badge>
                    )}
                  </td>
                  <td>
                    {connection.balancesAsOf ?? (
                      <span className="muted">no balances committed yet</span>
                    )}
                  </td>
                  <td className="exch-row-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy || !connection.credentialStored}
                      onClick={() => {
                        props.onSync(connection)
                      }}
                    >
                      {busy ? 'Working…' : 'Sync now'}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(
                          confirming === connection.accountId ? null : connection.accountId,
                        )
                      }}
                    >
                      Disconnect
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {props.connections.map((connection) =>
          confirming === connection.accountId ? (
            <div
              key={connection.accountId}
              className="exch-confirm"
              role="group"
              aria-label={`Disconnect ${connection.label}`}
            >
              <strong>Remove the key for {connection.label} from the keychain?</strong>
              <p>
                The API key and secret are deleted from the operating system’s keychain, and Misal
                will not contact {providerDisclosure(connection.providerId).displayName} for this
                account again. The balances and trades already synced stay exactly where they are.
                To sync this account later you will need to create a new key and connect it again —
                there is no command that reads a stored key back, so this one cannot be recovered.
              </p>
              <div className="exch-actions">
                <button
                  className="btn btn-strong"
                  type="button"
                  disabled={props.busyAccountId === connection.accountId}
                  onClick={() => {
                    setConfirming(null)
                    props.onDisconnect(connection)
                  }}
                >
                  Remove the key
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setConfirming(null)
                  }}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : null,
        )}

        {props.note !== null && (
          <p
            className={props.note.bad ? 'exch-note exch-note-bad' : 'exch-note'}
            role={props.note.bad ? 'alert' : 'status'}
          >
            {props.note.text}
          </p>
        )}
      </div>
    </Panel>
  )
}
