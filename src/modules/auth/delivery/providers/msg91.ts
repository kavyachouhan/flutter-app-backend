/**
 * MSG91 OTP API v5. Confirm the parameters against the API version enabled
 * on the account before go-live; they differ between versions.
 * https://docs.msg91.com/reference/send-otp
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

export interface Msg91Settings {
  readonly baseUrl: string;
  readonly authKey: string;
  /** A DLT-approved OTP template registered with MSG91. */
  readonly templateId: string;
  readonly timeoutMs: number;
}

const NAME = 'msg91';

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function createMsg91Provider(
  settings: Msg91Settings,
  deps: ProviderDeps = defaultProviderDeps,
): OtpDeliveryProvider {
  return {
    name: NAME,
    channel: 'sms',
    async sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt> {
      const url = new URL('api/v5/otp', withTrailingSlash(settings.baseUrl));
      url.searchParams.set('template_id', settings.templateId);
      url.searchParams.set('mobile', input.phone);
      url.searchParams.set('otp', input.code);
      url.searchParams.set('otp_expiry', String(Math.max(Math.ceil(input.ttlSeconds / 60), 1)));

      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: 'POST',
          headers: { authkey: settings.authKey },
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (error) {
        throw new DeliveryError('MSG91 is unreachable.', {
          provider: NAME,
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw new DeliveryError(`MSG91 rejected the message: HTTP ${response.status}.`, {
          provider: NAME,
          retryable: isRetryableHttpStatus(response.status),
          statusCode: response.status,
          cause: await response.text().catch(() => undefined),
        });
      }

      // MSG91 answers 200 even on failure and signals it in the body.
      const body = (await response.json().catch(() => ({}))) as {
        type?: unknown;
        message?: unknown;
      };
      if (body.type === 'error') {
        throw new DeliveryError('MSG91 refused the message.', {
          provider: NAME,
          retryable: false,
          statusCode: response.status,
          cause: body.message,
        });
      }
      return {
        provider: NAME,
        channel: 'sms',
        ...(typeof body.message === 'string' ? { providerMessageId: body.message } : {}),
      };
    },
  };
}
