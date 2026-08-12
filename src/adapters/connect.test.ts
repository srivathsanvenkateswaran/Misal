import { describe, expect, it } from 'vitest'
import { createBinanceAdapter } from './binance/adapter'
import { createCoindcxAdapter } from './coindcx/adapter'
import { connectAccount } from './connect'
import { RateLimiter } from './ratelimit'
import { ManualClock } from './testing/harness'
import { MemoryVault } from './testing/memory-store'
import { createReplayTransport, loadFixtures } from './testing/replay-transport'

const CREDENTIAL = { apiKey: 'test-key-not-a-real-key', apiSecret: 'test-secret-not-a-real-secret' }
const NOW = new Date('2026-08-12T10:00:00.000Z')

function setup(exchange: 'binance' | 'coindcx', fixtures: readonly string[]) {
  const adapter = exchange === 'binance' ? createBinanceAdapter() : createCoindcxAdapter()
  const transport = createReplayTransport(loadFixtures(exchange), { only: [...fixtures] })
  const vault = new MemoryVault()
  return {
    adapter,
    vault,
    transport,
    options: {
      adapter,
      accountId: 'account-1',
      credential: CREDENTIAL,
      vault,
      transport,
      limiter: new RateLimiter({ budgetPerMinute: 6000, maxPerSecond: 100, clock: new ManualClock() }),
      userAgent: 'Misal/0.1 (test)',
      now: () => NOW,
    },
  }
}

describe('a key that can withdraw', () => {
  it('is refused, and nothing reaches the keychain', async () => {
    const { vault, options } = setup('binance', ['time', 'api-restrictions-withdrawals'])

    await expect(connectAccount(options)).rejects.toMatchObject({ code: 'auth_over_scoped' })

    // Asserted by looking, not by trusting the return value. "Nothing was written" is only a
    // check if something checks.
    expect(await vault.hasStoredCredential('account-1')).toBe(false)
    expect(vault.stored.size).toBe(0)
    expect(vault.staged.size).toBe(0)
  })

  it('cannot be overridden by acknowledging the risk', async () => {
    const { vault, options } = setup('binance', ['time', 'api-restrictions-withdrawals'])
    await expect(connectAccount({ ...options, acknowledgedRisk: true })).rejects.toMatchObject({
      code: 'auth_over_scoped',
    })
    expect(await vault.hasStoredCredential('account-1')).toBe(false)
  })
})

describe('a key that can trade', () => {
  it('is stored only after an explicit acknowledgement', async () => {
    const first = setup('binance', ['time', 'api-restrictions-trading'])
    const pending = await connectAccount(first.options)

    expect(pending.status).toBe('needs_acknowledgement')
    expect(pending.risk.blocking.join(' ')).toMatch(/place trades/)
    expect(await first.vault.hasStoredCredential('account-1')).toBe(false)

    const second = setup('binance', ['time', 'api-restrictions-trading'])
    const done = await connectAccount({ ...second.options, acknowledgedRisk: true })
    expect(done.status).toBe('connected')
    expect(await second.vault.hasStoredCredential('account-1')).toBe(true)
  })
})

describe('a read-only key', () => {
  it('is stored, even though the ACCOUNT reports that it can withdraw', async () => {
    // The scope-confusion guard. Reading /api/v3/account's canWithdraw would reject every valid
    // key on a healthy account.
    const { vault, options, transport } = setup('binance', [
      'time',
      'api-restrictions-read-only',
      'account-can-withdraw',
    ])
    const outcome = await connectAccount(options)

    expect(outcome.status).toBe('connected')
    expect(await vault.hasStoredCredential('account-1')).toBe(true)
    expect(transport.sent.map((r) => r.path)).not.toContain('/api/v3/account')
  })

  it('still warns when the key is not bound to an IP address', async () => {
    const { options } = setup('binance', ['time', 'api-restrictions-read-only'])
    const outcome = await connectAccount(options)
    expect(outcome.risk.advisory.join(' ')).toMatch(/not restricted to an IP address/)
  })
})

describe('an exchange with no permission model', () => {
  it('states the exposure in those words and requires acknowledgement', async () => {
    const { options, vault } = setup('coindcx', ['markets-details'])
    const pending = await connectAccount(options)

    expect(pending.status).toBe('needs_acknowledgement')
    expect(pending.scope.verification).toBe('unscopable')
    expect(pending.risk.blocking.join(' ')).toMatch(
      /does not offer read-only API keys.*can place trades.*Misal will never do so/s,
    )
    expect(await vault.hasStoredCredential('account-1')).toBe(false)
  })

  it('stores the credential once the user has accepted that', async () => {
    const { options, vault } = setup('coindcx', ['markets-details'])
    const done = await connectAccount({ ...options, acknowledgedRisk: true })
    expect(done.status).toBe('connected')
    expect(await vault.hasStoredCredential('account-1')).toBe(true)
  })
})

describe('a failed probe', () => {
  it('leaves nothing staged and nothing stored', async () => {
    const { options, vault } = setup('binance', ['time', 'clock-skew', 'time', 'clock-skew'])
    await expect(connectAccount(options)).rejects.toThrow()
    expect(vault.staged.size).toBe(0)
    expect(await vault.hasStoredCredential('account-1')).toBe(false)
  })
})
