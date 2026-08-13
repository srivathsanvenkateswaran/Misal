/**
 * The password prompt.
 *
 * Worded by the provider, because the two CAS families are opened with different things and a
 * prompt that guessed would be wrong half the time. The depository form additionally offers a date
 * of birth, which is used only to compose a second candidate in memory for the PAN + DDMMYYYY
 * variant that the depositories do not document but that turns up often enough to be worth one
 * silent retry.
 *
 * Nothing typed here is stored, logged, or written to an import issue's raw payload. It is an
 * argument to one decrypt call and then it is gone — which is why this component holds the value
 * in local state and hands it to a callback rather than to a store.
 */

import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PasswordAttempt, PasswordHint } from '@ingestion/pdf/source'
import './import.css'

export interface PasswordDialogProps {
  /** 1, 2 or 3. The pipeline gives up after three rounds. */
  readonly attempt: number
  readonly hint: PasswordHint
  readonly fileName: string
  readonly onSubmit: (attempt: PasswordAttempt) => void
  readonly onCancel: () => void
}

const MAX_ROUNDS = 3

export function PasswordDialog(props: PasswordDialogProps): ReactNode {
  const { attempt, hint, fileName } = props
  const [password, setPassword] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const field = useRef<HTMLInputElement | null>(null)
  const pan = hint.style === 'pan-uppercase'

  useEffect(() => {
    field.current?.focus()
  }, [attempt])

  return (
    <div
      className="imp-scrim"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onCancel()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="imp-pw-title"
        className="imp-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit(
            dateOfBirth === '' ? { password } : { password, dateOfBirth },
          )
        }}
      >
        <h2 id="imp-pw-title" className="imp-dialog-title">
          {fileName} is password protected
        </h2>
        <p className="imp-dialog-hint">{hint.message}</p>

        <label className="imp-field" htmlFor="imp-pw">
          <span className="lab">{pan ? 'PAN of the first holder' : 'Statement password'}</span>
          <input
            ref={field}
            id="imp-pw"
            name="password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
        </label>

        {pan && (
          <label className="imp-field" htmlFor="imp-dob">
            <span className="lab">First holder’s date of birth · DDMMYYYY · optional</span>
            <input
              id="imp-dob"
              name="dateOfBirth"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="01011980"
              value={dateOfBirth}
              onChange={(event) => {
                setDateOfBirth(event.target.value)
              }}
            />
            <span className="conf">
              Tried only if the PAN alone is refused. Composed in memory for that one attempt.
            </span>
          </label>
        )}

        <p className="conf" role="status">
          {attempt > 1
            ? `Attempt ${String(attempt)} of ${String(MAX_ROUNDS)} — the previous one was refused.`
            : 'Not stored, not logged, and never written to the database.'}
        </p>

        <div className="imp-dialog-actions">
          <button className="btn btn-strong" type="submit">
            Unlock
          </button>
          <button className="btn" type="button" onClick={props.onCancel}>
            Cancel import
          </button>
        </div>
      </form>
    </div>
  )
}
