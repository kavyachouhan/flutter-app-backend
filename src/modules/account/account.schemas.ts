import { z } from 'zod';

/**
 * business  close the whole business and delete everything in it (owners only)
 * login     delete only my own sign-in for this business; the business carries on
 */
export const ACCOUNT_DELETION_SCOPES = ['business', 'login'] as const;

export const accountDeletionBody = z.object({
  scope: z.enum(ACCOUNT_DELETION_SCOPES),
  /**
   * A fresh one-time code sent to the signed-in person's own phone number
   * (POST /v1/auth/otp/request). A signed-in session alone is not enough to
   * destroy a business: a phone left unlocked on the counter must not be.
   */
  code: z.string().regex(/^\d+$/),
});
export type AccountDeletionBody = z.infer<typeof accountDeletionBody>;
