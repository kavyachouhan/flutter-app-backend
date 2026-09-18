/**
 * Maps OTP_DELIVERY_PROVIDER to a provider instance.
 *
 * Adding a vendor: implement `OtpDeliveryProvider` in ./providers/<name>.ts,
 * add its env keys to src/config/env.ts (with the required-keys entry so
 * boot fails on a half-configured provider), and add one line to FACTORIES.
 * Nothing in the auth flow changes. See docs/ADDING_A_DELIVERY_PROVIDER.md.
 */
import { env } from '../../../config/env.js';
import { createConsoleProvider } from './providers/console.js';
import { fakeOtpDelivery } from './providers/fake.js';
import { createMsg91Provider } from './providers/msg91.js';
import { createTwilioProvider } from './providers/twilio.js';
import type { OtpDeliveryProvider } from './types.js';

type ProviderName = typeof env.OTP_DELIVERY_PROVIDER;

/** env.ts has already checked the keys exist; this narrows the type. */
function configured<T extends string | undefined>(name: string, value: T): NonNullable<T> {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for OTP_DELIVERY_PROVIDER=${env.OTP_DELIVERY_PROVIDER}.`);
  }
  return value;
}

const FACTORIES: Record<ProviderName, () => OtpDeliveryProvider> = {
  console: createConsoleProvider,
  fake: () => fakeOtpDelivery,
  twilio: () =>
    createTwilioProvider({
      baseUrl: configured('TWILIO_API_BASE_URL', env.TWILIO_API_BASE_URL),
      accountSid: configured('TWILIO_ACCOUNT_SID', env.TWILIO_ACCOUNT_SID),
      authToken: configured('TWILIO_AUTH_TOKEN', env.TWILIO_AUTH_TOKEN),
      senderId: configured('TWILIO_SENDER_ID', env.TWILIO_SENDER_ID),
      messageTemplate: configured('TWILIO_OTP_MESSAGE_TEMPLATE', env.TWILIO_OTP_MESSAGE_TEMPLATE),
      timeoutMs: env.OTP_DELIVERY_TIMEOUT_MS,
    }),
  msg91: () =>
    createMsg91Provider({
      baseUrl: configured('MSG91_API_BASE_URL', env.MSG91_API_BASE_URL),
      authKey: configured('MSG91_AUTH_KEY', env.MSG91_AUTH_KEY),
      templateId: configured('MSG91_TEMPLATE_ID', env.MSG91_TEMPLATE_ID),
      timeoutMs: env.OTP_DELIVERY_TIMEOUT_MS,
    }),
};

let instance: OtpDeliveryProvider | undefined;

export function getOtpDeliveryProvider(): OtpDeliveryProvider {
  instance ??= FACTORIES[env.OTP_DELIVERY_PROVIDER]();
  return instance;
}

export const __testing = {
  reset(): void {
    instance = undefined;
  },
  providerNames: Object.keys(FACTORIES) as ProviderName[],
};
