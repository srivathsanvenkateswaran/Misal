/**
 * Screen 06 — Settings.
 *
 * `Settings` is the whole screen and needs nothing but a mount point: it loads its own snapshot,
 * its own account list and its own review queue, owns its own writes, and reports each one where it
 * happened. `runtime` exists so a test can stand in for the IPC boundary; `onChanged` is how the
 * shell learns that a stored figure moved — which now includes an account having been deleted.
 */

export {
  Settings,
  type AccountSummary,
  type InstrumentOption,
  type SettingsProps,
  type SettingsRuntime,
} from './Settings'
export {
  EMPTY_SUMMARY,
  STATE_LABEL,
  STATE_MEANING,
  STATE_ORDER,
  entriesInState,
  entryWithheld,
  formatWithheld,
  identifierLabel,
  identifierValue,
  summariseWithheld,
  withheldCaveat,
  type WithheldSummary,
  type WithheldTotal,
} from './review'
