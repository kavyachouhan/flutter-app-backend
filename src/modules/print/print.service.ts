/**
 * Assembles print payloads and manages the configuration they read.
 *
 * The device gets a finished document: every string formatted, every legal
 * title decided, every custom field labelled and ordered. `src/domain/print/`
 * does that work; this module's job is to feed it accurate inputs and to
 * resist the temptation to recompute anything the document already recorded.
 */
import { randomUUID } from 'node:crypto';
import { withReadTransaction, withTransaction, type Tx } from '../../db/tx.js';
import {
  resolvePrintDocument,
  type PrintProfile,
  type ResolveInput,
} from '../../domain/print/resolve.js';
import { stateNameFor } from '../../domain/print/states.js';
import {
  resolveTemplate,
  TEMPLATES,
  type TemplateDefinition,
  type TemplateKey,
} from '../../domain/print/templates.js';
import type { PrintDocument } from '../../domain/print/types.js';
import type { TaxMode } from '../../domain/tax/types.js';
import { ConflictError, ErrorCode, NotFoundError } from '../../lib/errors.js';
import { assertOutletAccess } from '../../middleware/authorize.js';
import { recordAudit } from '../audit/audit.js';
import { creditNotesRepository } from '../credit-notes/credit-notes.repository.js';
import { invoicesRepository } from '../invoices/invoices.repository.js';
import { outletsRepository, type OutletRow } from '../outlets/outlets.repository.js';
import { paymentsRepository } from '../payments/payments.repository.js';
import { salesOrdersRepository } from '../sales-orders/sales-orders.repository.js';
import { assertFeature } from '../entitlements/entitlements.js';
import { tenantsRepository, type TenantRow } from '../tenants/tenants.repository.js';
import { resolveCustomFields } from './custom-fields.js';
import {
  printRepository,
  type CustomFieldDefinitionRow,
  type PrintProfileRow,
} from './print.repository.js';
import type {
  CreateCustomFieldBody,
  PrintPayloadQuery,
  UpdateCustomFieldBody,
  UpsertPrintProfileBody,
} from './print.schemas.js';

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * A tenant that has never opened the print settings screen still has to be
 * able to print, so an absent profile is a default, not an error.
 */
const FALLBACK_TEMPLATE: TemplateKey = 'thermal_compact';

const EMPTY_PROFILE: PrintProfile = {
  logoObjectKey: null,
  signatureObjectKey: null,
  signatureLabel: null,
  upiId: null,
  bankLines: [],
  termsLines: [],
  footerLines: [],
  lookupBaseUrl: null,
};

interface ResolvedProfile {
  readonly profile: PrintProfile;
  readonly template: TemplateDefinition;
}

/**
 * Folds the tenant default and the outlet row together, field by field.
 *
 * Field-by-field rather than whole-row: a chain that sets one branch's UPI ID
 * should not thereby lose the terms and conditions it configured once for
 * every branch. `rows` arrives default-first from the repository.
 */
function foldProfiles(rows: readonly PrintProfileRow[]): ResolvedProfile {
  let templateKey: TemplateKey = FALLBACK_TEMPLATE;
  let profile: PrintProfile = EMPTY_PROFILE;
  let overrides = {};

  for (const row of rows) {
    templateKey = row.templateKey;
    profile = {
      logoObjectKey: row.logoObjectKey ?? profile.logoObjectKey,
      signatureObjectKey: row.signatureObjectKey ?? profile.signatureObjectKey,
      signatureLabel: row.signatureLabel ?? profile.signatureLabel,
      upiId: row.upiId ?? profile.upiId,
      // An explicitly emptied list is a choice; only an absent one inherits.
      bankLines: row.bankLines.length > 0 ? row.bankLines : profile.bankLines,
      termsLines: row.termsLines.length > 0 ? row.termsLines : profile.termsLines,
      footerLines: row.footerLines.length > 0 ? row.footerLines : profile.footerLines,
      lookupBaseUrl: row.lookupBaseUrl ?? profile.lookupBaseUrl,
    };
    overrides = {
      ...overrides,
      ...(row.showHsn !== null ? { showHsn: row.showHsn } : {}),
      ...(row.showTaxColumn !== null ? { showTaxColumn: row.showTaxColumn } : {}),
      ...(row.showTaxSummary !== null ? { showTaxSummary: row.showTaxSummary } : {}),
      ...(row.showAmountInWords !== null ? { showAmountInWords: row.showAmountInWords } : {}),
      ...(row.showSignature !== null ? { showSignature: row.showSignature } : {}),
    };
  }

  return { profile, template: resolveTemplate(templateKey, overrides) };
}

// ---------------------------------------------------------------------------
// The columns the print path reads
//
// The header row types carry an index signature for the columns their own
// callers do not name, which would turn every read below into a bracket
// lookup. Naming them once keeps the payload builders readable and makes this
// module's dependency on the schema explicit — if a column is dropped, the
// compiler points here rather than at thirty scattered strings.
// ---------------------------------------------------------------------------

/**
 * A document issued with a saved T&C prints the text it was issued with, in
 * place of the shop-wide default lines; one issued without keeps the default.
 */
function withDocumentTerms(
  profile: PrintProfile,
  snapshot: { description: string } | null | undefined,
): PrintProfile {
  if (!snapshot) return profile;
  const lines = snapshot.description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? { ...profile, termsLines: lines } : profile;
}

interface DocumentPrintHeader {
  readonly id: string;
  readonly outletId: string;
  readonly counterId: string | null;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly customerGstin: string | null;
  readonly taxMode: TaxMode;
  readonly supplyType: 'intra_state' | 'inter_state';
  readonly grossAmount: number;
  readonly lineDiscountTotal: number;
  readonly billDiscountAmount: number;
  readonly taxableAmount: number;
  readonly totalCgst: number;
  readonly totalSgst: number;
  readonly totalIgst: number;
  readonly totalCess: number;
  readonly roundOff: number;
  readonly grandTotal: number;
  readonly taxSummary: unknown;
  readonly customFields: Record<string, string> | null;
  readonly notes: string | null;
  readonly issuedAt: string;
  readonly issuedBy: string;
}

interface InvoicePrintHeader extends DocumentPrintHeader {
  readonly taxableCharges: number;
  readonly nonTaxableCharges: number;
  readonly amountPaid: number;
  readonly termsSnapshot: { readonly description: string } | null;
}

interface CreditNotePrintHeader extends DocumentPrintHeader {
  readonly originalDocumentNumber: string;
  readonly refundMode: string;
  readonly refundAmount: number;
}

interface PrintLineRow {
  readonly itemName: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPrice: number;
  readonly hsnCode: string | null;
  readonly taxRatePercent: string | number;
  readonly lineDiscount: number;
  readonly billDiscountShare?: number;
  readonly lineTotal: number;
}

interface PrintTenderRow {
  readonly mode: string;
  readonly amount: number;
  readonly tenderedAmount: number | null;
  readonly status: 'issued' | 'void';
}

// ---------------------------------------------------------------------------
// Shared payload pieces
// ---------------------------------------------------------------------------

function compact(lines: readonly (string | null | undefined)[]): string[] {
  return lines.map((l) => l?.trim() ?? '').filter((l) => l.length > 0);
}

/**
 * The header block.
 *
 * Outlet values win over tenant values field by field — a branch has its own
 * address and may have its own GSTIN, but rarely its own trading name. This
 * is the same precedence `invoices.service.ts` applies when it snapshots the
 * supplier GSTIN onto the invoice.
 */
function buildBusiness(outlet: OutletRow, tenant: TenantRow) {
  return {
    name: tenant.name,
    legalName: tenant.legalName,
    addressLines: compact([
      outlet.addressLine1 ?? tenant.addressLine1,
      outlet.addressLine2 ?? tenant.addressLine2,
      [outlet.city ?? tenant.city, outlet.pincode ?? tenant.pincode].filter(Boolean).join(' '),
    ]),
    phone: outlet.phone ?? tenant.phone,
    email: tenant.email,
    gstin: outlet.gstin ?? tenant.gstin,
  };
}

function pickTemplate(
  resolved: ResolvedProfile,
  requested: TemplateKey | undefined,
): TemplateDefinition {
  if (!requested) return resolved.template;
  // An explicit ?template= still honours the tenant's own overrides, so asking
  // for the A4 layout does not silently switch HSN codes back on.
  return resolveTemplate(requested, {
    showHsn: resolved.template.showHsn,
    showTaxColumn: resolved.template.showTaxColumn,
    showTaxSummary: resolved.template.showTaxSummary,
    showAmountInWords: resolved.template.showAmountInWords,
    showSignature: resolved.template.showSignature,
  });
}

function assertCopyIndex(template: TemplateDefinition, copyIndex: number): void {
  if (copyIndex === 0) return;
  if (copyIndex >= template.copyLabels.length) {
    throw new ConflictError(
      `Template ${template.key} has ${template.copyLabels.length} copy label(s); copy ${copyIndex} does not exist.`,
      ErrorCode.UNPROCESSABLE,
    );
  }
}

async function loadCustomer(
  tx: Tx,
  customerId: string | null,
  name: string | null,
  gstin: string | null,
) {
  if (!name) return null;
  const details = customerId
    ? await printRepository.findCustomerDetails(tx, customerId)
    : undefined;
  return {
    name,
    phone: details?.phone ?? null,
    gstin,
    addressLines: compact([
      details?.addressLine1,
      details?.addressLine2,
      [details?.city, details?.pincode].filter(Boolean).join(' '),
    ]),
    stateName: stateNameFor(details?.stateCode),
  };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export function buildInvoicePayload(id: string, query: PrintPayloadQuery): Promise<PrintDocument> {
  return withReadTransaction(async (tx) => {
    const row = await invoicesRepository.findHeader(tx, id);
    if (!row) throw new NotFoundError('Invoice');
    assertOutletAccess(row.outletId);
    const header = row as unknown as InvoicePrintHeader;

    const [tenant, outlet, profiles, lines, tenders] = await Promise.all([
      tenantsRepository.findCurrent(tx),
      outletsRepository.findOutlet(tx, header.outletId),
      printRepository.findProfilesForOutlet(tx, header.outletId),
      invoicesRepository.findLines(tx, id) as Promise<PrintLineRow[]>,
      paymentsRepository.findForInvoice(tx, id) as Promise<PrintTenderRow[]>,
    ]);
    if (!tenant) throw new NotFoundError('Tenant');
    if (!outlet) throw new NotFoundError('Outlet');

    const resolved = foldProfiles(profiles);
    const template = pickTemplate(resolved, query.template);
    const copyIndex = query.copyIndex ?? 0;
    assertCopyIndex(template, copyIndex);

    const context = await printRepository.findContext(tx, header.issuedBy, header.counterId);
    const customFields = await resolveCustomFields(tx, 'invoice', header.customFields);

    const input: ResolveInput = {
      kind: 'invoice',
      documentNumber: header.documentNumber,
      documentDate: String(header.documentDate),
      issuedAt: header.issuedAt,
      // Both snapshotted at issue. Recomputing either from today's settings
      // would rewrite history if the business later registered for GST or the
      // outlet moved state.
      taxMode: header.taxMode,
      isInterState: header.supplyType === 'inter_state',
      business: buildBusiness(outlet, tenant),
      profile: withDocumentTerms(resolved.profile, header.termsSnapshot),
      customer: await loadCustomer(
        tx,
        header.customerId,
        header.customerName,
        header.customerGstin,
      ),
      lines: lines.map((line) => ({
        name: line.itemName,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        hsnCode: line.hsnCode,
        taxRatePercent: Number(line.taxRatePercent),
        // The customer cares what came off the line, not which of the two
        // discount mechanisms produced it.
        discount: line.lineDiscount + (line.billDiscountShare ?? 0),
        lineTotal: line.lineTotal,
      })),
      totals: {
        grossAmount: header.grossAmount,
        totalDiscount: header.lineDiscountTotal + header.billDiscountAmount,
        taxableAmount: header.taxableAmount,
        totalCgst: header.totalCgst,
        totalSgst: header.totalSgst,
        totalIgst: header.totalIgst,
        totalCess: header.totalCess,
        charges: header.taxableCharges + header.nonTaxableCharges,
        roundOff: header.roundOff,
        grandTotal: header.grandTotal,
        amountPaid: header.amountPaid,
      },
      taxRows: toTaxRows(header.taxSummary),
      // A voided tender is not money the shop holds, so it must not appear as
      // one on the bill.
      tenders: tenders
        .filter((t) => t.status === 'issued')
        .map((t) => ({ mode: t.mode, amount: t.amount, tenderedAmount: t.tenderedAmount ?? null })),
      customFields,
      template,
      timezone: tenant.timezone,
      currencySymbol: tenant.currencySymbol,
      copyIndex,
      cashierName: context?.cashierName ?? null,
      counterName: context?.counterName ?? null,
      notes: header.notes,
    };

    return resolvePrintDocument(input);
  });
}

// ---------------------------------------------------------------------------
// Sales order
// ---------------------------------------------------------------------------

/**
 * A sale order, ready to print or share. It reads the same way a bill does so the customer
 * recognises it, but it is titled SALE ORDER and carries the advance and what is still due
 * rather than tenders: nothing has been supplied yet.
 */
export function buildSaleOrderPayload(id: string, query: PrintPayloadQuery): Promise<PrintDocument> {
  return withReadTransaction(async (tx) => {
    await assertFeature(tx, 'sales_orders');
    const order = await salesOrdersRepository.find(tx, id);
    if (!order) throw new NotFoundError('Sales order');
    assertOutletAccess(order.outletId);

    const [tenant, outlet, profiles, lines, advance] = await Promise.all([
      tenantsRepository.findCurrent(tx),
      outletsRepository.findOutlet(tx, order.outletId),
      printRepository.findProfilesForOutlet(tx, order.outletId),
      salesOrdersRepository.findLines(tx, id),
      salesOrdersRepository.advanceState(tx, id),
    ]);
    if (!tenant) throw new NotFoundError('Tenant');
    if (!outlet) throw new NotFoundError('Outlet');

    const resolved = foldProfiles(profiles);
    const template = pickTemplate(resolved, query.template);
    const copyIndex = query.copyIndex ?? 0;
    assertCopyIndex(template, copyIndex);

    const customFields = await resolveCustomFields(tx, 'sales_order', order.customFields);
    const held = Math.max(0, advance.taken - advance.refunded);

    const input: ResolveInput = {
      kind: 'sales_order',
      documentNumber: order.documentNumber,
      documentDate: String(order.documentDate),
      dueDate: order.dueDate === null ? null : String(order.dueDate),
      issuedAt: order.createdAt,
      taxMode: order.taxMode as TaxMode,
      isInterState: order.supplyType !== 'intra_state',
      business: buildBusiness(outlet, tenant),
      profile: withDocumentTerms(resolved.profile, order.termsSnapshot),
      customer: await loadCustomer(tx, order.customerId, order.customerName, null),
      lines: lines.map((line) => ({
        name: line.itemName,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        hsnCode: line.hsnCode,
        taxRatePercent: Number(line.taxRatePercent),
        discount: line.lineDiscount + line.billDiscountShare,
        lineTotal: line.lineTotal,
      })),
      totals: {
        grossAmount: order.grossAmount,
        totalDiscount: order.lineDiscountTotal + order.billDiscountAmount,
        taxableAmount: order.taxableAmount,
        totalCgst: order.totalCgst,
        totalSgst: order.totalSgst,
        totalIgst: order.totalIgst,
        totalCess: order.totalCess,
        charges: order.taxableCharges + order.nonTaxableCharges,
        roundOff: order.roundOff,
        grandTotal: order.grandTotal,
        amountPaid: held,
      },
      taxRows: toTaxRows(order.taxSummary),
      tenders:
        held > 0 && order.paymentMode
          ? [{ mode: order.paymentMode, amount: held, tenderedAmount: null }]
          : [],
      customFields,
      template,
      timezone: tenant.timezone,
      currencySymbol: tenant.currencySymbol,
      copyIndex,
      notes: order.notes,
    };
    return resolvePrintDocument(input);
  });
}

// ---------------------------------------------------------------------------
// Credit note
// ---------------------------------------------------------------------------

export function buildCreditNotePayload(
  id: string,
  query: PrintPayloadQuery,
): Promise<PrintDocument> {
  return withReadTransaction(async (tx) => {
    const row = await creditNotesRepository.findHeader(tx, id);
    if (!row) throw new NotFoundError('Credit note');
    assertOutletAccess(row.outletId);
    const header = row as unknown as CreditNotePrintHeader;

    const [tenant, outlet, profiles, lines] = await Promise.all([
      tenantsRepository.findCurrent(tx),
      outletsRepository.findOutlet(tx, header.outletId),
      printRepository.findProfilesForOutlet(tx, header.outletId),
      creditNotesRepository.findLines(tx, id) as Promise<PrintLineRow[]>,
    ]);
    if (!tenant) throw new NotFoundError('Tenant');
    if (!outlet) throw new NotFoundError('Outlet');

    const resolved = foldProfiles(profiles);
    const template = pickTemplate(resolved, query.template);
    const copyIndex = query.copyIndex ?? 0;
    assertCopyIndex(template, copyIndex);

    const context = await printRepository.findContext(tx, header.issuedBy, header.counterId);
    const customFields = await resolveCustomFields(tx, 'credit_note', header.customFields);

    const input: ResolveInput = {
      kind: 'credit_note',
      documentNumber: header.documentNumber,
      documentDate: String(header.documentDate),
      issuedAt: header.issuedAt,
      taxMode: header.taxMode,
      isInterState: header.supplyType === 'inter_state',
      business: buildBusiness(outlet, tenant),
      profile: resolved.profile,
      customer: await loadCustomer(
        tx,
        header.customerId,
        header.customerName,
        header.customerGstin,
      ),
      lines: lines.map((line) => ({
        name: line.itemName,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        hsnCode: line.hsnCode,
        taxRatePercent: Number(line.taxRatePercent),
        // Credit note lines carry no bill-discount share: a return is priced
        // from the original line, which already absorbed it.
        discount: line.lineDiscount,
        lineTotal: line.lineTotal,
      })),
      totals: {
        grossAmount: header.grossAmount,
        totalDiscount: header.lineDiscountTotal + header.billDiscountAmount,
        taxableAmount: header.taxableAmount,
        totalCgst: header.totalCgst,
        totalSgst: header.totalSgst,
        totalIgst: header.totalIgst,
        totalCess: header.totalCess,
        charges: 0,
        roundOff: header.roundOff,
        grandTotal: header.grandTotal,
        // Money actually handed back. The remainder shows as credited to
        // khata, which is what `resolvePrintDocument` prints for the gap.
        amountPaid: header.refundAmount,
      },
      taxRows: toTaxRows(header.taxSummary),
      tenders:
        header.refundMode === 'khata' || header.refundAmount === 0
          ? []
          : [{ mode: header.refundMode, amount: header.refundAmount, tenderedAmount: null }],
      customFields,
      template,
      timezone: tenant.timezone,
      currencySymbol: tenant.currencySymbol,
      copyIndex,
      originalDocumentNumber: header.originalDocumentNumber,
      cashierName: context?.cashierName ?? null,
      counterName: context?.counterName ?? null,
      notes: header.notes,
    };

    return resolvePrintDocument(input);
  });
}

// ---------------------------------------------------------------------------
// Payment receipt
// ---------------------------------------------------------------------------

/**
 * A khata collection slip.
 *
 * Payments carry no series or document number — `payment_receipt` exists in
 * the `document_series` enum but nothing issues against it yet — so the
 * receipt is identified by a stable short form of the payment's own id. It is
 * unique, it reprints identically, and it is honest about being an internal
 * reference rather than a numbered legal document. Giving receipts a real
 * series is a schema change, and belongs with whichever milestone decides
 * receipts need one.
 */
function receiptNumber(paymentId: string): string {
  return `RCPT-${paymentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function buildPaymentReceiptPayload(
  id: string,
  query: PrintPayloadQuery,
): Promise<PrintDocument> {
  return withReadTransaction(async (tx) => {
    const payment = await paymentsRepository.find(tx, id);
    if (!payment) throw new NotFoundError('Payment');
    assertOutletAccess(payment.outletId);

    const [tenant, outlet, profiles, settings] = await Promise.all([
      tenantsRepository.findCurrent(tx),
      outletsRepository.findOutlet(tx, payment.outletId),
      printRepository.findProfilesForOutlet(tx, payment.outletId),
      tenantsRepository.getSettings(tx),
    ]);
    if (!tenant) throw new NotFoundError('Tenant');
    if (!outlet) throw new NotFoundError('Outlet');

    const resolved = foldProfiles(profiles);
    const template = pickTemplate(resolved, query.template);
    const copyIndex = query.copyIndex ?? 0;
    assertCopyIndex(template, copyIndex);

    const context = await printRepository.findContext(tx, payment.receivedBy, null);
    const customer = payment.customerId
      ? await printRepository.findCustomerDetails(tx, payment.customerId)
      : undefined;
    const customerName = payment.customerId
      ? ((
          await tx.one<{ name: string }>('SELECT name FROM customers WHERE id = $1', [
            payment.customerId,
          ])
        )?.name ?? null)
      : null;

    const receivedAt = payment.receivedAt.toISOString();
    const input: ResolveInput = {
      kind: 'payment_receipt',
      documentNumber: receiptNumber(payment.id),
      documentDate: receivedAt.slice(0, 10),
      issuedAt: receivedAt,
      // A receipt acknowledges money, not a supply, so it carries no tax
      // whatever the business's registration — but the title still has to be
      // right, and that comes from the mode.
      taxMode: settings.isGstRegistered
        ? settings.isComposition
          ? 'composition'
          : 'gst'
        : 'non_gst',
      isInterState: false,
      business: buildBusiness(outlet, tenant),
      profile: resolved.profile,
      customer: customerName
        ? {
            name: customerName,
            phone: customer?.phone ?? null,
            gstin: null,
            addressLines: compact([
              customer?.addressLine1,
              customer?.addressLine2,
              [customer?.city, customer?.pincode].filter(Boolean).join(' '),
            ]),
            stateName: stateNameFor(customer?.stateCode),
          }
        : null,
      lines: [],
      totals: {
        grossAmount: payment.amount,
        totalDiscount: 0,
        taxableAmount: 0,
        totalCgst: 0,
        totalSgst: 0,
        totalIgst: 0,
        totalCess: 0,
        charges: 0,
        roundOff: 0,
        grandTotal: payment.amount,
        amountPaid: payment.amount,
      },
      taxRows: [],
      tenders: [
        { mode: payment.mode, amount: payment.amount, tenderedAmount: payment.tenderedAmount },
      ],
      customFields: [],
      template,
      timezone: tenant.timezone,
      currencySymbol: tenant.currencySymbol,
      copyIndex,
      cashierName: context?.cashierName ?? null,
      notes: payment.reference,
    };

    return resolvePrintDocument(input);
  });
}

/** `tax_summary` is stored as the engine produced it; only the field names differ. */
function toTaxRows(summary: unknown) {
  if (!Array.isArray(summary)) return [];
  return summary.map((row: Record<string, unknown>) => ({
    taxRatePercent: Number(row['taxRatePercent'] ?? 0),
    taxableAmount: Number(row['taxableAmount'] ?? 0),
    cgst: Number(row['cgst'] ?? 0),
    sgst: Number(row['sgst'] ?? 0),
    igst: Number(row['igst'] ?? 0),
    cess: Number(row['cess'] ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Configuration: print profiles
// ---------------------------------------------------------------------------

export function listPrintProfiles() {
  return withReadTransaction(async (tx) => {
    const rows = await printRepository.listProfiles(tx);
    return { profiles: rows, templates: Object.values(TEMPLATES) };
  });
}

/** `outletId` is null for the tenant-wide default. Upsert: a profile is settings, not a record. */
export function upsertPrintProfile(outletId: string | null, body: UpsertPrintProfileBody) {
  return withTransaction(async (tx) => {
    if (outletId) {
      assertOutletAccess(outletId);
      if (!(await outletsRepository.findOutlet(tx, outletId))) throw new NotFoundError('Outlet');
    }

    const existing = await printRepository.findProfile(tx, outletId);
    if (existing) {
      await printRepository.updateProfile(tx, existing.id, body);
    } else {
      await printRepository.insertProfile(tx, {
        id: randomUUID(),
        outletId,
        templateKey: body.templateKey ?? FALLBACK_TEMPLATE,
        showHsn: body.showHsn ?? null,
        showTaxColumn: body.showTaxColumn ?? null,
        showTaxSummary: body.showTaxSummary ?? null,
        showAmountInWords: body.showAmountInWords ?? null,
        showSignature: body.showSignature ?? null,
        logoObjectKey: body.logoObjectKey ?? null,
        signatureObjectKey: body.signatureObjectKey ?? null,
        signatureLabel: body.signatureLabel ?? null,
        upiId: body.upiId ?? null,
        bankLines: body.bankLines ?? [],
        termsLines: body.termsLines ?? [],
        footerLines: body.footerLines ?? [],
        lookupBaseUrl: body.lookupBaseUrl ?? null,
      });
    }

    await recordAudit(tx, {
      action: 'print_profile.saved',
      entityType: 'print_profile',
      entityId: existing?.id ?? null,
      metadata: { outletId },
    });

    const saved = await printRepository.findProfile(tx, outletId);
    if (!saved) throw new NotFoundError('Print profile');
    return saved;
  });
}

// ---------------------------------------------------------------------------
// Configuration: custom field definitions
// ---------------------------------------------------------------------------

export function listCustomFields(includeInactive: boolean) {
  return withReadTransaction((tx) => printRepository.listDefinitions(tx, includeInactive));
}

export function createCustomField(body: CreateCustomFieldBody) {
  return withTransaction(async (tx) => {
    const id = randomUUID();
    await printRepository.insertDefinition(tx, {
      id,
      key: body.key,
      label: body.label,
      dataType: body.dataType,
      isRequired: body.isRequired,
      sortOrder: body.sortOrder,
      documentTypes: body.documentTypes,
      maxLength: body.maxLength ?? null,
      placeholder: body.placeholder ?? null,
    });
    await recordAudit(tx, {
      action: 'custom_field.created',
      entityType: 'custom_field_definition',
      entityId: id,
      metadata: { key: body.key },
    });
    const created = await printRepository.findDefinition(tx, id);
    if (!created) throw new NotFoundError('Custom field');
    return created;
  });
}

/**
 * The key is deliberately not updatable: it is already written into issued
 * documents, and renaming it would orphan every one of them.
 */
export function updateCustomField(id: string, body: UpdateCustomFieldBody) {
  return withTransaction(async (tx) => {
    const existing = await printRepository.findDefinition(tx, id);
    if (!existing) throw new NotFoundError('Custom field');
    await printRepository.updateDefinition(tx, id, body);
    await recordAudit(tx, {
      action: 'custom_field.updated',
      entityType: 'custom_field_definition',
      entityId: id,
      metadata: { key: existing.key },
    });
    const updated = await printRepository.findDefinition(tx, id);
    if (!updated) throw new NotFoundError('Custom field');
    return updated;
  });
}

export function deleteCustomField(id: string): Promise<void> {
  return withTransaction(async (tx) => {
    const existing = await printRepository.findDefinition(tx, id);
    if (!existing) throw new NotFoundError('Custom field');
    await printRepository.softDeleteDefinition(tx, id);
    await recordAudit(tx, {
      action: 'custom_field.deleted',
      entityType: 'custom_field_definition',
      entityId: id,
      metadata: { key: existing.key },
    });
  });
}

export type { CustomFieldDefinitionRow };
