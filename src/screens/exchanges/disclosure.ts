/**
 * What the user is told about an exchange before they paste a key into it.
 *
 * Two disclosures, and they are deliberately not the same shape, because the two exchanges are not
 * in the same position:
 *
 *   **Binance has a real permission gate.** `/sapi/v1/account/apiRestrictions` reports what the key
 *   itself may do, Misal reads it before storing anything, and a key with withdrawals enabled is
 *   refused outright with no override. So the Binance disclosure is instructions plus a promise the
 *   code keeps.
 *
 *   **CoinDCX has none.** It issues no read-only keys and exposes no endpoint that says what a key
 *   can do, so there is nothing to check and nothing to refuse. A user handing Misal a CoinDCX key
 *   is trusting Misal's own request allowlist and nothing else. That is stated at the point of
 *   entry, in those words, and is not softened into reassurance — an open-source finance tool that
 *   quietly accepts withdrawal-capable keys deserves the scrutiny it gets, and the only defensible
 *   response is to describe the exposure precisely and let the user decide.
 *
 * Everything that the adapter already knows — display name, base currency, capability, the
 * credential fields, the coverage gaps — is read from the adapter rather than restated here, on the
 * same discipline as the network table in Settings: read the fact, never assert it. What is written
 * out below is only the part no adapter field carries.
 */

import { createAdapter } from '@adapters/index'
import type { CredentialFieldSpec, ProviderId } from '@adapters/index'

export interface ProviderDisclosure {
  readonly providerId: ProviderId
  readonly displayName: string
  readonly baseCurrency: string
  /** Read from the adapter. 'snapshot' for both v1 exchanges, and the UI says what that costs. */
  readonly capability: 'ledger' | 'snapshot'
  readonly credentialFields: readonly CredentialFieldSpec[]
  /** The adapter's own statement of what it cannot see. Not rewritten here. */
  readonly coverageGaps: readonly string[]

  /** The one sentence the user must read before pasting anything. */
  readonly headline: string
  /** The rest of it. Plain, and not shortened into a slogan. */
  readonly body: readonly string[]
  /** How alarming the panel looks. `crit` is reserved for an exchange that cannot be checked. */
  readonly tone: 'crit' | 'warn'
  /**
   * True when the exchange cannot say what a key may do, so *every* key is a blocking risk and the
   * acknowledgement is known in advance rather than discovered after a probe. Asking for it up
   * front spares a CoinDCX user a pointless round trip in which the secret is staged, refused for
   * want of a tick, discarded, and has to be pasted again.
   */
  readonly acknowledgementRequired: boolean
  readonly acknowledgement: string
  /** Why the button will not move until the box is ticked. Never an unexplained disabled control. */
  readonly acknowledgementReason: string
  readonly keySteps: readonly string[]
}

const COINDCX_BODY: readonly string[] = [
  'Every CoinDCX API key can place trades and move funds. There is no read-only option to choose, ' +
    'and no endpoint that reports what a key is permitted to do — so Misal cannot check this key, ' +
    'and neither can you.',
  'That means the only thing standing between this key and your money is Misal’s own request ' +
    'allowlist: three endpoints — market details, balances, trade history — enforced in the Rust ' +
    'core, where the user interface cannot widen them. There is no second lock. If that allowlist ' +
    'is wrong, or this machine is compromised while the key is in its keychain, the key is enough ' +
    'to trade and to withdraw.',
  'Misal is open source so that this claim can be checked rather than believed: the list is in ' +
    'src/adapters/coindcx/allowlist.ts and its enforced copy in src-tauri/src/sync.rs. Read them ' +
    'before you paste a key. If you would rather not extend that trust, import CoinDCX’s CSV ' +
    'export instead — it carries the same trades and no key at all.',
]

const BINANCE_BODY: readonly string[] = [
  'Binance reports what a key is allowed to do, and Misal reads that report before it stores ' +
    'anything. A key that can withdraw is refused outright: the connect stops, and the secret is ' +
    'never written to the keychain. There is no override and no “I understand” checkbox for that ' +
    'one, because withdrawal is the only permission that can move funds off the exchange and a ' +
    'tracker has no use for it.',
  'Create the key with Enable Reading only. A key that can also trade will be accepted, but you ' +
    'will be shown that it can and asked to say so first; a genuinely read-only key is stored ' +
    'without asking you anything.',
  'Bind the key to this machine’s IP address in Binance’s API management if you can. Misal cannot ' +
    'require it, and will tell you when a key is unrestricted rather than assume you meant it.',
]

/**
 * The Binance Convert blind spot, stated as its consequence.
 *
 * The adapter's own `coverageGaps` says Convert fills never appear in trade history. What it cannot
 * say, because it is not the adapter's job, is what that means for the person reading the screen:
 * an asset bought through Convert has no cost basis here at all — not an approximate one. Someone
 * who bought their first BTC with the Convert button and is never told this will read a balance
 * with no trades behind it as a bug in Misal rather than as a hole in what Binance returns.
 */
export const CONVERT_BLIND_SPOT = {
  headline: 'Convert trades are read, but the oldest ones arrive over several syncs',
  body:
    'Convert trades — the one-click Convert widget in the app and on the website — are never ' +
    'returned by the ordinary trade-history endpoint. Misal reads them from a separate one, so ' +
    'an asset you bought that way does have its trades behind it. That endpoint only answers ' +
    'thirty days at a time and is expensive against Binance’s account budget, so each sync walks ' +
    'a few more windows backwards rather than stalling. Until it reaches the beginning, the sync ' +
    'report names the date it has read back to, and anything earlier is genuinely absent rather ' +
    'than approximate.',
} as const

const COPY: Record<
  ProviderId,
  Pick<
    ProviderDisclosure,
    | 'headline'
    | 'body'
    | 'tone'
    | 'acknowledgementRequired'
    | 'acknowledgement'
    | 'acknowledgementReason'
    | 'keySteps'
  >
> = {
  coindcx: {
    headline: 'CoinDCX issues no read-only API keys. This key will be able to trade and withdraw.',
    body: COINDCX_BODY,
    tone: 'crit',
    acknowledgementRequired: true,
    acknowledgement:
      'I have read the above. I accept that this key can trade and withdraw, that CoinDCX will ' +
      'not tell anyone otherwise, and that Misal’s request allowlist is the only thing standing ' +
      'in the way.',
    acknowledgementReason:
      'Every CoinDCX key carries this exposure, so the acknowledgement is asked for before the ' +
      'key is entered rather than after it has been sent to the exchange.',
    keySteps: [
      'CoinDCX → Profile → API Dashboard → Create New API Key.',
      'Restrict the key to this machine’s IP address if CoinDCX offers you the option.',
      'Copy the secret when it is shown. It is shown once.',
    ],
  },
  binance: {
    headline: 'Binance keys carry real permissions, and Misal checks them before storing anything.',
    body: BINANCE_BODY,
    tone: 'warn',
    acknowledgementRequired: false,
    acknowledgement:
      'I accept that this key may be able to place trades, if Binance reports that it can.',
    acknowledgementReason:
      'Not required for a read-only key. Tick it only if you already know this key can trade, or ' +
      'leave it — Binance will be asked, and you will be shown the answer before anything is ' +
      'stored.',
    keySteps: [
      'Binance → Account → API Management → Create API → System generated.',
      'Tick Enable Reading. Leave Enable Spot & Margin Trading and Enable Withdrawals off.',
      'Restrict access to this machine’s IP address, then copy the secret. It is shown once.',
    ],
  },
}

/**
 * The disclosure for one exchange, half read from its adapter and half written above.
 *
 * Constructing the adapter is free — no socket is opened and no credential is touched — and it is
 * what keeps `coverageGaps` and the credential fields from drifting away from the code that
 * actually produces them.
 */
export function providerDisclosure(providerId: ProviderId): ProviderDisclosure {
  const { adapter } = createAdapter(providerId)
  return {
    providerId,
    displayName: adapter.displayName,
    baseCurrency: adapter.baseCurrency,
    capability: adapter.capability,
    credentialFields: adapter.credentialFields,
    coverageGaps: adapter.coverageGaps,
    ...COPY[providerId],
  }
}

/** What `capability: 'snapshot'` withholds, said once, in the place the figures appear. */
export const SNAPSHOT_CONSEQUENCE =
  'A crypto account is a snapshot account. Balances are what the exchange reports, and they are ' +
  'trustworthy; the trade history behind them cannot be shown to be complete, so cost basis, ' +
  'realised and unrealised gains and XIRR are withheld for this account rather than estimated ' +
  'from a history with holes in it.'
