/**
 * Which GSTIN a request is about.
 *
 * Filing is per registration, and a figure spanning two registrations is wrong for both, so every
 * GST report and return resolves its GSTIN here: the one the business has, or the one it names
 * from several, and never one that is not its own.
 */
import type { Tx } from '../../db/tx.js';
import { ErrorCode, UnprocessableError } from '../../lib/errors.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';

/**
 * Every GSTIN this business files under: the tenant's, plus any outlet that
 * overrides it.
 *
 * Exported because the reports need the same list — filing is per
 * registration, and there is no other helper that resolves it.
 */
export async function filingGstins(tx: Tx): Promise<string[]> {
  const settings = await tenantsRepository.getSettings(tx);
  const outlets = await outletsRepository.listOutlets(tx, null);
  const gstins = new Set<string>();
  if (settings.gstin) gstins.add(settings.gstin);
  for (const outlet of outlets) if (outlet.gstin) gstins.add(outlet.gstin);
  return [...gstins];
}

export async function resolveGstin(tx: Tx, requested: string | undefined): Promise<string> {
  const available = await filingGstins(tx);
  if (requested) {
    if (!available.includes(requested)) {
      throw new UnprocessableError(
        'That GSTIN does not belong to this business.',
        ErrorCode.UNPROCESSABLE,
        { details: { gstin: requested, available } },
      );
    }
    return requested;
  }
  const only = available[0];
  if (!only) {
    throw new UnprocessableError(
      'This business is not GST registered, so it has no returns to file.',
      ErrorCode.UNPROCESSABLE,
    );
  }
  if (available.length > 1) {
    throw new UnprocessableError(
      'This business files under more than one GSTIN; name the one you mean.',
      ErrorCode.UNPROCESSABLE,
      { details: { available } },
    );
  }
  return only;
}
