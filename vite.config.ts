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
