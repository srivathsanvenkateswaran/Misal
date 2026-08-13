/**
 * The last gate between a failure and the screen.
 *
 * The key and the secret are read from an uncontrolled input at submit, handed to the connect
 * flow, and never put into React state — so there is no render tree, devtools snapshot or error
 * boundary payload that could carry them. That covers everything Misal itself writes.
 *
 * It does not cover what an exchange writes. An error message on this path is assembled from an
 * `AdapterError`, whose text and `detail` can quote a response body; a WAF challenge page, a
 * misconfigured proxy or a future adapter that interpolates its request into a diagnostic could all
 * put the key back into a string that is about to be rendered inside an `alert`. Substring-matching
 * the values that were just submitted is a cheap, exact check, and it turns "no secret reaches an
 * error message" from a property of every call site into a property of the one function that builds
 * the message.
 *
 * Only values long enough to be a credential are matched. A short secret is not made safer by
 * blanking every innocent occurrence of a five-character string in the sentence around it.
 */

const MIN_MATCHABLE = 8

export const REDACTED = '[redacted]'

/**
 * Replace every occurrence of the submitted credential with `[redacted]`.
 *
 * Literal replacement, not a regular expression: an API key can contain characters a pattern would
 * treat as syntax, and a credential that fails to escape cleanly is exactly the one that would slip
 * through.
 */
export function redactCredential(message: string, values: readonly string[]): string {
  let text = message
  for (const value of values) {
    if (value.length < MIN_MATCHABLE) continue
    text = text.split(value).join(REDACTED)
  }
  return text
}

/** An error, described for a user, with anything that looks like the submitted key removed. */
export function describeSafely(error: unknown, values: readonly string[]): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'The exchange could not be reached, and gave no reason.'
  return redactCredential(raw, values)
}
