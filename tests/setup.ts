import '@testing-library/jest-dom/vitest'
import { installDnsGuard, installSocketGuard } from '../src/adapters/testing/socket-guard'

// No test may open a network socket, and this is where that stops being an intention. Adapters
// are driven by recorded fixtures; anything reaching for the network - now or in a future
// adapter someone adds - fails loudly instead of hitting a real exchange with a real key.
installSocketGuard()
await installDnsGuard()
