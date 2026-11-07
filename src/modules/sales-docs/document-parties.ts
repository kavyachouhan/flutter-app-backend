/**
 * Freezes who a document is between on the documents that are not tax documents (freeze §4):
 * estimates, sales orders, proforma invoices and delivery challans. They stay editable, so an edit
 * takes the parties as they are then; once it stops being edited, what it says stays put.
 */
import type { Tx } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { customersRepository } from '../customers/customers.repository.js';
import { customerSnapshot, dispatchSnapshot, sellerSnapshot } from '../invoices/invoice-supply.js';
import { outletsRepository } from '../outlets/outlets.repository.js';
import { tenantsRepository } from '../tenants/tenants.repository.js';
import { taxModeFor } from './prepare.js';

export type PartyDocumentTable = 'estimates' | 'sales_orders' | 'proforma_invoices' | 'delivery_challans';

export async function stampDocumentParties(
  tx: Tx,
  table: PartyDocumentTable,
  doc: { readonly id: string; readonly outletId: string; readonly customerId: string | null | undefined },
): Promise<void> {
  const [tenant, settings, outlet, customer] = await Promise.all([
    tenantsRepository.findCurrent(tx),
    tenantsRepository.getSettings(tx),
    outletsRepository.findOutlet(tx, doc.outletId),
    doc.customerId ? customersRepository.find(tx, doc.customerId) : Promise.resolve(undefined),
  ]);
  if (!tenant) throw new NotFoundError('Tenant');
  if (!outlet) throw new NotFoundError('Outlet');
  await tx.query(
    `UPDATE ${table}
        SET registration_id = (SELECT registration_id FROM outlets WHERE id = $2),
            seller_snapshot = $3::jsonb, buyer_snapshot = $4::jsonb, dispatch_from_snapshot = $5::jsonb
      WHERE id = $1`,
    [
      doc.id,
      doc.outletId,
      JSON.stringify(sellerSnapshot(tenant, outlet, taxModeFor(settings))),
      customer ? JSON.stringify(customerSnapshot(customer)) : null,
      JSON.stringify(dispatchSnapshot(tenant, outlet)),
    ],
  );
}
