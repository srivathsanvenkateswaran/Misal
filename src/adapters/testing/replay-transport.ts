/**
 * Fixture replay: the only transport a test can construct.
 *
 * Each interaction is a pair of files under tests/fixtures/adapters/<exchange>/ - a `.meta.json`
 * describing the request it answers and the response's status and headers, and a `.body.txt`
 * holding the response body as raw bytes.
 *
 * The body is a separate text file on purpose. Embedding it as a JSON string would mean escaping
 * it, and the whole point of several of these fixtures is a numeric literal that must survive
 * verbatim - `265.01745775027309`, `1718386312255.3608`, `1e-05`. A round trip through a JSON
 * string is one more place those could quietly change.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardedResponse } from '../contract'
import type { Transport, TransportRequest } from '../http'

export interface FixtureMeta {
  /** Matched against the request. */
  readonly method: 'GET' | 'POST'
  readonly path: string
  /** Substring the query string must contain, when the same path is fetched more than once. */
  readonly query?: string
  /** Substring the body must contain. */
  readonly body?: string
  /** May answer any number of matching requests. Used for clocks and market catalogues. */
  readonly repeatable?: boolean
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
}

export interface Fixture extends FixtureMeta {
  readonly name: string
  readonly responseBody: string
}

export function loadFixtures(exchange: string, root = defaultRoot()): readonly Fixture[] {
  const dir = join(root, exchange)
  return readdirSync(dir)
    .filter((file) => file.endsWith('.meta.json'))
    .sort()
    .map((file) => {
      const name = file.replace(/\.meta\.json$/, '')
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as FixtureMeta
      return { ...meta, name, responseBody: readBody(dir, name) }
    })
}

function readBody(dir: string, name: string): string {
  try {
    return readFileSync(join(dir, `${name}.body.txt`), 'utf8')
  } catch {
    // A fixture with no body file answers with an empty body, which is what a 418 does.
    return ''
  }
}

function defaultRoot(): string {
  return join(process.cwd(), 'tests', 'fixtures', 'adapters')
}

export interface ReplayTransport extends Transport {
  /** Every request that reached the transport, in order. Asserted on by the signing tests. */
  readonly sent: readonly TransportRequest[]
  /** Fixtures never matched by a request. A non-empty list usually means a test drifted. */
  unused(): readonly string[]
}

export interface ReplayOptions {
  /** Only these fixture names take part, in this order of preference. Defaults to all. */
  readonly only?: readonly string[]
}

export function createReplayTransport(
  fixtures: readonly Fixture[],
  options: ReplayOptions = {},
): ReplayTransport {
  const pool =
    options.only === undefined
      ? [...fixtures]
      : options.only.map((name) => {
          const found = fixtures.find((f) => f.name === name)
          if (found === undefined) throw new Error(`No such fixture: ${name}`)
          return found
        })

  // Consumption is tracked by position, not by identity: naming the same fixture twice in
  // `only` is how a test says "this response arrives twice", which the clock-skew retry needs.
  const consumed = new Set<number>()
  const sent: TransportRequest[] = []

  return {
    sent,
    unused: () => pool.filter((_, i) => !consumed.has(i)).map((f) => f.name),

    send(request: TransportRequest): Promise<GuardedResponse> {
      sent.push(request)
      const at = pool.findIndex((f, i) => !consumed.has(i) && matches(f, request))
      const match =
        at >= 0 ? pool[at] : pool.find((f) => f.repeatable === true && matches(f, request))
      if (at >= 0) consumed.add(at)

      if (match === undefined) {
        throw new Error(
          `No fixture for ${request.method} ${request.path}` +
            `${request.query === '' ? '' : `?${request.query}`}` +
            `${request.body === null ? '' : ` body=${request.body}`}. ` +
            `Available: ${pool.map((f) => f.name).join(', ')}`,
        )
      }

      return Promise.resolve({
        status: match.status,
        headers: match.headers ?? { 'content-type': 'application/json' },
        text: match.responseBody,
      })
    },
  }
}

function matches(fixture: Fixture, request: TransportRequest): boolean {
  if (fixture.method !== request.method || fixture.path !== request.path) return false
  if (fixture.query !== undefined && !request.query.includes(fixture.query)) return false
  if (fixture.body !== undefined && !(request.body ?? '').includes(fixture.body)) return false
  return true
}
