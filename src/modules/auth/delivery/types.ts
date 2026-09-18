/**
 * The seam between OTP issuance and whoever carries the code to the person.
 *
 * The vendor is expected to change (and may become WhatsApp or voice), so
 * nothing outside this directory knows a vendor's name, endpoint or error
 * format. A provider is one file implementing `OtpDeliveryProvider`; the OTP
 * flow only ever sees a receipt or a `DeliveryError`.
 */

export type OtpDeliveryChannel = 'sms' | 'whatsapp' | 'voice';

export interface OtpDeliveryInput {
  /** E.164 digits without "+", as produced by `normalizePhone`. */
  readonly phone: string;
  readonly code: string;
  /** How long the code stays valid; templates may say "valid for {minutes} minutes". */
  readonly ttlSeconds: number;
  /** BCP 47 tag when the caller knows the person's language; providers may ignore it. */
  readonly locale?: string;
}

export interface DeliveryReceipt {
  readonly provider: string;
  readonly channel: OtpDeliveryChannel;
  /** The vendor's own message id, for support to trace a complaint. */
  readonly providerMessageId?: string;
}

export interface OtpDeliveryProvider {
  /** Stable identifier used in logs and metrics; matches the env value that selects it. */
  readonly name: string;
  readonly channel: OtpDeliveryChannel;
  sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt>;
}

export interface DeliveryErrorOptions {
  readonly provider: string;
  /**
   * true  — the vendor is unavailable (5xx, timeout, network); the person may
   *         retry and the caller answers 503.
   * false — the vendor refused this message (bad number, rejected template);
   *         retrying the same request cannot succeed and the caller answers 422.
   */
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly cause?: unknown;
}

/**
 * Every provider failure is wrapped in one of these so the OTP flow decides
 * between "try again shortly" and "check the number" on a typed flag rather
 * than by parsing vendor error text.
 */
export class DeliveryError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(message: string, options: DeliveryErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DeliveryError';
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

/**
 * Shared classification for HTTP vendors. 408 and 429 are transient by
 * definition; every other 4xx means the request itself was refused.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Substitutes `{code}` and `{minutes}`; the only placeholders templates may use. */
export function renderOtpTemplate(template: string, input: OtpDeliveryInput): string {
  return template
    .replaceAll('{code}', input.code)
    .replaceAll('{minutes}', String(Math.max(Math.ceil(input.ttlSeconds / 60), 1)));
}

/** Dependencies a provider may need; injected so tests never touch the network. */
export interface ProviderDeps {
  readonly fetch: typeof globalThis.fetch;
}

export const defaultProviderDeps: ProviderDeps = { fetch: (...args) => globalThis.fetch(...args) };
