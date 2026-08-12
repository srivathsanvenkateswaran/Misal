/**
 * Building the exact bytes of a request, and hashing what was asked for.
 *
 * Neither exchange canonicalises what it signs. Binance re-reads the literal query string the
 * client sent; CoinDCX HMACs the literal request body. So the serialisation has to happen exactly
 * once, here, and the resulting string has to survive untouched all the way to the socket. That
 * is why these functions return strings rather than objects: an object handed to an HTTP client
 * gets re-encoded, the bytes shift, and the signature is permanently wrong. It is the failure
 * that breaks most CoinDCX clients in the wild, and it is invisible to any test that checks the
 * signing function in isolation.
 */

import type { ProviderId, SourceDocumentDescriptor } from './contract'

/** A body value, in the JSON encoding the exchange expects. */
export type BodyValue =
  /** Emitted as a JSON number, verbatim. The caller has already validated the digits. */
  | { readonly int: string }
  /** Emitted as a JSON string. */
  | { readonly text: string }
  | { readonly bool: boolean }

/**
 * Serialise a JSON body with the caller's key order preserved.
 *
 * Key order is part of the signed bytes, so it is the caller's decision, not the serialiser's.
 */
export function jsonBody(fields: readonly (readonly [string, BodyValue])[]): string {
  const parts = fields.map(([key, value]) => `${JSON.stringify(key)}:${encode(value)}`)
  return `{${parts.join(',')}}`
}

function encode(value: BodyValue): string {
  if ('int' in value) {
    if (!/^-?\d+$/.test(value.int)) {
      throw new Error(`Not an integer literal: ${JSON.stringify(value.int)}`)
    }
    return value.int
  }
  if ('text' in value) return JSON.stringify(value.text)
  return value.bool ? 'true' : 'false'
}

/** Serialise a query string, order preserved, percent-encoded once. */
export function queryString(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

/**
 * The canonical request envelope a source document's `content_hash` is taken over.
 *
 * The hash is of the request, not of the response body, and two consequences follow from that,
 * both intended:
 *
 *   Snapshot fetches include `asOfDate`, so re-syncing balances on the same day is a genuine
 *   no-op via the UNIQUE constraint on content_hash, while tomorrow's sync produces a new
 *   document and a new position row. Without it an unchanged balance set would hash identically
 *   forever and could never record a second day.
 *
 *   Trade pages include the cursor, so each page is a distinct document and a re-fetched page is
 *   a no-op.
 */
export interface RequestEnvelope {
  readonly providerId: ProviderId
  readonly accountId: string
  readonly endpoint: string
  readonly params: Readonly<Record<string, string>>
  readonly asOfDate?: string
  readonly body?: string
}

export async function contentHash(envelope: RequestEnvelope): Promise<string> {
  const canonical = JSON.stringify({
    providerId: envelope.providerId,
    accountId: envelope.accountId,
    endpoint: envelope.endpoint,
    params: envelope.params,
    ...(envelope.asOfDate === undefined ? {} : { asOfDate: envelope.asOfDate }),
    ...(envelope.body === undefined ? {} : { body: envelope.body }),
  })
  return sha256Hex(canonical)
}

export async function describeDocument(
  envelope: RequestEnvelope,
  pageRef: string,
  period?: { start?: string; end?: string },
): Promise<SourceDocumentDescriptor> {
  return {
    providerId: envelope.providerId,
    accountId: envelope.accountId,
    kind: 'api-response',
    contentHash: await contentHash(envelope),
    pageRef,
    ...(period?.start === undefined ? {} : { periodStart: period.start }),
    ...(period?.end === undefined ? {} : { periodEnd: period.end }),
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
