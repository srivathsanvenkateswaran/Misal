/**
 * Screen 06 — Settings.
 *
 * `Settings` is the whole screen and needs nothing but a mount point: it loads its own snapshot,
 * owns its own writes, and reports each one where it happened. `runtime` exists so a test can stand
 * in for the IPC boundary; `onChanged` is how the shell learns that a stored figure moved.
 */

export { Settings, type InstrumentOption, type SettingsProps, type SettingsRuntime } from './Settings'
