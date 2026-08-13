/**
 * First run — the screen that sets the tone (spec §10.1).
 *
 * A new user has no accounts and no data. The dashboard is *not* rendered with zeros in its place:
 * a net-worth tracker showing ₹0 is claiming a measurement it has not made, which is exactly the
 * failure this product exists to avoid.
 *
 * What is here instead: the app frame unchanged, so the product looks like itself immediately; the
 * calibration bar drawn but empty, because a calibrated instrument with nothing to measure is the
 * correct picture of the situation and teaches the bar's meaning before there is any data to
 * obscure it; one honest headline about where the data lives; and two doors.
 *
 * What is deliberately absent: no onboarding carousel, no sign-up, no email field, no telemetry
 * prompt, no progress checklist.
 */

import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { ZERO_MINOR } from '@domain/numeric'
import { CalibrationBar } from '@ui/charts/CalibrationBar'
import type { StorageStatus } from '../data/client'
import { ScreenHead } from './chrome'
import './screens.css'

/** Platform-adaptive, per the spec: *this Mac* / *this PC* / *this machine*. */
function platformPhrase(): string {
  const agent = globalThis.navigator.userAgent
  if (agent.includes('Mac')) return 'this Mac'
  if (agent.includes('Windows')) return 'this PC'
  return 'this machine'
}

export function FirstRun({
  status,
  onChooseFile,
}: {
  readonly status: StorageStatus | undefined
  readonly onChooseFile?: () => void
}): ReactNode {
  const where = platformPhrase()
  const chooseFile = useRef<HTMLButtonElement | null>(null)

  // Focus lands on "Choose file…", not on the heading. This is the one screen where the heading
  // rule of §11.2 gives way: there is exactly one thing to do here, and a first-run screen that
  // starts a keyboard user on a title has wasted the only moment it gets.
  useEffect(() => {
    chooseFile.current?.focus()
  }, [])

  return (
    <>
      <ScreenHead title="Dashboard" note="Nothing imported yet" />
      <div className="pad">
        <CalibrationBar
          segments={[]}
          netWorth={ZERO_MINOR}
          ledgerBacked={ZERO_MINOR}
          snapshotOnly={ZERO_MINOR}
          accountsLedger={0}
          accountsTotal={0}
          state="empty"
        />
      </div>

      <div className="firstrun">
        <h2 className="firstrun-head">All data on {where} · nothing leaves the device.</h2>
        <p className="firstrun-sub">
          {status === undefined
            ? 'Misal will create one encrypted SQLite database on this machine. The key is stored in the OS keychain.'
            : `Misal keeps one ${status.encrypted ? 'encrypted ' : ''}SQLite database at ${status.databasePath}. The key is stored in the OS keychain — never in the database, never in an export, never in the repository.`}
        </p>

        <div className="doors">
          <div className="door">
            <span className="lab">Option A</span>
            <div className="door-title">Import a statement</div>
            <p>
              CAMS/KFintech CAS PDF, NSDL or CDSL holding statement, broker tradebook CSV, exchange
              ledger CSV.
            </p>
            <p>
              <b>This choice decides what Misal can tell you.</b> A statement with transactions
              gives full history — cost basis, unrealised and realised P&amp;L, XIRR. A holdings-only
              file gives a snapshot: current value only, no cost basis, no XIRR. Misal will say
              which you gave it, on every figure that depends on the difference.
            </p>
            <button className="btn btn-strong" type="button" ref={chooseFile} onClick={onChooseFile}>
              Choose file…
            </button>
          </div>

          <div className="door">
            <span className="lab">Option B</span>
            <div className="door-title">Connect a read-only API key</div>
            <p>Zerodha Kite, CoinDCX, WazirX.</p>
            <p>
              The key is stored in the OS keychain on {where} and is never transmitted anywhere
              except to the exchange itself. Withdrawal-enabled keys are rejected.
            </p>
            <button className="btn btn-strong" type="button">
              Add key…
            </button>
          </div>
        </div>

        <p className="quiet-door">
          The bar above is the instrument this product is built around. It shows what fraction of
          your net worth the deeper metrics can actually measure. It is drawn now, with nothing in
          it, because an instrument that is calibrated and has nothing to measure is the honest
          picture of an empty database.
        </p>
      </div>
    </>
  )
}
