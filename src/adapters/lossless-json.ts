/**
 * A JSON reader that never produces a `number`.
 *
 * `JSON.parse` is unusable here. CoinDCX returns JSON floats for `markets_details` and for every
 * futures endpoint, fractional-millisecond floats for fill timestamps, and its documentation
 * shows a balance of `265.01745775027309`. By the time `JSON.parse` has returned, those digits
 * are gone and no amount of care downstream can recover them.
 *
 * So numbers come back as `{ raw }` holding the literal source text, and the accessors below
 * treat a JSON number and a JSON string identically - which is also what both exchanges require
 * in practice, since each returns some fields as strings in real responses and as numbers in
 * their documented samples, and CoinDCX has changed which is which.
 */

import type { Dec } from '@domain/numeric'
import { decFromRaw } from './decimal-text'
import { AdapterError } from './errors'

/** A JSON number, held as the literal text that appeared in the response. */
export interface RawNumber {
  readonly raw: string
}

export type Json = string | boolean | null | RawNumber | JsonArray | JsonObject
export type JsonArray = readonly Json[]
export interface JsonObject {
  readonly [key: string]: Json
}

export function isRawNumber(value: Json | undefined): value is RawNumber {
  return typeof value === 'object' && value !== null && 'raw' in value
}

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('raw' in value)
}

export function isJsonArray(value: Json | undefined): value is JsonArray {
  return Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Reader {
  private index = 0

  constructor(private readonly text: string) {}

  parse(): Json {
    this.skipWhitespace()
    const value = this.value()
    this.skipWhitespace()
    if (this.index !== this.text.length) {
      this.fail(`trailing content at ${this.index}`)
    }
    return value
  }

  private value(): Json {
    const ch = this.peek()
    switch (ch) {
      case '{':
        return this.object()
      case '[':
        return this.array()
      case '"':
        return this.string()
      case 't':
        return this.literal('true', true)
      case 'f':
        return this.literal('false', false)
      case 'n':
        return this.literal('null', null)
      default:
        return this.number()
    }
  }

  private object(): JsonObject {
    this.expect('{')
    const result: Record<string, Json> = {}
    this.skipWhitespace()
    if (this.peek() === '}') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      const key = this.string()
      this.skipWhitespace()
      this.expect(':')
      this.skipWhitespace()
      result[key] = this.value()
      this.skipWhitespace()
      const next = this.peek()
      this.index += 1
      if (next === '}') return result
      if (next !== ',') this.fail(`expected ',' or '}' at ${this.index - 1}`)
    }
  }

  private array(): JsonArray {
    this.expect('[')
    const result: Json[] = []
    this.skipWhitespace()
    if (this.peek() === ']') {
      this.index += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      result.push(this.value())
      this.skipWhitespace()
      const next = this.peek()
      this.index += 1
      if (next === ']') return result
      if (next !== ',') this.fail(`expected ',' or ']' at ${this.index - 1}`)
    }
  }

  private string(): string {
    this.expect('"')
    let out = ''
    for (;;) {
      const ch = this.peek()
      this.index += 1
      if (ch === '"') return out
      if (ch !== '\\') {
        out += ch
        continue
      }
      const escape = this.peek()
      this.index += 1
      switch (escape) {
        case '"':
        case '\\':
        case '/':
          out += escape
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'u': {
          const hex = this.text.slice(this.index, this.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(`bad \\u escape at ${this.index}`)
          out += String.fromCharCode(Number.parseInt(hex, 16))
          this.index += 4
          break
        }
        default:
          this.fail(`bad escape at ${this.index - 1}`)
      }
    }
  }

  private number(): RawNumber {
    const start = this.index
    if (this.peek() === '-') this.index += 1
    while (/[0-9]/.test(this.peek())) this.index += 1
    if (this.peek() === '.') {
      this.index += 1
      while (/[0-9]/.test(this.peek())) this.index += 1
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.index += 1
      if (this.peek() === '+' || this.peek() === '-') this.index += 1
      while (/[0-9]/.test(this.peek())) this.index += 1
    }
    const raw = this.text.slice(start, this.index)
    if (raw === '' || raw === '-') this.fail(`unexpected character at ${start}`)
    return { raw }
  }

  private literal<T extends Json>(word: string, value: T): T {
    if (this.text.slice(this.index, this.index + word.length) !== word) {
      this.fail(`unexpected character at ${this.index}`)
    }
    this.index += word.length
    return value
  }

  private peek(): string {
    if (this.index >= this.text.length) this.fail('unexpected end of input')
    return this.text[this.index] as string
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected '${ch}' at ${this.index}`)
    this.index += 1
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[ \t\r\n]/.test(this.text[this.index] as string)) {
      this.index += 1
    }
  }

  private fail(reason: string): never {
    throw new AdapterError('malformed_response', 'The exchange returned a response we could not read.', {
      detail: `JSON: ${reason}`,
    })
  }
}

/** Parse response text losslessly. Throws a typed `malformed_response` on bad input. */
export function parseLossless(text: string): Json {
  return new Reader(text).parse()
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function field(value: Json | undefined, key: string): Json | undefined {
  return isJsonObject(value) ? value[key] : undefined
}

export function requireObject(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw malformed(`${what} is not an object`)
  return value
}

export function requireArray(value: Json | undefined, what: string): JsonArray {
  if (!isJsonArray(value)) throw malformed(`${what} is not an array`)
  return value
}

/** A string field. A JSON number is accepted and returned as its literal text. */
export function text(value: Json | undefined, key: string, what: string): string {
  const found = field(value, key)
  if (typeof found === 'string') return found
  if (isRawNumber(found)) return found.raw
  throw malformed(`${what}.${key} is missing or not a string`)
}

export function textOrNull(value: Json | undefined, key: string): string | null {
  const found = field(value, key)
  if (typeof found === 'string') return found
  if (isRawNumber(found)) return found.raw
  return null
}

/**
 * A numeric field, as an exact decimal.
 *
 * Accepts both the string and the number encoding, because both exchanges use both: CoinDCX
 * returns spot balances as strings in real responses and as numbers in its documentation, and
 * its markets catalogue is numbers throughout.
 */
export function decimal(value: Json | undefined, key: string, what: string): Dec {
  const found = field(value, key)
  if (typeof found === 'string' || isRawNumber(found)) {
    const raw = typeof found === 'string' ? found : found.raw
    try {
      return decFromRaw(raw)
    } catch (cause) {
      throw malformed(`${what}.${key} is not a number: ${JSON.stringify(raw)}`, cause)
    }
  }
  throw malformed(`${what}.${key} is missing or not numeric`)
}

export function decimalOrNull(value: Json | undefined, key: string): Dec | null {
  const found = field(value, key)
  if (typeof found === 'string' && found.trim() === '') return null
  if (typeof found !== 'string' && !isRawNumber(found)) return null
  const raw = typeof found === 'string' ? found : found.raw
  try {
    return decFromRaw(raw)
  } catch {
    return null
  }
}

export function boolean(value: Json | undefined, key: string): boolean | undefined {
  const found = field(value, key)
  return typeof found === 'boolean' ? found : undefined
}

function malformed(detail: string, cause?: unknown): AdapterError {
  return new AdapterError(
    'malformed_response',
    'The exchange returned a response we could not read.',
    cause === undefined ? { detail } : { detail, cause },
  )
}
