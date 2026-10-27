/**
 * Every failure that reaches a client is an AppError. `code` is the contract
 * clients branch on; messages get reworded and translated, codes do not.
 * Codes are additive only — a rename breaks every installed app that has not
 * updated yet.
 */

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  /** The document carried a custom field key the tenant has not defined. */
  CUSTOM_FIELD_UNKNOWN: 'CUSTOM_FIELD_UNKNOWN',
  /** A defined custom field was missing, too long, or the wrong data type. */
  CUSTOM_FIELD_INVALID: 'CUSTOM_FIELD_INVALID',

  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  /** The provider rejected the destination; retrying with the same number will not help. */
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',

  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  /**
   * An approval names someone who does not hold the permission the discount
   * policy requires. Structural, so it is rejected rather than warned about:
   * an approval from someone not entitled to give it is not evidence of
   * anything, and storing it would make the audit trail say something untrue.
   */
  APPROVER_NOT_PERMITTED: 'APPROVER_NOT_PERMITTED',
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
  /** More units returned than remain unreturned on the invoice line. */
  RETURN_EXCEEDS_INVOICE: 'RETURN_EXCEEDS_INVOICE',
  /** The invoice is void and cannot be returned against. */
  INVOICE_NOT_RETURNABLE: 'INVOICE_NOT_RETURNABLE',
  /** A khata credit or partial refund needs a customer to carry the balance. */
  REFUND_REQUIRES_CUSTOMER: 'REFUND_REQUIRES_CUSTOMER',
  /** This supplier invoice number has already been entered for this year. */
  DUPLICATE_SUPPLIER_INVOICE: 'DUPLICATE_SUPPLIER_INVOICE',
  /** The receipt would take a purchase order line past what was ordered. */
  RECEIPT_EXCEEDS_ORDER: 'RECEIPT_EXCEEDS_ORDER',
  /** The purchase order is cancelled or already fully received. */
  PURCHASE_ORDER_CLOSED: 'PURCHASE_ORDER_CLOSED',
  /** The invoice would take a sales order line past the quantity ordered. */
  FULFILMENT_EXCEEDS_ORDER: 'FULFILMENT_EXCEEDS_ORDER',
  /** The sales order is cancelled, closed or deleted, so it cannot be changed or invoiced. */
  SALES_ORDER_CLOSED: 'SALES_ORDER_CLOSED',
  /** A line already invoiced keeps the item, price, tax and discount it was invoiced at. */
  ORDER_LINE_INVOICED: 'ORDER_LINE_INVOICED',
  /** The advance has been applied to an invoice or refunded, so its amount is fixed. */
  ADVANCE_LOCKED: 'ADVANCE_LOCKED',
  /** The invoice has credit notes against it; void those first, or amend instead. */
  INVOICE_HAS_CREDIT_NOTES: 'INVOICE_HAS_CREDIT_NOTES',
  /** A replacement invoice needs the original fully credited and not already replaced. */
  AMENDMENT_NOT_ALLOWED: 'AMENDMENT_NOT_ALLOWED',
  /** A bill discount larger than the amount it is taken from. */
  DISCOUNT_EXCEEDS_TOTAL: 'DISCOUNT_EXCEEDS_TOTAL',
  /** A discount over the shop's policy without an approval. */
  DISCOUNT_CAP_EXCEEDED: 'DISCOUNT_CAP_EXCEEDED',
  /** More units returned than remain unreturned on the purchase bill line. */
  RETURN_EXCEEDS_BILL: 'RETURN_EXCEEDS_BILL',
  /** The purchase bill is void and cannot be returned against or paid. */
  BILL_NOT_RETURNABLE: 'BILL_NOT_RETURNABLE',
  /** Allocations across bills exceed the payment, or a bill's outstanding. */
  OVERALLOCATION: 'OVERALLOCATION',

  /** The counter already holds as many parked bills as the plan allows. */
  HELD_BILL_LIMIT_REACHED: 'HELD_BILL_LIMIT_REACHED',
  HELD_BILL_ALREADY_RELEASED: 'HELD_BILL_ALREADY_RELEASED',
  DAY_ALREADY_CLOSED: 'DAY_ALREADY_CLOSED',
  /** A later cash-up already exists, so this one would rewrite history. */
  DAY_CLOSE_OUT_OF_ORDER: 'DAY_CLOSE_OUT_OF_ORDER',

  /** The spreadsheet carried more rows than IMPORT_MAX_ROWS. */
  IMPORT_TOO_LARGE: 'IMPORT_TOO_LARGE',
  /** The catalogue changed between analysis and apply; re-analyse before applying. */
  IMPORT_STALE: 'IMPORT_STALE',
  /** The job is not in a state that allows this step (e.g. analyse before ingest). */
  IMPORT_WRONG_STATE: 'IMPORT_WRONG_STATE',
  /** The file has no column that maps to a required field. */
  IMPORT_COLUMN_UNMAPPED: 'IMPORT_COLUMN_UNMAPPED',
  /** The uploaded file could not be read as a spreadsheet. */
  IMPORT_UNREADABLE: 'IMPORT_UNREADABLE',

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
  /** The drawer did not match the expectation by more than the tolerance. */
  CASH_VARIANCE_EXCEEDED: 'CASH_VARIANCE_EXCEEDED',
  /**
   * A discount on the document exceeds the shop's policy and no approval
   * accompanied it. A warning rather than a rejection: the sale has already
   * happened, and the device may have been offline when the cap was tightened.
   * The breach is in `details` and in the discount-audit report.
   */
  DISCOUNT_CAP_EXCEEDED: 'DISCOUNT_CAP_EXCEEDED',
  /**
   * The price charged is not what the customer's price list says it should be.
   * Never a rejection: the device priced from the list it held at the time, and
   * the list may have moved since the sale.
   */
  PRICE_LIST_MISMATCH: 'PRICE_LIST_MISMATCH',
  /** An order asks for more stock than is available (on hand less reserved). */
  RESERVATION_SHORTFALL: 'RESERVATION_SHORTFALL',
  /** A sale takes stock that open sales orders have reserved. */
  RESERVED_STOCK: 'RESERVED_STOCK',
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
