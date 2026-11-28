/**
 * HSN/SAC on a GST invoice (Notification 78/2020-CT, with Rule 46).
 *
 *   preceding FY aggregate turnover up to ₹5 crore
 *     B2B (buyer has a GSTIN)   every line: an HSN of at least 4 digits
 *     B2C                       optional; if given, at least 4 digits
 *   above ₹5 crore              every line, B2B and B2C: at least 6 digits
 *
 * The app checks this before a bill is saved (it bills offline), and the
 * server checks it again here, so a bill sent straight to the API, or from an
 * older app, cannot become a B2B tax invoice without HSN.
 *
 * The threshold comes from the published GST rule set; when none is
 * published or it has no figure, the notified ₹5 crore is used, so a missing
 * rule set never blocks billing.
 */
import {
  hsnRequirement,
  resolvedTurnover,
  statutoryFyStartYear,
  type EntityFacts,
  type HsnRequirement,
} from '../../domain/gst/entity.js';
import { selectRuleSet, type GstRuleSet, type IsoDate } from '../../domain/gst/rule-set.js';
import type { Tx } from '../../db/tx.js';
import { ErrorCode, UnprocessableError } from '../../lib/errors.js';
import { gstRepository } from '../gst/gst.repository.js';

/** ₹5 crore, in paise: Notification 78/2020-CT. */
export const HSN_6_DIGIT_TURNOVER_PAISE = 5_00_00_000 * 100;

export interface HsnLine {
  readonly id: string;
  readonly name: string;
  readonly hsnCode: string | undefined;
}

/** The lines that do not meet [requirement], each with what is wrong. */
export function hsnShortfalls(
  lines: readonly HsnLine[],
  requirement: HsnRequirement,
): { lineId: string; itemName: string; hsnCode: string | null }[] {
  const out: { lineId: string; itemName: string; hsnCode: string | null }[] = [];
  for (const line of lines) {
    const code = line.hsnCode?.trim() ?? '';
    if (code === '') {
      if (requirement.mandatory) out.push({ lineId: line.id, itemName: line.name, hsnCode: null });
      continue;
    }
    if (!/^\d+$/.test(code) || code.length < requirement.minDigits) {
      out.push({ lineId: line.id, itemName: line.name, hsnCode: code });
    }
  }
  return out;
}

/** What the law asks of this bill's lines, from this business's turnover. */
export async function hsnRequirementFor(
  tx: Tx,
  documentDate: IsoDate,
  buyerClass: 'b2b' | 'b2c',
): Promise<HsnRequirement> {
  const entity: EntityFacts = {
    exemptionCategory: 'none',
    turnover: await gstRepository.turnoverRecords(tx),
  };
  try {
    const versions = await tx.many<GstRuleSet>(
      `SELECT version, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", revision,
              supersedes, status, content
         FROM gst_rule_sets WHERE status = 'published'`,
    );
    return hsnRequirement(entity, documentDate, buyerClass, selectRuleSet(documentDate, versions));
  } catch {
    // No usable rule set: the notified threshold, same rule.
    const preceding = resolvedTurnover(entity, statutoryFyStartYear(documentDate) - 1);
    if (preceding !== null && preceding > HSN_6_DIGIT_TURNOVER_PAISE) {
      return { mandatory: true, minDigits: 6 };
    }
    return { mandatory: buyerClass === 'b2b', minDigits: 4 };
  }
}

/** Refuses a GST invoice whose lines lack the HSN the law requires. */
export async function assertHsnOnInvoice(
  tx: Tx,
  input: {
    readonly documentDate: IsoDate;
    readonly buyerHasGstin: boolean;
    readonly lines: readonly HsnLine[];
  },
): Promise<void> {
  const buyerClass = input.buyerHasGstin ? 'b2b' : 'b2c';
  const requirement = await hsnRequirementFor(tx, input.documentDate, buyerClass);
  const lines = hsnShortfalls(input.lines, requirement);
  if (lines.length === 0) return;
  throw new UnprocessableError(
    buyerClass === 'b2b'
      ? `This bill is to a GST-registered customer, so every item needs an HSN/SAC code of at least ${requirement.minDigits} digits.`
      : `Every item on this bill needs an HSN/SAC code of at least ${requirement.minDigits} digits.`,
    ErrorCode.HSN_REQUIRED,
    { details: { minDigits: requirement.minDigits, lines } },
  );
}
