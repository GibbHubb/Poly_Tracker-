// PT36 — test runner config, kept apart from vite.config.ts so the build
// (PWA plugin, chunking) and the tests do not have to agree on anything.
// Each test file still picks its own environment with `@vitest-environment`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/hooks/**/*.ts'],
      exclude: ['**/*.test.*'],
      reporter: ['text-summary', 'text'],
      // A FLOOR, set to what the suite achieved on 2026-10-02 (rounded down).
      // It may only go up: raise it when coverage rises, never lower it to pass.
      // Measured 52.04 / 85.28 / 62.13 / 52.04 (PT36); raised to 57.89 / 85.37 /
      // 67.22 / 57.89 by PT41's circle-mode tests. The low line figure is honest:
      // mapStyle, exportPdf, circleMode, tileCache and downscale need WebGL, a
      // canvas or Cache Storage and are verified in a browser, not here.
      thresholds: {
        lines: 57,
        statements: 57,
        branches: 85,
        functions: 67,
      },
    },
  },
});
