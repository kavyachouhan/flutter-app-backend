/**
 * Per-test-file environment setup. Runs before any module under test is
 * imported, which matters because `src/config/env.ts` validates and freezes
 * configuration at import time — anything set after that import is ignored.
 *
 * Tests always run with APP_ENV=development so the dev-only routes exist and
 * can be asserted on. The one suite that needs a production configuration
 * builds it explicitly and checks that boot is refused; it never mutates the
 * real process environment.
 */

process.env['APP_ENV'] = 'development';
process.env['NODE_ENV'] = 'test';

// A distinct database from `npm run dev`, so running the suite never wipes
// the data a developer is working with.
// Port 5433 matches docker-compose, which avoids 5432 so it cannot collide
// with a PostgreSQL installed directly on the host.
process.env['DATABASE_URL'] ??= 'postgresql://khata:khata@localhost:5433/khata_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';

// Long enough to satisfy the 32-character minimum, obviously fake.
process.env['JWT_SECRET'] ??= 'test-only-secret-value-at-least-32-characters';

// Exercise the development auth path, which is what the integration tests use
// to obtain tokens without standing up an SMS provider.
process.env['AUTH_DEV_BYPASS'] ??= 'true';
process.env['AUTH_DEV_FIXED_OTP'] ??= '000000';
process.env['SMS_PROVIDER'] ??= 'console';

// Quiet by default: a passing suite should print test results, not request
// logs. Set LOG_LEVEL=debug in the shell when diagnosing a failure.
process.env['LOG_LEVEL'] ??= 'silent';
process.env['LOG_PRETTY'] = 'false';
process.env['METRICS_ENABLED'] ??= 'false';
