/**
 * Twilio Programmable SMS, Messages resource (API version 2010-04-01).
 * https://www.twilio.com/docs/messaging/api/message-resource
 */
import {
  DeliveryError,
  defaultProviderDeps,
  isRetryableHttpStatus,
  renderOtpTemplate,
  type DeliveryReceipt,
  type OtpDeliveryInput,
  type OtpDeliveryProvider,
  type ProviderDeps,
} from '../types.js';

export interface TwilioSettings {
  readonly baseUrl: string;
  readonly accountSid: string;
  readonly authToken: string;
  /** A Twilio number in E.164 with "+", or an alphanumeric sender id. */
  readonly senderId: string;
  /** Must contain `{code}`; may contain `{minutes}`. */
  readonly messageTemplate: string;
  readonly timeoutMs: number;
}

const NAME = 'twilio';

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function createTwilioProvider(
  settings: TwilioSettings,
  deps: ProviderDeps = defaultProviderDeps,
): OtpDeliveryProvider {
  const endpoint = new URL(
    `2010-04-01/Accounts/${encodeURIComponent(settings.accountSid)}/Messages.json`,
    withTrailingSlash(settings.baseUrl),
  );
  const authorization = `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64')}`;

  return {
    name: NAME,
    channel: 'sms',
    async sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt> {
      let response: Response;
      try {
        response = await deps.fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: `+${input.phone}`,
            From: settings.senderId,
            Body: renderOtpTemplate(settings.messageTemplate, input),
          }),
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (error) {
        // Timeouts and connection failures: the vendor may be back in a moment.
        throw new DeliveryError('Twilio is unreachable.', {
          provider: NAME,
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        throw new DeliveryError(`Twilio rejected the message: HTTP ${response.status}.`, {
          provider: NAME,
          retryable: isRetryableHttpStatus(response.status),
          statusCode: response.status,
          cause: await response.text().catch(() => undefined),
        });
      }

      const body = (await response.json().catch(() => ({}))) as { sid?: unknown };
      return {
        provider: NAME,
        channel: 'sms',
        ...(typeof body.sid === 'string' ? { providerMessageId: body.sid } : {}),
      };
    },
  };
}
