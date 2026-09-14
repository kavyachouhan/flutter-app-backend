/**
 * Process entry point: bind the port, and shut down cleanly.
 *
 * Graceful shutdown is not ceremony here. A POS client posts an invoice; if
 * the process dies between the HTTP write and the database commit, the device
 * retries and — thanks to client-generated ids and idempotency — gets the
 * right answer. But a deploy that kills in-flight requests mid-transaction
 * leaves locks held until the pooler times them out, which stalls every other
 * writer. Draining properly avoids that entirely.
 *
 * Sequence on SIGTERM:
 *   1. Stop accepting new connections; keep serving in-flight ones.
 *   2. Wait for them to finish, up to a deadline.
 *   3. Close Postgres and Redis.
 *   4. Exit 0. If the deadline passes, exit 1 so the orchestrator knows.
 */
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { closeRedis, connectRedis } from './cache/redis.js';
import { describeError } from './lib/errors.js';

/**
 * Must exceed the load balancer's own de-registration delay, or traffic is
 * still being routed here after we stop accepting it. 15s suits most defaults.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let server: Server | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  // Lazy: a Redis outage must not stop the API booting, since it runs
  // degraded without it. Postgres is verified by /readyz instead of here, so
  // a rolling deploy can start while the database is briefly unreachable.
  await connectRedis();

  const app = createApp();

  server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      {
        port: env.PORT,
        host: env.HOST,
        env: env.APP_ENV,
        nodeEnv: env.NODE_ENV,
        version: env.version,
        docs: env.DOCS_ENABLED ? `${env.PUBLIC_BASE_URL}/docs` : 'disabled',
        authDevBypass: env.AUTH_DEV_BYPASS,
      },
      `khata-api listening on http://${env.HOST}:${env.PORT}`,
    );

    // Impossible in production — env.ts refuses to boot with the bypass on —
    // but worth shouting about in a shared development environment.
    if (env.AUTH_DEV_BYPASS) {
      logger.warn(
        'DEVELOPMENT AUTH BYPASS IS ACTIVE. POST /v1/auth/dev-login mints tokens with no ' +
          'credential check, and a fixed OTP is accepted. Never expose this instance publicly.',
      );
    }
  });

  // Node's default of 5s is shorter than many load balancers' idle timeout,
  // which produces sporadic 502s when the LB reuses a connection the server
  // has just closed. Keep ours comfortably longer than the LB's.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.fatal(`Port ${env.PORT} is already in use. Is another instance running?`);
    } else {
      logger.fatal({ err: error }, 'HTTP server error');
    }
    process.exit(1);
  });
}

async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C should not race the first shutdown through the same steps.
  if (shuttingDown) {
    logger.warn(`Received ${signal} during shutdown — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;

  logger.info(`${signal} received — draining connections`);

  const forceExit = setTimeout(() => {
    logger.error(
      `Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms with requests still in flight — forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not let this timer keep an otherwise-idle event loop alive.
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      logger.info('HTTP server closed to new connections');
    }

    // Dependencies close only after the last request has finished with them.
    await Promise.allSettled([closePool(), closeRedis()]);

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

// SIGTERM: orchestrators. SIGINT: Ctrl-C.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An uncaught exception leaves the process in an unknown state — a half-applied
 * transaction, a corrupted module-level cache. The only safe response is to log
 * it and let the orchestrator start a clean instance. Continuing is how a
 * single bug turns into inconsistent data.
 */
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception — exiting');
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, `Unhandled promise rejection — exiting: ${describeError(reason)}`);
  void shutdown('unhandledRejection');
});

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  process.exit(1);
});
