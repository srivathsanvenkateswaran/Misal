/**
 * Opening the store, from the frontend.
 *
 * The database is *not* opened during Tauri's `setup`. Reading its encryption key out of the OS
 * keychain can raise a system authorization prompt on macOS and can block on a keyring daemon on
 * Linux, and `setup` runs before any window exists — so that failure had nowhere to be shown. The
 * window renders first and calls `openStore`, which is why every outcome below has a screen.
 *
 * The outcomes are a tagged union rather than a thrown error on purpose. "keychain unavailable:
 * Platform secure storage failure" is a string; *which situation the user is in* is a decision,
 * and it is made in Rust (`db::StartupOutcome`) where the platform error still exists. The
 * `status` strings here are pinned by a Rust test.
 */

import { invoke } from '@tauri-apps/api/core'

export type StartupOutcome =
  /** Open and migrated. Every other command can now be served. */
  | { readonly status: 'ready' }
  /** The keychain was reached and refused. There is something to approve. */
  | { readonly status: 'keychain-denied'; readonly detail: string }
  /** Nothing answered — typically no keyring daemon. There is nothing to approve. */
  | { readonly status: 'keychain-unavailable'; readonly detail: string }
  /** A database exists and the key we hold does not open it. Nothing was changed. */
  | { readonly status: 'wrong-key' }
  /** The stored key is not a key, and will not be replaced by one. */
  | { readonly status: 'malformed-key' }
  /** Anything else: a filesystem failure, a migration that would not apply. */
  | { readonly status: 'failed'; readonly detail: string }

/** Every outcome that is not the store being open. */
export type StartupBlocked = Exclude<StartupOutcome, { status: 'ready' }>

/**
 * Ask the Rust core to open the encrypted store.
 *
 * `passphrase` is the fallback for a machine with no keychain (the Linux caveat in the core-schema
 * spec). It is passed straight through to the command and is never stored, logged, or kept in
 * React state — see `StartupScreen`, which reads it from the DOM node and clears it.
 */
export async function openStore(passphrase?: string): Promise<StartupOutcome> {
  // Sent explicitly as null rather than omitted, so the command's `Option<String>` is decided by
  // a value that is actually on the wire rather than by how a missing field is treated.
  return invoke<StartupOutcome>('startup_open_store', { passphrase: passphrase ?? null })
}
