/**
 * The disclosures, checked against the adapters they describe.
 *
 * The point of these is drift. Copy written about an exchange goes stale the moment the adapter
 * changes and nothing complains; so everything the adapter already knows is read from it, and these
 * tests assert that it still is rather than that it once was.
 */

import { describe, expect, it } from 'vitest'
import { ADAPTER_IDS, createAdapter } from '@adapters/index'
import { CONVERT_BLIND_SPOT, providerDisclosure } from './disclosure'
import { REDACTED, describeSafely, redactCredential } from './redact'

describe('provider disclosures', () => {
  it('reads every fact it could read from the adapter rather than restating it', () => {
    for (const providerId of ADAPTER_IDS) {
      const { adapter } = createAdapter(providerId)
      const disclosure = providerDisclosure(providerId)
      expect(disclosure.displayName).toBe(adapter.displayName)
      expect(disclosure.baseCurrency).toBe(adapter.baseCurrency)
      expect(disclosure.capability).toBe(adapter.capability)
      expect(disclosure.coverageGaps).toEqual(adapter.coverageGaps)
      expect(disclosure.credentialFields).toEqual(adapter.credentialFields)
    }
  })

  it('requires an acknowledgement for the exchange that cannot be asked, and not for the one that can', () => {
    expect(providerDisclosure('coindcx').acknowledgementRequired).toBe(true)
    expect(providerDisclosure('binance').acknowledgementRequired).toBe(false)
  })

  it('does not describe the two exchanges identically', () => {
    const coindcx = providerDisclosure('coindcx')
    const binance = providerDisclosure('binance')
    expect(coindcx.headline).not.toBe(binance.headline)
    expect(coindcx.body).not.toEqual(binance.body)
    // The tone is the visual half of the same statement: one can be verified, the other cannot.
    expect(coindcx.tone).toBe('crit')
    expect(binance.tone).toBe('warn')
  })

  it('states the CoinDCX exposure without softening it into reassurance', () => {
    const body = providerDisclosure('coindcx').body.join(' ')
    expect(body).toMatch(/trades and move funds/u)
    expect(body).toMatch(/no endpoint that reports what a key is permitted to do/u)
    expect(body).toMatch(/only thing standing between this key and your money/u)
    // And it offers the way out that needs no key at all.
    expect(body).toMatch(/CSV export/u)
  })

  it('keeps the Convert note attached to the consequence it has for cost basis', () => {
    expect(CONVERT_BLIND_SPOT.body).toMatch(/cost basis is not approximate, it is absent/u)
    // The adapter states the mechanism; the screen states what it costs the reader.
    expect(providerDisclosure('binance').coverageGaps.join(' ')).toMatch(/Binance Convert/u)
  })
})

describe('redaction', () => {
  it('removes a submitted credential from a message that quoted it', () => {
    const secret = 'abcdefgh12345678'
    expect(redactCredential(`signed with ${secret} and refused`, [secret])).toBe(
      `signed with ${REDACTED} and refused`,
    )
  })

  it('leaves a value too short to be a credential alone', () => {
    // Blanking every innocent occurrence of a five-character string makes the sentence useless
    // without making the secret safer; a secret that short is not protected by hiding it here.
    expect(redactCredential('the key abc is bad', ['abc'])).toBe('the key abc is bad')
  })

  it('matches literally, so a key containing regular-expression syntax is still removed', () => {
    const secret = 'a+b*c(d)e[f]12345'
    expect(redactCredential(`refused: ${secret}`, [secret])).toBe(`refused: ${REDACTED}`)
  })

  it('describes a non-error without inventing a reason', () => {
    expect(describeSafely({ weird: true }, [])).toMatch(/gave no reason/u)
    expect(describeSafely('plain string failure', [])).toBe('plain string failure')
  })
})
