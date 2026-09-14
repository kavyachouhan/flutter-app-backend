import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live beside the code they test (src/**/*.test.ts); integration
    // tests that need a real Postgres live in tests/.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],

    // Integration tests share one database, so test files must not run
    // concurrently. Unit tests are pure and would be safe in parallel, but a
    // single serial run keeps the setup honest and the suite is fast enough.
    fileParallelism: false,

    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/setup-env.ts'],

    testTimeout: 20_000,
    hookTimeout: 60_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/db/migrations/**', 'src/openapi/**'],
    },
  },
});
