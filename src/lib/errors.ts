/**
 * Every failure that reaches a client is an AppError. `code` is the contract
 * clients branch on; messages get reworded and translated, codes do not.
 * Codes are additive only — a rename breaks every installed app that has not
 * updated yet.
 */

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  /** The provider rejected the destination; retrying with the same number will not help. */
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',

  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  OUTLET_NOT_PERMITTED: 'OUTLET_NOT_PERMITTED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',

  NOT_FOUND: 'NOT_FOUND',

  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  DOCUMENT_IMMUTABLE: 'DOCUMENT_IMMUTABLE',
  TOTALS_MISMATCH: 'TOTALS_MISMATCH',
  LAST_OWNER: 'LAST_OWNER',

  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',

  UNPROCESSABLE: 'UNPROCESSABLE',
  NUMBER_NOT_LEASED: 'NUMBER_NOT_LEASED',
  NUMBER_BLOCK_EXHAUSTED: 'NUMBER_BLOCK_EXHAUSTED',
  CREDIT_SALE_REQUIRES_CUSTOMER: 'CREDIT_SALE_REQUIRES_CUSTOMER',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  OVERPAYMENT: 'OVERPAYMENT',

  /** A push carried more operations than SYNC_PUSH_MAX_OPERATIONS. */
  SYNC_BATCH_TOO_LARGE: 'SYNC_BATCH_TOO_LARGE',
  /** The device must discard its local database and pull from zero. */
  SYNC_RESET_REQUIRED: 'SYNC_RESET_REQUIRED',
  /** An update carried a baseServerSeq older than the row on the server. */
  STALE_WRITE: 'STALE_WRITE',
  SYNC_ENTITY_UNKNOWN: 'SYNC_ENTITY_UNKNOWN',
  SYNC_CURSOR_INVALID: 'SYNC_CURSOR_INVALID',

  RATE_LIMITED: 'RATE_LIMITED',

  INTERNAL: 'INTERNAL',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Warnings returned alongside a successful write; the operation is not rejected. */
export const WarningCode = {
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  NEGATIVE_STOCK: 'NEGATIVE_STOCK',
} as const;

export type WarningCodeValue = (typeof WarningCode)[keyof typeof WarningCode];

export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** Logged, never serialised. */
  cause?: unknown;
  /** Client-safe structured context. */
  details?: ErrorDetails;
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details: ErrorDetails | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** False marks a bug: logged at error level and answered with a generic 500. */
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
  }
}

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
 * Also used for resources owned by another tenant: a 403 would confirm the
 * record exists across the tenant boundary.
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
    message: string,
    code: ErrorCodeValue = ErrorCode.UNPROCESSABLE,
    options: AppErrorOptions = {},
  ) {
    super(422, code, message, options);
  }
}

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
  constructor(retryAfterSeconds: number) {
    super(429, ErrorCode.RATE_LIMITED, 'Too many requests. Please slow down.', {
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

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
