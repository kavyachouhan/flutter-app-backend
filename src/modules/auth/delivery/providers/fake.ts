/**
 * Test double: records every code it is asked to send and can be told to
 * fail, so the real OTP path (issue → deliver → verify) can be exercised
 * without a vendor. env.ts refuses this provider in production.
 *
 * A single shared instance is exported so an integration test can read the
 * code that the app under test "sent".
 */
import type {
  DeliveryReceipt,
  OtpDeliveryChannel,
  OtpDeliveryInput,
  OtpDeliveryProvider,
} from '../types.js';

export interface FakeDeliveryRecord {
  readonly phone: string;
  readonly code: string;
  readonly ttlSeconds: number;
  readonly sentAt: Date;
}

export interface FakeOtpDeliveryProvider extends OtpDeliveryProvider {
  readonly sent: readonly FakeDeliveryRecord[];
  /** The most recent code sent to a phone, or undefined. */
  lastCodeFor(phone: string): string | undefined;
  /** Makes the next `sendOtp` reject with `error`, then clears itself. */
  failNextWith(error: Error): void;
  reset(): void;
}

export function createFakeProvider(channel: OtpDeliveryChannel = 'sms'): FakeOtpDeliveryProvider {
  const sent: FakeDeliveryRecord[] = [];
  let pendingFailure: Error | undefined;

  return {
    name: 'fake',
    channel,
    sent,
    sendOtp(input: OtpDeliveryInput): Promise<DeliveryReceipt> {
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        return Promise.reject(failure);
      }
      sent.push({
        phone: input.phone,
        code: input.code,
        ttlSeconds: input.ttlSeconds,
        sentAt: new Date(),
      });
      return Promise.resolve({
        provider: 'fake',
        channel,
        providerMessageId: `fake-${String(sent.length)}`,
      });
    },
    lastCodeFor(phone) {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const record = sent[i];
        if (record?.phone === phone) return record.code;
      }
      return undefined;
    },
    failNextWith(error) {
      pendingFailure = error;
    },
    reset() {
      sent.length = 0;
      pendingFailure = undefined;
    },
  };
}

/** The instance the registry hands out for OTP_DELIVERY_PROVIDER=fake. */
export const fakeOtpDelivery: FakeOtpDeliveryProvider = createFakeProvider();
