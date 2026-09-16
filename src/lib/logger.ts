import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';
import { contextForLogging } from './context.js';

// Redaction is opt-out rather than opt-in because this service handles OTPs,
// tokens and customer phone numbers, and a forgotten field is a data incident.
const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.identityToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'otp',
  '*.otp',
  '*.code',
  '*.secret',
  '*.apiKey',
  '*.phone',
  '*.email',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => ({ ...contextForLogging(), ...object }),
  },
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  timestamp: stdTimeFunctions.isoTime,
  base: { service: env.SERVICE_NAME, env: env.APP_ENV, version: env.version },
  serializers: { err: stdSerializers.errWithCause },
};

export const logger: Logger = env.LOG_PRETTY
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname,service,env,version' },
      },
    })
  : pino(options);

export function createLogger(module: string): Logger {
  return logger.child({ module });
}
