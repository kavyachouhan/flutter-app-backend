/**
 * The application error hierarchy.
 *
 * Every failure that reaches a client goes through one of these. The `code` is
 * a stable, machine-readable enum that the Flutter and React clients switch
 * on — clients must never string-match a human message, because messages get
 * reworded and translated and the match silently stops working.
 *
 * Rules:
 *   - `message` is safe to show a user or an integrator. Never put a SQL
 *     fragment, a stack trace or a secret in it.
 *   - `details` carries structured, also-safe context (which field failed,
 *     which limit was hit).
 *   - Anything NOT an AppError is treated as a bug: the error handler logs it
 *     in full and returns a generic 500, so internals never leak.
 */

/**
 * Stable error codes. Additive only — renaming one is a breaking API change
 * for every deployed mobile app that has not been updated.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  OUTLET_NOT_PERMITTED: 'OUTLET_NOT_PERMITTED',

  // 404
  NOT_FOUND: 'NOT_FOUND',

  // 409
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  DOCUMENT_IMMUTABLE: 'DOCUMENT_IMMUTABLE',
  TOTALS_MISMATCH: 'TOTALS_MISMATCH',
  STALE_WRITE: 'STALE_WRITE',

  // 402 / entitlements
  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',

  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  NUMBER_BLOCK_EXHAUSTED: 'NUMBER_BLOCK_EXHAUSTED',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 500 / 503
  INTERNAL: 'INTERNAL',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured, client-safe context attached to an error. */
export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** The underlying error, logged but never serialised to the client. */
  cause?: unknown;
  details?: ErrorDetails;
  /** Seconds the client should wait before retrying. Emitted as Retry-After. */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details: ErrorDetails | undefined;
  readonly retryAfterSeconds: number | undefined;

  /**
   * True for errors that are a normal part of operation (a validation failure,
   * a 404). These log at `warn`. Anything non-operational logs at `error` and
   * is treated as a bug worth paging on.
   *
   * Annotated `boolean` rather than left to inference: an inferred `true`
   * literal type makes the `false` override in InternalError a type error.
   */
  readonly isOperational: boolean = true;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace(this, new.target);
  }

  /** The client-facing shape. `requestId` is added by the error handler. */
  toPayload(): { code: ErrorCodeValue; message: string; details?: ErrorDetails } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

// ---------------------------------------------------------------------------
// Concrete errors
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  constructor(message = 'The request failed validation.', options: AppErrorOptions = {}) {
    super(400, ErrorCode.VALIDATION_FAILED, message, options);
  }
}

export class AuthError extends AppError {
  constructor(
    message = 'Authentication is required.',
    code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
    options: AppErrorOptions = {},
  ) {
    super(401, code, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code: ErrorCodeValue = ErrorCode.FORBIDDEN,
    options: AppErrorOptions = {},
  ) {
    super(403, code, message, options);
  }
}

/**
 * Note the deliberate choice throughout the codebase: a resource belonging to
 * another tenant returns NotFound, not Forbidden. Forbidden would confirm the
 * record exists, which is an information leak across a tenant boundary.
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource', options: AppErrorOptions = {}) {
    super(404, ErrorCode.NOT_FOUND, `${resource} not found.`, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state of the resource.',
    code: ErrorCodeValue = ErrorCode.CONFLICT,
    options: AppErrorOptions = {},
  ) {
    super(409, code, message, options);
  }
}

export class UnprocessableError extends AppError {
  constructor(
    message = 'The request is well-formed but cannot be processed.',
    code: ErrorCodeValue = ErrorCode.UNPROCESSABLE,
    options: AppErrorOptions = {},
  ) {
    super(422, code, message, options);
  }
}

/** Raised when a plan limit blocks the action — seats, outlets, item count. */
export class EntitlementError extends AppError {
  constructor(
    message = 'Your current plan does not include this.',
    code: ErrorCodeValue = ErrorCode.ENTITLEMENT_REQUIRED,
    options: AppErrorOptions = {},
  ) {
    super(402, code, message, options);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, options: AppErrorOptions = {}) {
    super(429, ErrorCode.RATE_LIMITED, 'Too many requests. Please slow down.', {
      ...options,
      retryAfterSeconds,
    });
  }
}

export class DependencyError extends AppError {
  constructor(dependency: string, options: AppErrorOptions = {}) {
    super(
      503,
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      `A required service (${dependency}) is unavailable. Please retry shortly.`,
      options,
    );
  }
}

export class InternalError extends AppError {
  override readonly isOperational: boolean = false;

  constructor(message = 'An unexpected error occurred.', options: AppErrorOptions = {}) {
    super(500, ErrorCode.INTERNAL, message, options);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Safe one-line description of any thrown value, for logging. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
