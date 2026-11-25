# BillBanao GST Phase 2 Gap Analysis: ITC, Amendments, Advances, E-commerce, Composition, Closing Stock

**Revision 5, 25 Nov 2026.** Research report approved 25 Nov 2026. Nothing here is implemented yet. Open data items are tracked in `GST_PENDING.md` §1; this file explains why each one matters.

**Evidence labels:**
- **[V-doc]** verified in a repo file (path given).
- **[2nd]** secondary sources only.
- **[UNVERIFIED]** not confirmed.

## Context
- Phase 1 (14 Nov 2026) shipped seven modules: GSTR-1, GSTR-2B, GSTR-3B, GSTR-9, the GST Transaction Report, Sales Summary by HSN and the SAC Report.
- Phase 2 asked for ITC, "GSTR-9A/10 + amendments", "GSTR-11A/11B advances" and "GSTR-14/15 e-commerce". Each one was to be checked against official sources, with an exact list of the official data still needed.
- Sources read in full for this report:
  - the code (read-only audit, 24 Nov 2026)
  - `data/` (schemas, offline tools, `advisory/`)
  - `docs/gst/`: consolidated Act and Rules; Finance Acts 2017–2026; Central Tax notifications 2023 (1–56), 2024 (1–31), 2025 (1–20) and 2026 (01–07); 66/2017, 17/2017-CT(Rate), 14/2019, 16/2020, 52/2018, 26/2022 and IGST 01/2024; circulars; instructions; forms

**Revision 5 changes** (after 17/2017-CT(Rate), 14/2019-CT and 16/2020-CT were added):
- **Rule 43 "Tr" is a gap in the official text, not in our copy.** 16/2020-CT omits clause (f), which defined Tr, and does not amend clause (g), which still uses it. Tm is the only per-period common-credit amount left in the rule, so the engine will compute with Tm. This is recorded as an assumption in `GST_PENDING.md` §3, pending a CBIC clarification.
- **Composition threshold:** ₹1.5 crore (₹75 lakh in the eight listed States) from 01.04.2019 [V-doc: 14/2019-CT]. That is below the ₹2 crore annual-return exemption, so the GSTR-9A verdict is confirmed.
- **s.9(5) services list:** the repo copy of 17/2017-CT(Rate) is the original 28.06.2017 text only. It covers passenger transport (radio-taxi, motorcab, maxicab, motor cycle) and accommodation. It does not include later additions such as restaurant services and housekeeping. Those amending notifications are still missing, so Table 14(b) can only be built for the two original categories.

---

## 0. Verdict on the requested items

| Requested | What it actually is | Applies? |
|---|---|---|
| **ITC** | s.16–18, Rules 36–45 and 47A, plus Rule 88D (3B ITC above 2B → DRC-01C) [V-doc: 38/2023]. ITC is allowed only up to what 2B shows (s.16(2)(aa), from 01.01.2022). The s.34(2) recipient-reversal proviso has been in force since 01.10.2025. The discount credit-note change (s.15(3)(b)) has been in force since 01.11.2026 [V-doc: 03/2026]. | **Mandatory.** Biggest gap. |
| **GSTR-9A** | Rule 80(1) still prescribes GSTR-9A for composition taxpayers; nothing up to Nov 2026 removes it [V-doc: 2022 Rules plus all 2023–26 notifications]. **But** every s.44 annual return is exempt for aggregate turnover up to ₹2 crore (FY 22-23: 32/2023; FY 23-24: 14/2024; FY 24-25 onwards: 15/2025), and composition is capped at ₹1.5 crore (14/2019-CT). Earlier years are time-barred (s.44(2), from 01.10.2023). | **Not needed in practice.** Filing is optional. Not built. |
| **GSTR-4 + CMP-08** | Mandatory for composition taxpayers: CMP-08 quarterly by the 18th; GSTR-4 annually by 30 June from FY 24-25 [V-doc: Rules, 12/2024]. Forms gain a separate row for supplies through an e-commerce operator (ECO) under s.9(5), from 01.11.2026 [V-doc: 05/2026]. Composition dealers may sell goods through an ECO from 01.10.2023 (FA 2023 s.137), and the ECO collects TCS from them (36/2023). The official GSTR-4 offline utility (v3.3, the latest published) still covers only the old quarterly form, and there is no CMP-08 tool. | **Required** (Q1). Output is an Excel working paper for portal entry. |
| **GSTR-10** | s.45 and Rules 44/81. Rule 44 sets how closing-stock ITC is computed [V-doc]. From 01.12.2026 the reversal can be declared in REG-16 Table 10 instead [V-doc: 05/2026]. Filed online only [V-doc: manual]. | **Rare but mandatory.** Build one closing-stock ITC statement. |
| **Amending filed invoices** | **GSTR-1A** for the same period before 3B: optional, no late fee, recipient GSTIN can't be changed [V-doc: 12/2024]. Otherwise **amendment tables in a later GSTR-1** [V-doc: GSTR-1 manual]. Deadline is 30 Nov after the FY ends (s.37(3)). GSTR-1 can't be filed more than 3 years after its due date (s.37(5), from 01.10.2023). | **Mandatory.** |
| **"GSTR-11A/11B"** | Wrong name; GSTR-11 is the return for UIN holders [2nd]. The real requirement is **GSTR-1 Tables 11A/11B** (one flat list per place of supply and rate, with a 65% flag), plus receipt and refund vouchers under Rules 50/51 [V-doc]. Goods advances are not taxed for non-composition taxpayers (66/2017; actionable claims excluded by 50/2023) [V-doc]. | **Mandatory for services.** For composition advances, the s.12 text applies (66/2017 does not cover them). |
| **"GSTR-14/15"** | These forms don't exist. The real requirement is **GSTR-1 Table 14/14A** [V-doc: 26/2022, advisory]. GSTR-8 is the operator's return, not the seller's. TCS is 0.25% CGST + 0.25% SGST, or 0.5% IGST, from 10.07.2024 [V-doc: 15/2024-CT, 01/2024-IT]. | **14(a)/(b) mandatory** for marketplace and s.9(5) sellers. |

---

## 1. Existing architecture (code audit, 24 Nov 2026)

**Backend:**
- Line-level engines `domain/gst/returns/*-engine.ts` feed a neutral model.
- Mappers are versioned through `data/gstn-schemas/registry.json`. GSTR-1 and 3B are `schema_verified`; GSTR-9 is a draft.
- Periods go `open → prepared → filed`.
- 2B import plus a 3-pass matcher.
- `LedgerSource` for imported ledgers.
- `itc_register`, one row per bill.
- `corrections.ts` refuses a void after GSTR-1 is filed.

**Flutter:** read-only ITC register; 2B match acceptance; purchase ITC category (4 values) and RCM switch.

**Frozen but unbuilt:** A6, A7 and B5. The ITC enums and ECO columns exist but nothing writes to them.

### Defects (fix first)
1. **Filing doesn't lock the period.** The lock tables are unused, and the trigger still lets filed `workings`/`status` change.
2. **3B Table 4 ignores claim state and period** (`returns.service.ts:97-127`). `missing_in_2b` rows are still counted, which conflicts with s.16(2)(aa) and Rule 88D. 4(A)(4), 4(B)(2) and 4(D) are always zero.
3. **Some loaders don't filter by GSTIN** (`inwardReverseCharge`, `inwardExempt`, 2B `bookInvoices`). RCM is placed by `document_date`, but from 01.11.2024 the tax point is the self-invoice date (s.13(3)(c)).
4. **The 2B matcher ignores `document_type`.** Purchase debit notes are not loaded.
5. **An empty GSTIN can be written to `itc_register`** (`purchases.service.ts:425`, `debit-notes.service.ts:305`).
6. **ITC is tracked per bill, not per line.** BOE and receipt dates are never written.
7. **No API sets the ECO columns.**
8. **An advance can't be allocated to an invoice later.**
9. **No post-filing guard on purchase bills or debit notes.**
10. **B2CL threshold is a flat ₹2.5 lakh.** It has been ₹1 lakh from 01.08.2024 [V-doc: 12/2024].
11. **GSTR-9 is presented as mandatory for every tenant.** It is optional at or below ₹2 crore [V-doc: 15/2025].
12. **The rule set should also date** the e-invoicing threshold of ₹5 crore from 01.08.2023 (10/2023) and the RCM e-invoicing start of 01.01.2027 (04/2026), for the future B3 milestone.
13. **No time-bar warning.** Nothing warns when a period's GSTR-1, 3B or 9 is more than 3 years past its due date (s.37(5), 39(11), 44(2)).

---

## 2. Legal status table (all [V-doc]; rule sets must be dated from this)

| Change | Provision | In force | Source |
|---|---|---|---|
| ITC only up to what 2B shows | s.16(2)(aa) | 01.01.2022 | Act; Circ. 193 |
| Rule 37A (supplier didn't file 3B → reverse by 30 Nov); Rule 88C; Tables 14/15 inserted into GSTR-1 | Rules | 26.12.2022 (tables live from Jan-2024 period) | 26/2022; advisory |
| Composition dealers may sell goods through an ECO; ECO collects TCS from them | s.10(2)(d), (2A)(c); 36/2023 | 01.10.2023 | FA 2023 s.137; 28/2023 |
| Rule 37 non-payment: pay with s.50 interest | s.16(2) 2nd/3rd proviso | 01.10.2023 | FA 2023 s.138 |
| CSR inputs blocked; Sch. III para 8(a) counts in exempt value | s.17(5)(fa), s.17(3) Expl.; Rule 43 Expl. 3 | 01.10.2023 | FA 2023 s.139; 38/2023 |
| **3-year bar** on GSTR-1 / returns / annual return / TCS statement | s.37(5), 39(11), 44(2), 52(15) | 01.10.2023 | FA 2023 s.142-145; 28/2023 |
| Rule 88D: 3B ITC above 2B → DRC-01C; GSTR-1 blocked until resolved (Rule 59(6)(e)) | Rules 88D, 59(6)(e) | 04.08.2023 | 38/2023 |
| E-invoicing threshold ₹5 crore | 13/2020 | 01.08.2023 | 10/2023 |
| GSTR-1A; B2CL threshold ₹1 lakh; new GSTR-2B (Table 5 Rule 37A → 4(B)(2); Table 4 → 4(D)(2)) | Rule 59, forms | 10.07.2024 / 01.08.2024 | 12/2024 |
| TCS 0.25% CGST / 0.5% IGST | s.52 | 10.07.2024 | 15/2024-CT; 01/2024-IT |
| s.16(5)/(6) ITC time-limit relief | s.16 | 27.09.2024 (retrospective to 1.7.2017) | FA(2) 2024 s.118; 17/2024 |
| RCM tax point = self-invoice date; self-invoice within 30 days (Rule 47A); 17(5)(i) narrowed | s.13(3)(c), 31(3)(f), 17(5)(i) | 01.11.2024 | FA(2) 2024; 17/2024; 20/2024 |
| GSTR-3B Table 6.1 split (RCM + 9(5)) | form | 11.02.2025 | 09/2025 |
| ISD regime; GSTR-8 split into registered/unregistered | s.2(61), s.20, Rule 39 | 01.04.2025 | 16/2024; 09/2025 |
| Voucher time-of-supply provisions omitted; "plant and machinery" | s.12(4), 13(4), 17(5)(d) | 01.10.2025 | FA 2025; 16/2025 |
| **Recipient reverses ITC before the supplier's credit-note reduction**; s.38/39 IMS enablers | s.34(2), 38, 39(1) | **01.10.2025** | FA 2025 s.126-128; 16/2025 |
| GSTR-9 overhaul (6A1/6A2, 7A1/7A2, 8H1, Table 9) | form | 22.09.2025 | 13/2025 |
| GSTR-9 (and 9A) exempt up to ₹2 crore | s.44 | FY 22-23 / 23-24 / 24-25 onwards | 32/2023; 14/2024; 15/2025 |
| **Discount credit note needs recipient ITC reversal; s.34(1); s.54 refunds** | s.15(3)(b), 34(1), 54 | **01.11.2026** | FA 2026 s.153-155; 03/2026 |
| Composition/CMP-08/GSTR-4 tables split out s.9(5); Rule 62(5); cancellation rules | Rules 20, 21, 62 | 01.11.2026 | 05/2026 |
| Rule 44 change; REG-16 Table 10 stock reversal | Rule 44 | 01.12.2026 | 05/2026 |
| E-invoicing for RCM inward supplies from unregistered persons and import of services | 13/2020 | 01.01.2027 | 04/2026 |
| FA 2025 s.121(i), s.125 | s.2(61)/s.20 IGST ref | not separately notified; 13/2025 applies Rule 39(1A) from 01.04.2025 | — |

**How current law is built.** The consolidated Act (India Code, last updated 28.09.2022) and Rules (last updated 26.12.2022) are stale [V-doc]. The repo now holds every amending instrument after them: Finance Acts 2023–2026 and the 2023–2026 notifications. Current text is therefore **the base text plus a traced chain of amendments**.

**Exception, Rule 43(1)(g):** the formula still refers to `Tr` even though clause (f) was omitted in 2020. Needs 16/2020-CT, or an official up-to-date copy, before it is coded.

---

## 3. Requirements by feature

**ITC (A7)**
- **Conditions:** s.16 conditions; the 17(5) list including (fa) CSR; circulars 262 and 265.
- **Reversals:**
  - Rule 37: 180 days unpaid, pay with interest, re-avail on payment.
  - Rule 37A: from the September 2B Table 5.
  - Rules 42/43: common credit.
  - Rule 44: closing stock.
  - Rule 38: banks only.
- **Rule 88D guard:** warn before 3B ITC goes above 2B. The DRC-01C reason codes (Rule 37/37A reclaims, prior-period instalments, imports, SEZ) are exactly the legitimate causes of a 3B-above-2B difference, so use them as structured reason codes.
- **RCM:** Rule 47A self-invoice within 30 days, tax point on the self-invoice date, IRN-ready for 01.01.2027.
- **IMS:**
  - Legal basis is s.38/39 and the s.34(2) proviso, from 01.10.2025.
  - Upload/download JSON taken from the IMS Utility v2.0 macros [V-doc]:
    - upload: `{rtin, reqtyp:"SAVE", invdata:{b2b,b2ba,b2bdn,b2bdna,b2bcn,b2bcna,ecom,ecoma}}`
    - actions N/A/R/P
    - `itcRedReq` plus `declIgst`/`declCgst`/`declSgst`/`declCess` only on accepted credit notes and downward amendments
    - download root `imsDetails`
  - Rules on pending limits, deemed acceptance and 3B blocking are **[UNVERIFIED]**; no official IMS document is in the repo. Build them as warn-only rule-set data until confirmed.
- **Credit notes:** carry the recipient-reversal status. Both s.34(2) (01.10.2025) and s.15(3)(b) discount notes (01.11.2026) make it mandatory.

**Amendments / GSTR-1A (A6):** fully specified by Rule 59(4A), the Form GSTR-1A, the GSTR-1 manual and s.37(3)/(5). Output is export only (Q2).

**Advances:**
- s.31(3)(d)/(e) and Rules 50/51. Rule 50 defaults: rate unknown → 18%; nature unknown → treat as inter-State.
- Services only for regular taxpayers (66/2017).
- Table 11 is net of refund vouchers (26/2022).
- **Open conflict:** the GSTR-1 Save schema's `at`/`txpd` and `supeco.clttx` layouts don't match the manual, the GSTR-1A form, Offline Tool 3.2.4 and its CSVs. Follow the Offline Tool and verify with a tool-generated JSON (§4.3).

**E-commerce**
- **Table 14(a):** per operator GSTIN; supplies are still reported in Tables 4–10; not auto-filled into 3B.
- **Table 14(b):** goes to 3B 3.1.1(ii). These supplies are excluded from Tables 4/5/8 [V-doc: 26/2022 instructions].
- **14A:** an amendment can be made once.
- Also GSTR-9 4G1/5C1, plus the composition s.9(5) row.
- **Composition tenants selling via an ECO** (allowed from 01.10.2023) carry TCS. Reconcile it from marketplace imports (Q3).
- **The s.9(5) services list:** 17/2017-CT(Rate) as originally issued covers passenger transport and accommodation only; the later amendments are still needed (4.2 #1).

**Composition (GSTR-4 + CMP-08)**
- CMP-08 tax is paid from cash.
- GSTR-4 needs invoice-wise inward supplies and consolidated outward supplies (Rule 62(3)), using the 05/2026 table layout.
- Output is an Excel/CA working paper; there is no tool JSON.

**Closing stock (Rule 44):**
- Inputs: proportionate to the invoices they came from.
- Capital goods: remaining months / 60.
- Where no invoice exists: market price, certified by a CA or CMA.
- Feeds GSTR-10 Table 8, ITC-03 or REG-16 Table 10.

---

## 4. Official data

### 4.1 Held (do not download again)
**`docs/gst/`:**
- `acts/` and `rules/`: consolidated, but stale (2022)
- `finance_act/`: 2017–2026
- `notification/2017` (66/2017; 17/2017-CT(Rate) original; `download-1.pdf` is 17/2017-*Central Tax*, an unrelated rules amendment), `/2019` (14/2019, composition threshold), `/2020` (16/2020), `/2018` (52/2018), `/2022` (26/2022), `/2023` (1–56), `/2024` (1–31), `/2025` (1–20), `/2026` (01–07 plus the 05 corrigendum), `/IGST` (01/2024)
- `circular/`: 193/2023, 255–266/2026
- `instruction/`: 01–02/2026
- `form/`: ITC-01/02/02A/03/04, TRAN-1/2
- statute `.txt` files

**`data/`:**
- GSTN schemas: GSTR-1, 2B, 3B, 9, ledgers
- Returns Offline Tool 3.2.4 with the GSTR-1 V2.2 template and CSVs
- 3B utility V5.8, GSTR-9 tool v2.2, IMS utility v2.0, ITC-01 v1.3, ITC-04 v2.15, GSTR-4 utility v3.3 (quarterly-era; the latest published)
- GSTR-1A FAQ
- `advisory/` (GSTR-1 manual, GSTR-10 manual, GSTR-8 FAQ, Table 14 help, 14/15 advisory)
- CBIC rate notifications and HSN

**Housekeeping (your call):**
- `data/gst_offline_tool/` is a duplicate of `gst_returns_offline_tool/`.
- The `docs/gst/notification/` root still holds duplicates of the 05/2026 corrigendum and 06/07-2026.
- `docs/gst/notification/grep.exe.stackdump` is a tool crash dump and can be deleted.

### 4.2 Official documents still needed (all P = public)
| # | Item | Why | Blocks |
|---|---|---|---|
| 1 | **Every notification amending 17/2017-CT(Rate)** (the original is held). For example, the ones adding restaurant and housekeeping services; the numbers need confirming on the CBIC portal. | Complete s.9(5) services list | E-commerce 14(b) beyond passenger transport and accommodation |
| 2 | ~~16/2020-CT~~ **received.** It confirms the `Tr` gap is in the official text. A CBIC clarification or FAQ on Rule 43(1)(g) would settle it; until then the engine assumes `Tm`. | Rule 43(1)(g) | Not blocking (assumption recorded) |
| 3 | ~~14/2019-CT~~ **received** (₹1.5 crore). Optional: the composition threshold for services under s.10(2A) (2/2019-CT(Rate)) | Composition eligibility checks | Nice to have |
| 4 | **IMS manual/FAQs/advisories; GSTR-2B manual; advisory #389 + ECRRS/RCM statement advisories; 3B auto-population/hard-lock advisories; 3-year-bar advisory; layout note for `at`/`txpd`/`supeco`; GSTR-4 annual + CMP-08 manuals** | Portal behaviour (not law) | Only IMS hard rules and 3B pre-fill; built as warn-only meanwhile |

Item 4 is not available yet and is tracked in `GST_PENDING.md` §1.

### 4.3 Samples (G: your portal or tools); not available yet, tracked in GST_PENDING
1. Real 2B JSONs, including a September 2B with Table 5.
2. IMS download plus the utility output JSON.
3. ECRRS/RCM statement exports.
4. An Offline Tool 3.2.4 JSON with 11A, 11B, 14(a), 14(b) and a 9A amendment.
5. Already pending: 3B utility JSON, GSTR-9 tool JSON, ledger files.

**Without these,** the mappers stay `schema_checked_mapping_unverified` and exports are marked draft, the same policy as GSTR-9 today.

### 4.4 GSP APIs: deferred (Q2)
### 4.5 Marketplace reports (Q3): not available yet, tracked in GST_PENDING
Amazon MTR B2B/B2C, Flipkart sales/tax report, and any others. **Marketplace import is blocked until samples exist.** Manual channel and operator-GSTIN tagging ships first.

---

## 5. Missing schemas (summary)
- **GSTR-1A:** no schema; export only.
- **IMS:** format known; ECO/ECOA keys to re-extract in P0.
- **Ledgers:** no credit-ledger or RCM-statement schema.
- **GSTR-4 annual / CMP-08:** no tool; Excel output.
- **GSTR-10:** report only.
- **Samples:** none.
- **`base.json`:**
  - `gstr1aAmendableFields`: encodable now.
  - `blockedCredits`: draftable from s.17(5) and FA 2023/2024/2025.
  - s.9(5) list: the two original categories are encodable now; the rest needs item 1.

---

## 6. Architecture and database changes (reuse first)
- **P0, cross-cutting:**
  - Filing writes `gst_period_lock_events` and `gstr*_locked_through`; a trigger refuses edits to filed rows.
  - Append-only `gst_return_snapshots` (with `supersedes_id`); owner-only, audited reopen.
  - Purchase guards.
  - Defects 3–5 and 9–13.
  - Rule-set dating from section 2.
- **ITC (A7):**
  - **New data:** line-level ITC columns (category, status, 17(5) code) and new tables `itc_movements` (append-only), `ims_actions` (exported as utility JSON), `gst_statement_balances` and `rcm_self_invoices`.
  - **Wire up:** BOE/receipt dates, and `supplier_payment_allocations` for Rule 37.
  - **Engine:** pure `itc-engine.ts` → 3B Table 4 by claimed period, plus the Rule 88D pre-check → GSTR-9 Tables 6–8.
  - **Credit notes:** `recipient_itc_reversal_status`.
  - **Reuse:** `parse-2b.ts`, `reconcile.ts`, `LedgerSource`, rule-set `blockedCredits`.
- **Amendments/GSTR-1A (A6):**
  - Amendment records reference the original document; nothing is edited in place.
  - The engine emits the amendment sections.
  - New `gstr1a` return type, exported as Excel/CA.
  - Reuse `correctionRoute`.
- **E-commerce:**
  - API and form for `sales_channel`/`eco_gstin`, plus an operator master.
  - `eco_liability` taken from the rule set.
  - Outputs: `supeco`, 3B `eco_dtls`, GSTR-9 4G1/5C1, the composition s.9(5) row.
  - Later: `marketplace_imports` with versioned parsers.
- **Advances:**
  - `receipt_vouchers`/`refund_vouchers` (number families already reserved) and `advance_adjustments`.
  - Endpoint to allocate an advance later.
  - Outputs: `at`/`txpd` (Offline Tool layout), 3B 3.1(a), GSTR-9 4F, Table 13.
- **Composition:**
  - `cmp08`/`gstr4` return types (new migration; 0049 stays).
  - `composition-engine.ts` reusing `composition.ts`.
  - Excel/CA output.
- **Closing stock:**
  - `registration_cancellations`.
  - Rule 44 computation.
  - Report for GSTR-10/ITC-03/REG-16.

---

## 7. Sequence (order confirmed under Q5)
| # | Pri | Work | Status of inputs |
|---|---|---|---|
| 0 | P0 | Read remaining `/data` items (GSTR-1 TXP/SUPECO/ECOM sheets, 2B ITCREV sheet, 09/2026-CT(R), IMS ECO keys). Defects, locks, snapshots, dated rule set. | **Ready** |
| 1 | P1 | ITC engine | **Ready on law.** Rule 43 uses `Tm` (recorded assumption). IMS hard rules are warn-only. Mappers are draft until 4.3 #1–3. |
| 2 | P1 | Amendments + GSTR-1A | **Ready** (verify with 4.3 #4) |
| 3 | P2 | E-commerce (14(a) now; 14(b) after 4.2 #1); marketplace import after 4.5 | Partly ready |
| 4 | P2 | Advances + vouchers | **Ready.** Table 11 JSON is draft until 4.3 #4. |
| 5 | P3 | GSTR-4 + CMP-08 (Excel) | **Ready on law** |
| 6 | P3 | Closing-stock statement | **Ready** |
| — | — | Not built: GSTR-9A (exempt in practice), GSTR-11, Table 15/GSTR-8, ISD, UIN, GSP | — |

---

## 8. Uncertainties and answers
**Settled in revision 4:**
- GSTR-9A is prescribed but exempt in practice.
- 3-year bar from 01.10.2023.
- Rule 88D.
- CSR block.
- Composition sales through an ECO.
- E-invoicing threshold ₹5 crore.
- FA 2026 ss.153–155 from 01.11.2026.
- TCS 0.25% CGST / 0.5% IGST.
- 66/2017 scope.
- 26/2022 Table 14/15 instructions.
- GSTR-4 tool: the latest published is quarterly-era, and there is no CMP-08 tool.

**Settled in revision 5:**
- Rule 43 `Tr` is an official drafting gap; the engine assumes `Tm`.
- Composition threshold is ₹1.5 crore.
- The original s.9(5) categories are known.

**Still open:**
- Amendments to the s.9(5) list (4.2 #1).
- IMS portal rules and 3B pre-fill/hard-lock (4.2 #4).
- `at`/`txpd`/`supeco` layout (4.3 #4).
- 3B Table 4 RUL/OTH pairing.
- GSTR-9 key-to-row pairing.
- Whether composition tenants exist in production.

**Your answers (25 Nov 2026):**
- Q1: GSTR-4/CMP-08 only if required → it is required, P3.
- Q2: import/export only.
- Q3: include marketplace imports, blocked on samples.
- Q4: no ECO/ISD/UIN tenants.
- Q5: order unchanged.
- Items you couldn't find go to `GST_PENDING.md`.

## Verification
- [V-doc] claims cite repo files.
- Code claims cite paths (read-only audit).
- [2nd]/[UNVERIFIED] items stay warn-only or draft until confirmed from section 4.
- After approval, check that `GST_PENDING.md` §1 lists every item in 4.2 #1–4, 4.3 and 4.5, and that nothing already received is still marked as missing.
