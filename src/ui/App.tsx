import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface StorageStatus {
  database_path: string
  schema_version: number
  encrypted: boolean
  account_count: number
}

/**
 * Placeholder shell.
 *
 * Exists to prove the Rust core opens an encrypted database and answers over IPC. The real
 * interface is specified in docs/specs/2026-08-12-desktop-ui.md and built against the approved
 * design in docs/design/mockups/final-consolidated.html.
 */
export function App() {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke<StorageStatus>('storage_status')
      .then(setStatus)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '2rem', lineHeight: 1.6 }}>
      <h1 style={{ letterSpacing: '0.2em', fontSize: '1rem' }}>MISAL</h1>
      {error !== null && <p role="alert">Storage unavailable: {error}</p>}
      {status !== null && (
        <dl>
          <dt>Database</dt>
          <dd>{status.database_path}</dd>
          <dt>Schema version</dt>
          <dd>{status.schema_version}</dd>
          <dt>Encrypted at rest</dt>
          <dd>{status.encrypted ? 'yes' : 'no'}</dd>
          <dt>Accounts</dt>
          <dd>{status.account_count}</dd>
        </dl>
      )}
      {status === null && error === null && <p>Opening local database…</p>}
    </main>
  )
}
