import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { getContext } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { AppError, ErrorCode, InternalError, ValidationError, isAppError } from '../lib/errors.js';

function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    fields[issue.path.join('.') || '(root)'] ??= issue.message;
  }
  return fields;
}

function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) {
    return new ValidationError(undefined, { cause: error, details: { fields: zodFields(error) } });
  }
  // body-parser signals its failures through `type` rather than error classes.
  const type =
    typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
  if (type === 'entity.parse.failed') {
    return new AppError(400, ErrorCode.MALFORMED_REQUEST, 'The request body is not valid JSON.', {
      cause: error,
    });
  }
  if (type === 'entity.too.large') {
    return new AppError(413, ErrorCode.MALFORMED_REQUEST, 'The request body is too large.', {
      cause: error,
    });
  }
  return new InternalError(undefined, { cause: error });
}

/**
 * Only AppError messages reach the client. Anything else may carry SQL, file
 * paths or connection strings, so it is logged in full and replaced.
 */
export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = normalise(error);
    const logContext = {
      err: appError,
      code: appError.code,
      method: req.method,
      path: req.originalUrl,
    };

    if (!appError.isOperational || appError.statusCode >= 500) {
      logger.error(logContext, appError.message);
    } else {
      logger.debug(logContext, `Rejected: ${appError.code}`);
    }

    if (appError.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(appError.retryAfterSeconds));
    }

    const body: { error: Record<string, unknown> } = {
      error: {
        code: appError.code,
        message: appError.isOperational ? appError.message : 'An unexpected error occurred.',
        requestId: getContext()?.requestId,
      },
    };
    if (appError.isOperational && appError.details) body.error['details'] = appError.details;

    // Development only, under a key no client should parse.
    if (env.isDevelopment && !appError.isOperational && appError.cause instanceof Error) {
      body.error['devCause'] = `${appError.cause.name}: ${appError.cause.message}`;
    }

    res.status(appError.statusCode).json(body);
  };
}
