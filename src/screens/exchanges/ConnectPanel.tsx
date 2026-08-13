/**
 * The entry point for a key, and the disclosure that comes before it.
 *
 * Three things about this component are load-bearing rather than stylistic:
 *
 *   **The disclosure is rendered above the fields, always, and is not collapsible.** A warning that
 *   has to be opened is a warning the person in a hurry never reads, and the CoinDCX one is the
 *   whole point of this screen. The API key field also points at it through `aria-describedby`, so
 *   a screen-reader user hears it on focus rather than only if they happened to read past it.
 *
 *   **Both fields are uncontrolled.** They are refs, exactly as the provider key field in Settings
 *   is: with `useState` the secret would be a React state value, and every state value is reachable
 *   from a devtools snapshot, a serialised error boundary payload or a future "report a bug" hook.
 *   Read once at submit, cleared in the same synchronous block, never stored anywhere else.
 *
 *   **The acknowledgement is asked for before the key is sent, not after.** For CoinDCX the answer
 *   is knowable in advance — every key is a blocking risk — and asking afterwards would mean
 *   staging the secret, probing, discarding it for want of a tick, and making the user paste it
 *   again. For Binance it is optional, because a read-only key genuinely does not need it.
 */

import type { FormEvent, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import type { ProviderId } from '@adapters/index'
import { ADAPTER_IDS } from '@adapters/index'
import { Badge, Panel } from '../chrome'
import { providerDisclosure } from './disclosure'

export interface CredentialSubmission {
  readonly label: string
  readonly apiKey: string
  readonly apiSecret: string
  readonly acknowledged: boolean
}

export interface ConnectPanelProps {
  readonly providerId: ProviderId
  readonly onProvider: (providerId: ProviderId) => void
  readonly onSubmit: (submission: CredentialSubmission) => void
  readonly busy: boolean
  readonly note: { readonly text: string; readonly bad: boolean } | null
}

function fieldSpec(
  fields: readonly { name: string; label: string; help?: string }[],
  name: string,
  fallback: string,
): { label: string; help: string | null } {
  const found = fields.find((field) => field.name === name)
  return { label: found?.label ?? fallback, help: found?.help ?? null }
}

export function ConnectPanel(props: ConnectPanelProps): ReactNode {
  const disclosure = providerDisclosure(props.providerId)
  const apiKey = useRef<HTMLInputElement | null>(null)
  const apiSecret = useRef<HTMLInputElement | null>(null)
  const [label, setLabel] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const ids = useId()

  const disclosureId = `${ids}-disclosure`
  const keyField = fieldSpec(disclosure.credentialFields, 'apiKey', 'API key')
  const secretField = fieldSpec(disclosure.credentialFields, 'apiSecret', 'API secret')
  const blocked = disclosure.acknowledgementRequired && !acknowledged

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const keyInput = apiKey.current
    const secretInput = apiSecret.current
    if (keyInput === null || secretInput === null) return

    if (blocked) {
      setRefusal(
        `Nothing has been sent. ${disclosure.displayName} cannot tell Misal what this key is ` +
          'allowed to do, so the acknowledgement above is not a formality and there is no way to ' +
          'proceed without it.',
      )
      return
    }

    // Read once, cleared in the same block, before anything asynchronous can happen. What is
    // handed out below lives in this call's locals and in nothing else.
    const enteredKey = keyInput.value
    const enteredSecret = secretInput.value
    keyInput.value = ''
    secretInput.value = ''

    if (enteredKey.trim() === '' || enteredSecret.trim() === '') {
      setRefusal('Both the key and the secret are needed. Nothing was sent.')
      return
    }

    setRefusal(null)
    props.onSubmit({
      label: label.trim(),
      apiKey: enteredKey,
      apiSecret: enteredSecret,
      acknowledged,
    })
  }

  return (
    <Panel
      title="Connect an exchange account"
      meta="The key is staged in memory first"
      className="exch-panel"
      foot={
        'The key and secret are held in memory while Misal asks the exchange what they are allowed ' +
        'to do. Only after that check are they written to the operating system’s keychain, by the ' +
        'one command in the core that can write there — so a key Misal refuses is never stored, ' +
        'structurally rather than by convention. Nothing exchange-related is written to Misal’s ' +
        'database except a reference saying which keychain entry belongs to which account.'
      }
    >
      <form className="panel-body exch-connect" onSubmit={submit}>
        <fieldset className="exch-providers">
          <legend className="lab">Which exchange?</legend>
          {ADAPTER_IDS.map((candidate) => {
            const option = providerDisclosure(candidate)
            return (
              <label key={candidate} className="exch-provider">
                <input
                  type="radio"
                  name="exchange-provider"
                  value={candidate}
                  checked={candidate === props.providerId}
                  disabled={props.busy}
                  onChange={() => {
                    setRefusal(null)
                    setAcknowledged(false)
                    props.onProvider(candidate)
                  }}
                />
                <span>
                  <span className="exch-provider-name">{option.displayName}</span>
                  <span className="sublab">
                    reports in {option.baseCurrency} · {option.capability} account
                  </span>
                </span>
              </label>
            )
          })}
        </fieldset>

        <section
          className={`exch-disclosure exch-disclosure-${disclosure.tone}`}
          id={disclosureId}
          aria-label={`What a ${disclosure.displayName} key can do`}
          data-provider={disclosure.providerId}
        >
          <div className="exch-disclosure-head">
            <Badge tone={disclosure.tone}>
              {disclosure.acknowledgementRequired ? 'Cannot be verified' : 'Verified at connect'}
            </Badge>
            <strong className="exch-disclosure-headline">{disclosure.headline}</strong>
          </div>
          {disclosure.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <ul className="exch-steps">
            {disclosure.keySteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </section>

        <label className="exch-field" htmlFor={`${ids}-label`}>
          <span className="lab">Name for this account</span>
          <input
            id={`${ids}-label`}
            type="text"
            value={label}
            disabled={props.busy}
            placeholder={disclosure.displayName}
            onChange={(event) => {
              setLabel(event.target.value)
            }}
          />
          <span className="conf">
            Shown in the account list. Optional — it defaults to {disclosure.displayName}.
          </span>
        </label>

        <label className="exch-field" htmlFor={`${ids}-key`}>
          <span className="lab">{keyField.label}</span>
          <input
            id={`${ids}-key`}
            ref={apiKey}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={props.busy}
            aria-describedby={disclosureId}
            placeholder="Paste the key"
          />
          {keyField.help !== null && <span className="conf">{keyField.help}</span>}
        </label>

        <label className="exch-field" htmlFor={`${ids}-secret`}>
          <span className="lab">{secretField.label}</span>
          <input
            id={`${ids}-secret`}
            ref={apiSecret}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={props.busy}
            placeholder="Paste the secret"
          />
          <span className="conf">
            Both fields are cleared the moment they are read, and neither is ever shown again —
            here or anywhere else in Misal. There is no command that reads a stored key back.
          </span>
        </label>

        <label className="exch-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={props.busy}
            onChange={(event) => {
              setRefusal(null)
              setAcknowledged(event.target.checked)
            }}
          />
          <span>
            {disclosure.acknowledgement}
            <span className="conf">{disclosure.acknowledgementReason}</span>
          </span>
        </label>

        <div className="exch-actions">
          <button className="btn btn-strong" type="submit" disabled={props.busy}>
            {props.busy ? 'Checking the key…' : 'Check this key and connect'}
          </button>
          <span className="conf">
            Misal contacts {disclosure.displayName} and nothing else, over the endpoints listed in
            its allowlist. Nothing is uploaded anywhere.
          </span>
        </div>

        {refusal !== null && (
          <p className="exch-note exch-note-bad" role="alert">
            {refusal}
          </p>
        )}
        {props.note !== null && (
          <p
            className={props.note.bad ? 'exch-note exch-note-bad' : 'exch-note'}
            role={props.note.bad ? 'alert' : 'status'}
          >
            {props.note.text}
          </p>
        )}
      </form>
    </Panel>
  )
}
