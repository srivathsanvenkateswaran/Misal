/**
 * Connecting an exchange account, and the one refusal that has no override.
 *
 * A key with withdrawal permission is refused outright: the connect flow aborts and the secret is
 * **never written to the keychain**. Not a warning, not an "I understand" checkbox. It is the only
 * permission that can move funds off the exchange, a tracker has no use for it, and on Binance it
 * cannot be enabled without also configuring an IP allowlist - so its presence is deliberate
 * configuration rather than a slip. Refusing costs the user two minutes; accepting could cost them
 * everything.
 *
 * Trade permission is different. Refusing it would mean refusing CoinDCX entirely, since every
 * CoinDCX key can trade. So it is recorded, surfaced as a persistent badge, and requires a
 * one-time explicit acknowledgement before the credential is stored.
 *
 * The secret reaches the vault before the scope check runs, but only ever in memory: `stage`
 * returns an opaque handle, the probe signs with it, and `commit` is the sole path to the OS
 * keychain. That is what makes "nothing written on refusal" a structural property rather than a
 * promise, and it is asserted by reading the keychain afterwards rather than by trusting a return
 * value.
 */

import type { AdapterContext, ExchangeAdapter, ScopeReport } from './contract'
import { AdapterError } from './errors'
import { createGuardedHttp, type Transport } from './http'
import type { RateLimiter } from './ratelimit'
import { fixedClockOffset, MeasuredClockOffset } from './time'

export interface PlaintextCredential {
  readonly apiKey: string
  readonly apiSecret: string
}

/**
 * Credential storage. The only implementation that touches disk is the Rust keychain binding;
 * `stage` is memory-only and its contents are zeroised on `discard`.
 */
export interface CredentialVault {
  stage(credential: PlaintextCredential): Promise<string>
  commit(handle: string, accountId: string): Promise<void>
  discard(handle: string): Promise<void>
  /** Present only so a test can assert that nothing was written. Returns no plaintext. */
  hasStoredCredential(accountId: string): Promise<boolean>
}

export interface ConnectOptions {
  readonly adapter: ExchangeAdapter
  readonly accountId: string
  readonly credential: PlaintextCredential
  readonly vault: CredentialVault
  readonly transport: Transport
  readonly limiter: RateLimiter
  readonly userAgent: string
  readonly now: () => Date
  /**
   * The user has been shown what this key can do and has accepted it. Required whenever the key
   * can trade or transfer, or whenever the exchange cannot tell us what it can do.
   */
  readonly acknowledgedRisk?: boolean
}

/**
 * What the user is told, split by whether it gates storing the credential.
 *
 * `blocking` is what the key can do that a tracker never needs - trading, internal transfers, or
 * an exchange that will not say. `advisory` is what they could tighten but which Misal cannot
 * require, such as binding the key to an IP address. Gating on advice would train users to click
 * through the dialog, which would then not protect them from the part that matters.
 */
export interface RiskReport {
  readonly blocking: readonly string[]
  readonly advisory: readonly string[]
}

export type ConnectOutcome =
  | { readonly status: 'connected'; readonly scope: ScopeReport; readonly risk: RiskReport }
  | {
      readonly status: 'needs_acknowledgement'
      readonly scope: ScopeReport
      readonly risk: RiskReport
    }

export async function connectAccount(options: ConnectOptions): Promise<ConnectOutcome> {
  const { adapter, vault } = options
  const handle = await vault.stage(options.credential)

  try {
    const http = createGuardedHttp({
      adapterId: adapter.id,
      accountId: options.accountId,
      allowlist: adapter.requestAllowlist,
      hosts: adapter.hosts,
      transport: options.transport,
      limiter: options.limiter,
      userAgent: options.userAgent,
      credentialHandle: handle,
    })

    const probeCtx: AdapterContext = {
      accountId: options.accountId,
      http,
      clock: fixedClockOffset('0'),
      discoveredAssets: [],
      log: () => undefined,
      now: options.now,
    }

    // The clock first: a signed scope probe with a drifted timestamp fails as an auth error, and
    // on CoinDCX the two are indistinguishable from the response alone.
    const clock = new MeasuredClockOffset('0', async () => {
      const localMs = `${BigInt(options.now().getTime())}`
      const serverMs = await adapter.serverTime(probeCtx)
      return { serverMs, localMs }
    })
    await clock.resync()

    const scope = await adapter.describeScope({ ...probeCtx, clock })
    const risk = describeRisk(adapter, scope)

    if (scope.canWithdraw === true) {
      await vault.discard(handle)
      throw new AdapterError(
        'auth_over_scoped',
        'This API key can withdraw funds. Misal will not store it. Create a new key on the ' +
          'exchange with withdrawals disabled, and connect that one instead.',
        { detail: 'enableWithdrawals = true' },
      )
    }

    if (risk.blocking.length > 0 && options.acknowledgedRisk !== true) {
      // Staged, not stored: the handle is discarded and the user re-enters or confirms.
      await vault.discard(handle)
      return { status: 'needs_acknowledgement', scope, risk }
    }

    await vault.commit(handle, options.accountId)
    return { status: 'connected', scope, risk }
  } catch (error) {
    await vault.discard(handle)
    throw error
  }
}

/**
 * What the user must be told before the credential is stored.
 *
 * 'unknown' is stated plainly and never rounded to "safe". For an unscopable exchange the wording
 * names the exposure exactly, because the honest version is the useful one.
 */
export function describeRisk(adapter: ExchangeAdapter, scope: ScopeReport): RiskReport {
  const blocking: string[] = []
  const advisory: string[] = []

  if (scope.verification === 'unscopable') {
    blocking.push(
      `${adapter.displayName} does not offer read-only API keys. This key can place trades. ` +
        'Misal will never do so - it cannot construct a trade request - but anyone who obtains ' +
        'this key can.',
    )
  } else if (scope.canTrade === true) {
    blocking.push(
      'This key can place trades. Misal will never do so, but a key that can trade is worth ' +
        'more to an attacker than one that cannot.',
    )
  } else if (scope.canTrade === 'unknown') {
    blocking.push(
      `${adapter.displayName} does not report what this key is allowed to do, so Misal cannot ` +
        'confirm it is read-only.',
    )
  }

  if (scope.canTransferInternally === true) {
    blocking.push('This key can move funds between wallets inside the exchange.')
  }

  if (scope.ipRestricted === false) {
    advisory.push(
      'This key is not restricted to an IP address. Where the exchange supports it, binding the ' +
        'key to this machine’s address limits what a leaked key is worth.',
    )
  }

  return { blocking, advisory }
}
