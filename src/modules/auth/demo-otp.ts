/**
 * The demo switch:
 *
 *   DEMO_OTP_ENABLED=true    no SMS is sent; the code is 000000, for every number
 *   DEMO_OTP_ENABLED=false   a real code is sent by SMS, and only it works
 *
 * Refused in production (env.ts): there, 000000 would open every shop.
 */
import { env } from '../../config/env.js';

/** The demo code: 000000 (all zeros, as long as a real code). */
export function demoOtpCode(): string {
  return '0'.repeat(env.OTP_LENGTH);
}

/** True when the demo switch is on. */
export function demoOtpOn(): boolean {
  return env.DEMO_OTP_ENABLED === true;
}
