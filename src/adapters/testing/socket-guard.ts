/**
 * The socket guard.
 *
 * No test may open a network socket. Not "should not" - cannot: this replaces every API a test
 * could reach the network through, so an adapter that quietly starts making a live call fails
 * loudly instead of hitting a real exchange with someone's real key.
 *
 * Installed globally from tests/setup.ts rather than per suite, because the failure it prevents
 * is precisely the one a future contributor would not think to guard against.
 */

export class NetworkAccessInTestError extends Error {
  override readonly name = 'NetworkAccessInTestError'

  constructor(what: string) {
    super(
      `Test attempted network access via ${what}. Adapters must be driven by recorded fixtures; ` +
        'see src/adapters/testing/replay-transport.ts.',
    )
  }
}

export function installSocketGuard(): void {
  // Assigning over built-in globals needs the loose view; the point is to replace them wholesale.
  const scope = globalThis as unknown as Record<string, unknown>

  scope['fetch'] = () => {
    throw new NetworkAccessInTestError('fetch()')
  }

  const blocked = (what: string): new () => unknown =>
    class {
      constructor() {
        throw new NetworkAccessInTestError(what)
      }
    }

  scope['XMLHttpRequest'] = blocked('XMLHttpRequest')
  scope['WebSocket'] = blocked('WebSocket')
  scope['EventSource'] = blocked('EventSource')
}

/**
 * The same guard one level lower, for a future adapter that reaches for node:https directly.
 *
 * Blocking the DNS lookup catches an outbound connection to a hostname without touching the
 * loopback sockets the test runner itself may use.
 */
export async function installDnsGuard(): Promise<void> {
  try {
    const dns = (await import('node:dns')) as unknown as {
      lookup: unknown
      promises: { lookup: unknown }
    }
    const refuse = (): never => {
      throw new NetworkAccessInTestError('a DNS lookup')
    }
    dns.lookup = refuse
    dns.promises.lookup = refuse
  } catch {
    // Not running under Node. The browser-level guards above are then the whole story.
  }
}
