/**
 * The startup screen.
 *
 * Deliberately not re-exported from `src/screens/index.ts`: this is the one screen that renders
 * *before* the store is open, and it must not be able to reach anything that assumes one.
 */

export { StartupGate } from './StartupGate'
export { StartupScreen } from './StartupScreen'
