import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The bin entry is a two-line process wrapper around buildProgram();
      // everything testable lives in cli/program.ts and is covered e2e.
      exclude: ['src/cli/index.ts'],
      // Listing bar: "90%+ test coverage via automated network drop and
      // latency simulations". Thresholds make the bar enforceable in CI.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
