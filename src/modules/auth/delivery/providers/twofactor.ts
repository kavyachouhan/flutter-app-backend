/**
 * 2Factor.in SMS OTP (API V1). We generate the code; 2Factor delivers it
 * through an OTP template registered on the account (DLT-approved in India):
 *
 *   GET {base}/{api_key}/SMS/{phone}/{code}/{template}
 *
 * The API key is part of the URL path, so the URL must never be logged —
 * errors below carry the provider's reply, never the request URL.
 * https://2factor.in/API/DOCS/SMS_OTP.html
 */
import {
  DeliveryError,
  defaultProviderDeps,
  isRetryableHttpStatus,
  type DeliveryReceipt,
  type OtpDeliveryInput,
  type OtpDeliveryProvider,
  type ProviderDeps,
} from '../types.js';

export interface TwoFactorSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The OTP template name on the 2Factor account, e.g. OTP1. */
  readonly templateName: string;
  readonly timeoutMs: number;
}

const NAME = 'twofactor';

/** 2Factor's reply: `{ Status: 'Success' | 'Error', Details: <session id or reason> }`. */
interface TwoFactorReply {
  Status?: unknown;
  Details?: unknown;
}

export function createTwoFactorProvider(
  settings: TwoFactorSettings,
  deps: ProviderDeps = defaultProviderDeps,
): OtpDeliveryProvider {
  const base = settings.baseUrl.replace(/\/+$/, '');
  return {
    name: NAME,
    channel: 'sms',
    async sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt> {
      const url = [
        base,
        encodeURIComponent(settings.apiKey),
        'SMS',
        encodeURIComponent(input.phone),
        encodeURIComponent(input.code),
        encodeURIComponent(settings.templateName),
      ].join('/');

      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (error) {
        throw new DeliveryError('2Factor is unreachable.', {
          provider: NAME,
          retryable: true,
          cause: error instanceof Error ? error.name : undefined,
        });
      }

      const body = (await response.json().catch(() => ({}))) as TwoFactorReply;
      const details = typeof body.Details === 'string' ? body.Details : undefined;

      if (!response.ok) {
        throw new DeliveryError(`2Factor rejected the message: HTTP ${response.status}.`, {
          provider: NAME,
          retryable: isRetryableHttpStatus(response.status),
          statusCode: response.status,
          cause: details,
        });
      }
      // 2Factor can answer 200 and still refuse, saying so in the body.
      if (body.Status !== 'Success') {
        throw new DeliveryError('2Factor refused the message.', {
          provider: NAME,
          retryable: false,
          statusCode: response.status,
          cause: details,
        });
      }
      return {
        provider: NAME,
        channel: 'sms',
        ...(details ? { providerMessageId: details } : {}),
      };
    },
  };
}
