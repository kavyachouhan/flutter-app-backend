/**
 * Development only: prints the code to the log instead of sending it.
 * env.ts refuses this provider in production.
 */
import { createLogger } from '../../../../lib/logger.js';
import type { DeliveryReceipt, OtpDeliveryInput, OtpDeliveryProvider } from '../types.js';

const log = createLogger('otp-delivery');

export function createConsoleProvider(): OtpDeliveryProvider {
  return {
    name: 'console',
    channel: 'sms',
    sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt> {
      // The code is part of the message string on purpose: log redaction
      // applies to fields, and a developer needs to read it.
      log.warn(`OTP for +${input.phone}: ${input.code}`);
      return Promise.resolve({ provider: 'console', channel: 'sms' });
    },
  };
}
