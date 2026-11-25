import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests for pure modules (no Electron, no models). Anything that needs the app running
// belongs in the UI smoke test instead (src/main/tasks/smoke.ts).
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs']
  }
})
