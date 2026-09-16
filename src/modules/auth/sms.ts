import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('sms');

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

function setting(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required for SMS_PROVIDER=${env.SMS_PROVIDER}.`);
  return value;
}

function asBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function assertDelivered(response: Response, provider: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `${provider} rejected the message: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

// Development only (production refuses to boot with it). The code is part of
// the message string on purpose, because log redaction applies to fields.
const consoleProvider: SmsProvider = {
  sendOtp(phone, code) {
    log.warn(`OTP for +${phone}: ${code}`);
    return Promise.resolve();
  },
};

function twilioProvider(): SmsProvider {
  const baseUrl = asBase(setting('SMS_API_BASE_URL', env.SMS_API_BASE_URL));
  const accountSid = setting('SMS_ACCOUNT_SID', env.SMS_ACCOUNT_SID);
  const authToken = setting('SMS_API_KEY', env.SMS_API_KEY);
  const sender = setting('SMS_SENDER_ID', env.SMS_SENDER_ID);
  const template = setting('SMS_OTP_MESSAGE_TEMPLATE', env.SMS_OTP_MESSAGE_TEMPLATE);

  return {
    async sendOtp(phone, code) {
      const body = template
        .replaceAll('{code}', code)
        .replaceAll('{minutes}', String(Math.ceil(env.OTP_TTL_SECONDS / 60)));
      const response = await fetch(
        new URL(`2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, baseUrl),
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: `+${phone}`, From: sender, Body: body }),
          signal: AbortSignal.timeout(env.SMS_REQUEST_TIMEOUT_MS),
        },
      );
      await assertDelivered(response, 'Twilio');
    },
  };
}

// Follows MSG91's v5 OTP endpoint; confirm the parameters against the API
// version enabled on the account before go-live, as they differ between versions.
function msg91Provider(): SmsProvider {
  const baseUrl = asBase(setting('SMS_API_BASE_URL', env.SMS_API_BASE_URL));
  const authKey = setting('SMS_API_KEY', env.SMS_API_KEY);
  const templateId = setting('SMS_TEMPLATE_ID', env.SMS_TEMPLATE_ID);

  return {
    async sendOtp(phone, code) {
      const url = new URL('api/v5/otp', baseUrl);
      url.searchParams.set('template_id', templateId);
      url.searchParams.set('mobile', phone);
      url.searchParams.set('otp', code);
      const response = await fetch(url, {
        method: 'POST',
        headers: { authkey: authKey },
        signal: AbortSignal.timeout(env.SMS_REQUEST_TIMEOUT_MS),
      });
      await assertDelivered(response, 'MSG91');
    },
  };
}

let provider: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  provider ??=
    env.SMS_PROVIDER === 'twilio'
      ? twilioProvider()
      : env.SMS_PROVIDER === 'msg91'
        ? msg91Provider()
        : consoleProvider;
  return provider;
}
