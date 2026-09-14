/**
 * Structured logging.
 *
 * JSON in production so a log aggregator can index it; pretty-printed in
 * development so a human can read it. Request correlation fields are injected
 * automatically from the AsyncLocalStorage context, so call sites never pass
 * `requestId` by hand.
 *
 * The redaction list is the important part of this file. This service handles
 * OTPs, JWTs and customer phone numbers; any of those in a log line is a data
 * incident, and redaction that is opt-in gets forgotten. Add to `REDACT_PATHS`
 * whenever a new sensitive field appears.
 */
import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';
import { contextForLogging } from './context.js';

/**
 * Field paths pino replaces with `[Redacted]`. Wildcards cover the common
 * nestings (`req.body.otp`, `*.password`, …) without enumerating every route.
 */
const REDACT_PATHS = [
  // Credentials and tokens
  'password',
  '*.password',
  '*.passwordHash',
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',

  // OTP material
  'otp',
  '*.otp',
  '*.otpHash',
  '*.code',

  // Secrets and keys
  '*.secret',
  '*.apiKey',
  '*.jwtSecret',
  'env.JWT_SECRET',
  'env.DATABASE_URL',
  'env.SMS_API_KEY',

  // Personal data. Phone is the primary key for customers, so it appears in
  // many payloads; it is redacted in logs and lives only in the database.
  '*.phone',
  '*.phoneNumber',
  '*.email',
  'req.body.phone',
] as const;

const options: LoggerOptions = {
  level: env.LOG_LEVEL,

  // `level: "info"` reads better in an aggregator than `level: 30`.
  formatters: {
    level: (label) => ({ level: label }),
    // Fold request context into every line emitted during a request.
    log: (object) => ({ ...contextForLogging(), ...object }),
  },

  redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },

  timestamp: stdTimeFunctions.isoTime,

  base: {
    service: 'khata-api',
    env: env.APP_ENV,
    version: env.version,
  },

  // Serialise Error causes too — an AppError wrapping a Postgres error is
  // useless in a log without the cause.
  serializers: {
    err: stdSerializers.errWithCause,
  },
};

export const logger: Logger = env.LOG_PRETTY
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env,version',
          messageFormat: '{msg}',
        },
      },
    })
  : pino(options);

/**
 * A child logger tagged with the subsystem it belongs to, e.g.
 * `createLogger('invoices')`. Makes filtering by module trivial.
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
