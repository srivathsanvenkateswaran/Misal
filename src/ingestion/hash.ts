/**
 * SHA-256, over the Web Crypto API where there is one and Node's otherwise.
 *
 * Two things are hashed in this subsystem and both are load-bearing for idempotency: the raw
 * bytes of a source document, and the natural key of a transaction. Neither ever includes a
 * password or any part of one.
 */

const HEX = '0123456789abcdef'

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Typed as possibly absent because it genuinely is: a hardened webview, an old jsdom and a
  // non-secure context all lack it, and the Node fallback below is what keeps tests honest.
  const webCrypto = globalThis.crypto as Crypto | undefined
  const subtle = webCrypto?.subtle
  if (subtle !== undefined) {
    // `bytes.buffer` may be a shared or oversized ArrayBuffer, so the view is copied first.
    const copy = new Uint8Array(bytes)
    return toHex(new Uint8Array(await subtle.digest('SHA-256', copy.buffer)))
  }
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(utf8(text))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += HEX[byte >> 4]
    out += HEX[byte & 0x0f]
  }
  return out
}
