// Imported from vitest/config rather than vite so the `test` block below is type-checked.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Tauri expects a fixed port and its own target/env handling.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      '@domain': resolvePath('./src/domain'),
      '@ingestion': resolvePath('./src/ingestion'),
      '@adapters': resolvePath('./src/adapters'),
      '@valuation': resolvePath('./src/valuation'),
      '@ui': resolvePath('./src/ui'),
    },
  },
  test: {
    globals: true,
    /**
     * Thirty seconds, against Vitest's default of five.
     *
     * These are not slow tests in the sense of being badly written. Screen and view-model
     * fixtures are `PortfolioRows`, so every one of them drives the mapping boundary, the fold,
     * the FIFO engine and the coverage report for real rather than asserting against a pre-baked
     * view-model - which is exactly why they catch what they catch. The XIRR property test runs
     * 1,600 exact-decimal NPV evaluations for the same reason.
     *
     * At the default they pass on an idle machine and fail on a busy one. That is the worst
     * possible outcome: a suite that is green locally, red in CI under contention, and teaches
     * everyone to re-run rather than to look. The honest options were to make the tests shallower
     * or to admit they take real time; making them shallower would discard their entire value.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * UTC, deliberately, and specifically *not* IST.
     *
     * This engine dates everything in Asia/Kolkata on purpose, so almost every author of this
     * codebase runs the suite in the one zone where forgetting to say so still passes. That is how
     * `ttlGate` shipped two bare `DateTime.fromISO` calls: correct instant, system-zone rendering,
     * green on every Indian machine and red on every CI runner - which is why CI had never passed.
     *
     * Running the tests in a zone the product does not use means a date that depends on the
     * machine's zone fails here, at the point it is written, rather than in a runner nobody reads.
     * Tests that assert Indian output still assert Indian output; they just have to get it from
     * code that says so.
     */
    env: { TZ: 'UTC' },
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.*', 'src/ui/**/*.stories.*'],
    },
  },
})
