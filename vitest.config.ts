import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests need a real database and are run by
    // vitest.integration.config.ts. Without this they match the glob above,
    // and importing their harness replaces DATABASE_URL with the live test
    // database — so `npm test` would silently connect to it and truncate it.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    setupFiles: ['tests/setup/setup-env.ts'],
  },
});
