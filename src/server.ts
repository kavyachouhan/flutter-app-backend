import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool } from './db/pool.js';
import { closeRedis, connectRedis } from './cache/redis.js';

let server: Server | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  // Postgres is checked by /readyz rather than here, so a rolling deploy can
  // start while the database is briefly unreachable.
  await connectRedis();

  server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info(
      { host: env.HOST, port: env.PORT, env: env.APP_ENV, version: env.version },
      `${env.SERVICE_NAME} listening`,
    );
    if (env.AUTH_DEV_BYPASS) {
      logger.warn('Development auth bypass is active. Never expose this instance publicly.');
    }
  });

  // Must outlive the load balancer's idle timeout, otherwise it reuses a
  // socket Node has just closed and the client sees a sporadic 502.
  server.keepAliveTimeout = env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = env.HTTP_HEADERS_TIMEOUT_MS;

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server error');
    process.exit(1);
  });
}

/**
 * Stops accepting connections, lets in-flight requests finish, then closes
 * the pools. Closing the pool first would abort transactions that still hold
 * row locks, stalling other writers until the pooler times them out.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  logger.info(`${signal} received, draining`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out with requests in flight');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.allSettled([closePool(), closeRedis()]);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// State after an uncaught exception is unknown; continuing risks writing
// inconsistent data, so exit and let the orchestrator start a clean instance.
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  void shutdown('unhandledRejection');
});

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start');
  process.exit(1);
});
