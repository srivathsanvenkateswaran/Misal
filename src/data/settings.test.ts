/**
 * The settings boundary.
 *
 * Two things are worth testing here and the rest is plumbing: that a secret travels one way, and
 * that a rejected value comes back with a sentence naming what is wrong with it. "Invalid" sends a
 * user guessing; "contains a comma" does not.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  clearProviderKey,
  describeDateInput,
  describePriceInput,
  describeSettingInput,
  deleteManualPrice,
  loadSettings,
  setManualPrice,
  setProviderKey,
  settingValue,
  writeSetting,
} from './settings'
import type { Invoker, SettingDefinition, SettingsSnapshot } from './settings'
import { dec } from '@domain/numeric'

const TTL: SettingDefinition = {
  key: 'price_cache_ttl_minutes',
  label: 'Price cache lifetime',
  help: '',
  kind: 'integer',
  unit: 'minutes',
  min: 1,
  max: 20_160,
  choices: [],
}

const CURRENCY: SettingDefinition = {
  key: 'base_currency',
  label: 'Base currency',
  help: '',
  kind: 'currency',
  unit: null,
  min: null,
  max: null,
  choices: ['INR', 'USD'],
}

const SNAPSHOT: SettingsSnapshot = {
  settings: [{ key: 'base_currency', value: 'INR', updatedAt: '2026-08-12T00:00:00Z' }],
  definitions: [CURRENCY],
  providers: [],
  overrides: [],
  network: [],
}

describe('the settings commands', () => {
  it('sends a provider key one way and is handed back only a presence flag', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'twelvedata',
      displayName: 'Twelve Data',
      covers: '',
      withoutKey: '',
      status: 'present',
      detail: null,
    }) as unknown as Invoker

    const status = await setProviderKey('twelvedata', 'td-sentinel-8f2c', call)

    // The key is in the request and in nothing else. Serialising the response is the check that
    // matters, because that is the value React will hold.
    expect(JSON.stringify(status)).not.toContain('td-sentinel')
    expect(Object.keys(status)).not.toContain('secret')
    expect(status.status).toBe('present')
  })

  it('names each command and its arguments exactly once', async () => {
    const call = vi.fn().mockResolvedValue(undefined) as unknown as Invoker
    await loadSettings(call)
    await writeSetting('stale_price_days', '5', call)
    await clearProviderKey('twelvedata', call)
    await setManualPrice({ instrumentId: 'i1', asOf: '2026-08-12', close: dec('7412.00') }, call)
    await deleteManualPrice('i1', '2026-08-12', call)

    expect(vi.mocked(call).mock.calls).toEqual([
      ['settings_snapshot'],
      ['settings_write', { key: 'stale_price_days', value: '5' }],
      ['settings_clear_provider_key', { providerId: 'twelvedata' }],
      [
        'settings_set_manual_price',
        { input: { instrumentId: 'i1', asOf: '2026-08-12', close: '7412.00' } },
      ],
      ['settings_delete_manual_price', { instrumentId: 'i1', asOf: '2026-08-12' }],
    ])
  })

  it('reads a stored setting, and reports its absence as absence', () => {
    expect(settingValue(SNAPSHOT, 'base_currency')).toBe('INR')
    expect(settingValue(SNAPSHOT, 'nothing_stored')).toBe('')
  })
})

describe('price input', () => {
  it('accepts a canonical decimal and keeps every digit it was given', () => {
    const result = describePriceInput('  1500.5000 ')
    expect(result.ok).toBe(true)
    // Trailing zeros are significant to the display precision and are not tidied away.
    expect(result.ok && result.value).toBe('1500.5000')
    expect(describePriceInput('0.000000000000000001').ok).toBe(true)
  })

  it('names the problem rather than reporting that one exists', () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ['', /empty/u],
      ['1,250.50', /comma/u],
      ['₹1250', /not a digit/u],
      ['1 250', /not a digit/u],
      ['-5.00', /cannot be negative/u],
      ['1.2.3', /plain decimal/u],
      ['.5', /plain decimal/u],
      ['01', /plain decimal/u],
    ]
    for (const [raw, expected] of cases) {
      const result = describePriceInput(raw)
      expect(result.ok, `${raw} was accepted`).toBe(false)
      expect(result.ok ? '' : result.message).toMatch(expected)
    }
  })

  it('refuses exponent notation, which JavaScript would happily read as a number', () => {
    // `Number('1e3')` is 1000; `dec('1e3')` is not a price. This is the difference the whole
    // numeric design exists to preserve.
    expect(describePriceInput('1e3').ok).toBe(false)
  })
})

describe('date input', () => {
  it('takes a real day and refuses one that does not exist', () => {
    expect(describeDateInput('2026-08-12')).toEqual({ ok: true, value: '2026-08-12' })
    // `new Date` rolls this to 3 March rather than refusing it, so the round trip is the check.
    expect(describeDateInput('2026-02-31').ok).toBe(false)
    expect(describeDateInput('12/08/2026').ok).toBe(false)
    expect(describeDateInput('').ok).toBe(false)
  })
})

describe('setting input', () => {
  it('checks an integer against the bounds the core shipped, not bounds of its own', () => {
    expect(describeSettingInput(TTL, '360')).toEqual({ ok: true, value: '360' })

    const fractional = describeSettingInput(TTL, '6.5')
    expect(fractional.ok ? '' : fractional.message).toMatch(/whole number of minutes/u)

    const tooBig = describeSettingInput(TTL, '99999')
    expect(tooBig.ok ? '' : tooBig.message).toMatch(/between 1 and 20160/u)
  })

  it('normalises a currency rather than refusing a lowercase one', () => {
    expect(describeSettingInput(CURRENCY, ' usd ')).toEqual({ ok: true, value: 'USD' })
    const rejected = describeSettingInput(CURRENCY, 'EUR')
    expect(rejected.ok ? '' : rejected.message).toMatch(/INR, USD/u)
  })
})
