/**
 * The single terminal error handler.
 *
 * Every failure funnels through here and leaves as the same envelope:
 *
 *   { "error": { "code", "message", "details"?, "requestId" } }
 *
 * Two rules make this safe:
 *   1. Only an `AppError` gets its message shown to the client. Anything else
 *      is a bug, and its message could contain a SQL fragment, a file path or
 *      a connection string — so it is logged in full and replaced with a
 *      generic 500.
 *   2. Stack traces never cross the wire, in any environment. In development
 *      they are in the terminal, where they are more useful anyway.
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { getRequestId } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import {
  AppError,
  ErrorCode,
  InternalError,
  ValidationError,
  isAppError,
  type ErrorCodeValue,
  type ErrorDetails,
} from '../lib/errors.js';

interface ErrorResponseBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: ErrorDetails;
    requestId: string | undefined;
  };
}

/** Flattens a Zod failure into `{ "line.0.price": "must be an integer" }`. */
function zodToDetails(error: ZodError): ErrorDetails {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    // Keep the first failure per field; the rest are usually consequences.
    fields[path] ??= issue.message;
  }
  return { fields };
}

/**
 * Maps the errors thrown by libraries below us into our own hierarchy, so the
 * rest of the handler only ever deals with AppError.
 */
function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new ValidationError('The request failed validation.', {
      cause: error,
      details: zodToDetails(error),
    });
  }

  if (error instanceof SyntaxError && 'body' in error) {
    // express.json() could not parse the payload.
    return new AppError(400, ErrorCode.MALFORMED_REQUEST, 'The request body is not valid JSON.', {
      cause: error,
    });
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    return new AppError(413, ErrorCode.MALFORMED_REQUEST, 'The request body is too large.', {
      cause: error,
    });
  }

  return new InternalError('An unexpected error occurred.', { cause: error });
}

export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    // Headers already sent means the response is mid-flight; the only correct
    // move is to hand back to Express so it destroys the socket.
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = normalise(error);
    const requestId = getRequestId();

    const logContext = {
      err: appError,
      code: appError.code,
      status: appError.statusCode,
      method: req.method,
      path: req.originalUrl,
    };

    if (!appError.isOperational || appError.statusCode >= 500) {
      // A bug or a dependency failure. Full detail, including the cause chain.
      logger.error(logContext, `Unhandled failure: ${appError.message}`);
    } else if (appError.statusCode === 429) {
      logger.warn(logContext, 'Request rate limited');
    } else {
      // Expected rejections. Logged at debug so normal validation noise does
      // not drown the signal in production.
      logger.debug(logContext, `Request rejected: ${appError.code}`);
    }

    if (appError.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(appError.retryAfterSeconds));
    }

    const payload = appError.toPayload();
    const body: ErrorResponseBody = {
      error: {
        code: payload.code,
        // A non-operational error's message is replaced even in development:
        // the client contract must be identical across environments, or a bug
        // only reproduces in one of them.
        message: appError.isOperational ? payload.message : 'An unexpected error occurred.',
        requestId,
      },
    };

    if (payload.details !== undefined && appError.isOperational) {
      body.error.details = payload.details;
    }

    // Development convenience only: the underlying message, so a developer
    // does not have to switch to the terminal. Never the stack, never in
    // production, and under a key clients cannot mistake for the contract.
    if (env.isDevelopment && !appError.isOperational) {
      const cause = appError.cause;
      body.error.details = {
        __devOnly: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      };
    }

    res.status(appError.statusCode).json(body);
  };
}
