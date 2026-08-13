import '@testing-library/jest-dom/vitest'
import { installDnsGuard, installSocketGuard } from '../src/adapters/testing/socket-guard'

// No test may open a network socket, and this is where that stops being an intention. Adapters
// are driven by recorded fixtures; anything reaching for the network - now or in a future
// adapter someone adds - fails loudly instead of hitting a real exchange with a real key.
installSocketGuard()
await installDnsGuard()
import { configure } from '@testing-library/react'

/**
 * Testing Library's own async timeout, which is separate from Vitest's.
 *
 * `findBy*` waits 1000ms by default. Raising Vitest's `testTimeout` to 30s did nothing for it, so
 * a screen test on a loaded machine still failed with "unable to find an element" - a message that
 * reads like a missing element rather than a slow one, which is the misleading part. These tests
 * render through the real mapping boundary, fold and coverage report, so a second is not
 * generous.
 */
configure({ asyncUtilTimeout: 10_000 })
