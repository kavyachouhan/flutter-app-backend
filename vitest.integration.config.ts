import { defineConfig } from 'vitest/config';

/**
 * Integration tests, kept out of the default `npm test` run: they need a real
 * database and take seconds rather than milliseconds.
 *
 * Files run one at a time. Every write in a tenant serialises on that tenant's
 * server_seq counter anyway, and the suite truncates shared tables, so parallel
 * files would contend for the same rows and produce failures that say nothing
 * about the code.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup/env.ts'],
    globalSetup: ['tests/integration/setup/global-setup.ts'],
    fileParallelism: false,
    // Real network round trips to Supabase, not local sockets.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
