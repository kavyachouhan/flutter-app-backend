# GST: what is still pending

Kept next to the architecture freeze (`A0A_ARCHITECTURE_FREEZE.md`). New to the GST module? Start with `GST_DEVELOPER_GUIDE.md` in this folder. Last updated 14 Nov 2026 (Phase 1 scope cleanup: CMP-08 and the pre-engine compliance reports removed; GST reports list fixed to the seven Phase 1 entries; crash fixed when opening return or 2B pages from the GST reports list). Update this file when an item closes; do not delete closed items, move them to "Done".

## 1. Waiting on official data (from you)

| Needed | Unblocks | Where it goes |
|---|---|---|
| Notification 9/2025 and 1/2026 (principal rate schedules), plus 10/2025, 4/2017, 11-13/2017 | A2: publishing a verified rule set (allowed rates, thresholds, cess rule). Nothing is publishable until these are read and counted independently | `data/CBIC/`, then `data/gst-rules/notifications/` |
| Portal notice stating from which return period the Table 12 B2B/B2C HSN split applies, and the current mandatory HSN digits and UQC rules | Period-aware HSN rules in the GSTR-1 mapper | `data/gstn-schemas/registry.json` (effectiveFrom) |
| Official ITC rules text: Rule 36(4), s.16(4), s.17(5), Rules 37, 37A, 38, 42, 43 | The ITC engine (pending conditions, reversals, 4(B)/4(D)) | `docs/gst/` |
| How GSTR-2B and IMS populate GSTR-3B Table 4, and how GSTR-1 populates 3.1 | Exact 3B auto-population comparison | `docs/gst/` |
| IMS offline utility documentation and its JSON format (folder `data/IMS_Offline_Utility` is present, not yet read) | IMS accept/reject/pending actions on 2B rows | `data/gstn-schemas/` |
| 3B Excel utility sample JSON (V5.8) and an Offline Tool GSTR-1 sample JSON | Confirms the Save payload equals the upload file | `data/gstn-schemas/samples/` |
| GSTR-1A, QRMP and IFF API documents | Quarterly filers (see section 3) | `data/gstn-schemas/` |
| s.34, s.15(3)(b), 03/2026-CT and Rule 46A text (open items C1, C2 in the freeze doc) | Corrections matrix certainty | `docs/gst/` |
| **A sample JSON saved from the GSTR-9 Offline Tool** (fill two tables, Generate JSON) and, ideally, one downloaded from the portal after saving a GSTR-9 | Confirms which Save-schema key is which row of the form (Table 6 `other` / `itc_otr`, all of Table 8), whether credit notes (4I, 5H) are written positive, and lets the file be called portal-compatible. Until then every GSTR-9 JSON is a draft | `data/gstn-schemas/samples/` |
| **Real cash, return-liability and credit-reversal ledger files** (redact as needed) | The ledger classification rules (see section 2, "Ledgers"): which `desc` / `dschrg_typ` values mean tax paid through cash or credit | `data/gstn-ledger/classification-rules.json` |
| Notified Form GSTR-9 and instructions (latest amendment) | Confirms the labels taken from Offline Tool v2.2, which tables are optional, and the 6A1/6A2/8H1 rows that the Save schema lacks | `docs/gst/` |

## 2. Not built yet

- **GSTR-1:** advances received and adjusted (tables 11A/11B: `at`, `txpd`), e-commerce operator tables (14, 15: `supeco`, `ecom`), all amendment sections (`b2ba`, `b2cla`, `b2csa`, `cdnra`, `cdnura`, `expa`, `ata`, `txpda`, `nila`, `hsna`). The schemas for all of them are in `data/gstn-schemas/GSTR1`; the engine does not compute them, and the portal export says so.
- **E-commerce operator GSTIN** on B2B, B2CL and B2CS rows: the Save schema has no field for it. These sales raise a warning and must be reported in the e-commerce tables on the portal.
- **GSTR-3B:** interest and late fee (5.1), payment of tax (`tx_pmt`) and liability breakup. They depend on due dates and GSTN's ledgers.
- **GSTR-2B:** the `itcrev` block is reported as unread; IMS statuses are kept in the row but no action is taken on them.
- **ITC engine:** the enums `ITC_RULES`, `ITC_STATUTORY_STATUSES`, `ITC_MOVEMENT_KINDS`, `GSTR3B_TABLE4_LINES` exist but nothing writes them (needs migration and the rules text above).
- **Export shipping bill, port code and date:** no columns exist. Export invoices raise a warning; the portal accepts them without. Adding the fields needs a migration and bill-form changes.
- **Time of supply stamping (`tax_point_*`)** on documents: waits for a published rule set (A2).
- **A2 on the device:** engine rules read from the rule set, HSN master download, HSN picker.
- **Ledgers (fix later, as decided 14 Nov 2026).** Ledger files are imported by hand (JSON saved from the portal); fetching them through a GSP is not built. The seam is `LedgerSource` in `src/modules/gst/ledgers/ledger.service.ts`: a GSP fetcher is a second implementation returning the same `LedgerEntry` list, and nothing in the GSTR-9 engine changes. **Tax paid (GSTR-9 Table 9) is unknown, not zero, until the classification rules are filled in** (`data/gstn-ledger/classification-rules.json` starts empty because the supplied schemas do not say which description / discharge-type values mean what; each rule must record what it was checked against, and unmatched entries are counted and reported, never guessed). Credit reclaimed (6H) is read from the credit reversal ledger, whose keys name what each amount is, and is not affected.
- **GSTR-9:** not computed and left out of the file, so the portal keeps whatever is entered there: 4F advances, 4G1 / 5C1 e-commerce, 4K / 4L / 5J / 5K and Tables 10-13 amendments, Tables 14-16 (differential tax, refunds and demands, composition and job-work supplies), 6A1 / 6A2, 6K-6M and 7F / 7G (transitional and ITC-01/02), the rule-wise reversals 7A-7D (known only as blocked credit and "other"), and 8C / 8E / 8F / 8H1. Table 8 is shown and exported to Excel but **not written to the JSON**: the Save schema's descriptions of its keys are copied from other rows. Late fee (9F) and interest (9E) are summed from GSTR-3B 5.1, which is itself not computed (above).
- **GSTR-9 for a composition dealer (GSTR-9A)** and for an ISD or e-commerce operator: refused or not covered.
- **Composition dealers have no return at all (Phase 1 scope).** CMP-08 was removed on 14 Nov 2026 (code, Reports row and migration 0049); creating any return period for a composition tenant is refused with a plain message. Composition billing (bill of supply, `tenants.composition_*`, `DEFAULT_COMPOSITION_RATES`) is unchanged. GSTR-4 / CMP-08 come back only as a later phase.
- **Purchase register (GSTR-2 format):** no portal JSON exists (GSTR-2 has been suspended since 2017). It is a register for reconciliation, not a filing. Debit-note reasons are mapped to the nearest GSTR-2 reason; the mapping is listed in the file's issues.

## 3. Rules assumed, not verified

| Assumption | Where | Risk |
|---|---|---|
| B2CL threshold is a flat 2.5 lakh | `classify.ts` `B2CL_THRESHOLD_PAISE` | Offline Tool release notes say the limit depends on the return period (before and after Aug 2024) |
| 3B 4(D) pairing: `RUL` = reclaimed after reversal, `OTH` = ineligible under s.16(4)/PoS | `mappers/gstr3b-v2026.11.ts` | The schema only says "RUL / OTH"; the older form read RUL as s.17(5) |
| 3B Table 4: 4(A) holds all credit per books, ineligible credit comes out through 4(B)(1) | `gstr3b-engine.ts` | Matches how the portal pre-fills, but is a design choice |
| Reverse-charge purchases fall in the month of the bill date | `returns.repository.ts` | Time-of-supply rule for reverse charge not applied |
| Outward reverse-charge sales: placement in 3.1 not decided | `gstr3b-engine.ts` (warning) | Wrong figure in 3.1 if used |
| Exports are listed under HSN B2C | `gstr1-engine.ts` | Portal rule for exports in the B2B/B2C split not confirmed |
| B2CS rows may go negative after netting credit notes | `gstr1-engine.ts` (warning) | Portal acceptance not confirmed (the B2CS schema has no minimum on `txval`) |
| E-invoiced bills are left out of the portal file by default (the portal fills them from the IRP) | `gstr1-engine.ts` option | Table 8 and HSN still count them |
| `B2B_4F` / `CDNR_4F` section codes in the filing summary | not used | Meaning not documented in anything supplied |
| HSN quantity is rounded to two decimals | `mappers/gstr1-v2026.11.ts` (warning) | Schema takes two |
| GSTR-9 JSON key to form-row pairing (Tables 4, 5, 6B-6H, 7, 9, 17, 18) is read from the key names, the form and Offline Tool v2.2 | `mappers/gstr9-v2026.11.ts`, registry `verification: schema_checked_mapping_unverified` | Structure is validated against the official Save schema, but a wrongly paired key would validate and still be wrong. Every export is labelled DRAFT |
| GSTR-9 credit notes (4I, 5H) are written as positive amounts | `mappers/gstr9-v2026.11.ts` (warning) | The form labels them "(-)"; the portal's sign convention is not confirmed |
| GSTR-9 4B excludes outward reverse-charge supplies, which go to 5C | `gstr9-engine.ts` | Read from the Offline Tool labels; instructions not checked |
| GSTR-9 6B-6D / 6E / 6F split comes from the credit register by category, reverse charge, supplier registration, bill of entry and country; ineligible credit has lost its type and is shown as inputs | `gstr9-engine.ts` (`buildItcBreakdown`), warning `itc_type_assumed` | 6J (difference from the 3B total) flags any gap |
| GSTR-9 blocked credit (7E) is taken as all of GSTR-3B 4(B)(1); 4(B)(2) goes to 7H1 "other" | `gstr9-engine.ts` | Rules 37, 37A, 38, 39, 42, 43 are not split |
| GSTR-9 8A is credit marked available in imported GSTR-2B (reverse-charge rows excluded) | `gstr9.service.ts` | Not confirmed against 2B Table 3(I); 8G and 8H come from the same register rows, so 8I is zero |
| A GSTR-1 stored without e-invoiced invoices is recomputed for GSTR-9 | `gstr9.service.ts` (issue `period_recomputed`) | Recomputing means that month is not exactly the filed snapshot |
| A QRMP filer's GSTR-9 uses the four quarterly returns | `gstr9.service.ts` `returnPeriodKeys` | Not exercised against a real QRMP business |
| Official ledger schemas are used as published, with three relaxations: the cash schema's `required` list names `refNo` (the property is `ref_no`) and `igstbal`, `cgstbal`, `sgstbal`, `cessbal` inside `op_bal` / `cl_bal` (which define `igst`, `cgst`, `sgst`, `cess`), so those keys are dropped from `required`; free-text `pattern` violations are warnings; draft-04 meta-schema is registered | registry `ledger_cash`, `schema-store.ts` | A real file may differ from the schema in other ways; the first real file will show |
| The SAC report treats a code as a service when it starts with `99` or the HSN/SAC master lists it as a service; lines without a code are counted, not placed | `hsn-summary.ts` | No separate SAC return exists; this is an analysis view over Table 12 / Table 17 data |
| GSTR transaction reports and the HSN/SAC reports are worked out live from current documents, not snapshotted | `gst-reports.service.ts` | They do not replace preparing a return; a later bill changes them |

## 4. Environment and database

| Environment | Migrations | State |
|---|---|---|
| TEST | 0001-0045, 0047, 0048, 0049 applied (0047, 0048, 0049 on 14 Nov 2026). There is no 0046 on TEST. 0049 narrows `gst_return_periods.return_type` to gstr1/gstr3b/gstr9 and stops (raises) if any cmp08 period exists; TEST and DEV had none on 14 Nov | Proper. 0047 widens `gst_return_periods.return_type` for GSTR-9; 0048 adds `gst_ledger_imports` and `gst_ledger_entries`. They were first numbered 0046 and 0047 and renamed because DEV already held a different `0046_import_mappings.sql` from other work; the TEST ledger rows were renumbered to match |
| DEV | 0001-0045 applied (13 Nov 2026). **0047, 0048 and 0049 are pending on DEV and were not applied.** DEV also holds `0046_import_mappings.sql` (applied 14 Nov, from other work, not in this branch): when that branch merges, TEST will show it pending, and it applies out of order after 0047 and 0048 there | Proper. The preflight had 93 blocking rows (checksum-invalid GSTINs on 93 of 99 tenants, all created 26-28 Oct, names like "Catalogue Shop", holding 119 invoices). With approval, those 93 fixture tenants were backed up and removed, the preflight re-ran with 0 blocking rows, and 0037-0045 applied. 6 tenants remain |

DEV backup of the removed tenants: `D:/Projects/Khataapp/backups/dev_fixture_tenants_2026-11-13/` (one JSONL file per table plus `MANIFEST.json` with row counts and hashes). It holds customer data from those fixtures; keep it out of both git repos.

Other follow-ups:

- Run the app on a device or emulator and walk the GST screens (not done; only analyze and unit/widget tests).
- Have the Hindi, Gujarati and Marathi GST wording reviewed by a native reader.
- `estimate_detail_test.dart` has 5 failures that look date-dependent and are unrelated to GST.
- The HSN master file leaves out 7 rows: the portal finds `040210` and not `40210`; do not call the official file defective.
- vitest only runs from a shell whose working folder has an uppercase drive letter (`cd "$(cygpath -m ...)"`) or from PowerShell.
- Nothing from this work is committed.
- The vendor utilities under `data/` (`gst_returns_offline_tool` with a 39 MB .exe, `IMS_Offline_Utility`, `GSTR_9_Offline_Utility`, `GSTR3B_Excel_Utility`, `ITC_01_Offline_v1.3`, `ITC_04_Offline_Utility`) are already tracked in git; no code reads them. Untracking them (`git rm --cached` + `.gitignore`) is your decision.
- `src/modules/delivery-challans/delivery-challans.service.ts` has an unused import (`randomUUID`) that fails `npm run lint`; not part of the GST work and left alone.
- The Dockerfile now also copies `data/gstn-ledger` (ledger schemas and the classification rules); rebuild the image before deploying.
- GSTR-9 prepare reads a whole year (about 10 queries per period that was never prepared). It was brought down by reading the year's documents once; on a slow remote database a first prepare still takes tens of seconds.
- A ledger file is sent as the request body (no upload step); a very large file is refused by the body limit.
- Not yet run on a device after the 14 Nov navigation fix: open GSTR-1, GSTR-3B and GSTR-2B from the GST reports list and press "New return" / upload / open a row.

## 5. Done (for reference)

- **Phase 1 scope cleanup (14 Nov 2026).** Audit report: `~/.claude/plans/pasted-content-id-cf7c-billbanao-serene-coral.md`. The Reports tab's GST section ("GST reports") now lists exactly GSTR-1, GSTR-2B, GSTR-3B, GST Transaction Report, GSTR-9, Sales Summary by HSN and SAC Report, each with its own screen (GSTR-1/3B open the return periods filtered by type; GSTR-2B opens the 2B import and match screen). Removed: the pre-engine live-SQL reports in `reports/queries/compliance.ts` (GSTR-1 B2B/B2C/CDN/HSN/Nil/Bills Issued, GSTR-3B summary, 2B reconciliation list, ITC register list, CMP-08 turnover), which could disagree with the prepared returns (they missed sales debit notes and counted purchase debit notes in Table 13); CMP-08 end to end; dead `gst.repository` queries. Kept as supporting: the ITC register (More → GST Filing), adjustment notes, ledgers, `hsn_master`, rule sets, reserved schema. (The audit report path is a local planning file on the main dev PC, not in the repo; this section and `GST_DEVELOPER_GUIDE.md` carry its conclusions.) Tests after the cleanup: backend 528 unit and all 7 GST integration files (76 tests) against TEST; Flutter GST, reports and app-routing tests pass.
- **Crash fix: GST pages opened from the GST reports list (14 Nov 2026).** The GST reports routes (`/report-gst/...`) sit outside the tab shell, and pushing a `/more/gst/...` page from them built the shell twice and failed with "A GlobalKey was used multiple times" (seen on GSTR-3B "New return"; the same applied to opening a period, saving a new one, GSTR-2B upload/open and GSTR-9 "open period"). Fix: twin routes `/report-gst/periods/new`, `/report-gst/periods/:id`, `/report-gst/statements/new`, `/report-gst/statements/:id`, and the helpers `Routes.gstPeriodNewFor`, `gstPeriodPathFor`, `gstStatementNewFor`, `gstStatementPathFor` in `flutter-app/lib/app/router.dart`, which pick the route matching where the screen was opened. Regression test: `flutter-app/test/app/gst_reports_nav_test.dart` (real router).

- Neutral return model, line-level GSTR-1 and GSTR-3B engines, versioned mappers with `data/gstn-schemas/registry.json`.
- GSTR-1 (official Save schema) and GSTR-3B (official Save schema) portal JSON, checked against the schemas.
- GSTR-2B parser rewritten to the official field names; credit per books against 2B in the 3B workings.
- Excel, CA package (in-app download), PDF built on the device, all from the same stored tables.
- Flutter tables, summary, issues tab; Hindi, Gujarati and Marathi text.
- Integration test `tests/integration/gst-returns.test.ts` (9 tests against TEST), 453 unit tests.
- **GST reports (14 Nov 2026).** GSTR transaction report (GSTR-1 sales, GSTR-1 credit/debit notes, GSTR-2 purchases and credit/debit notes in the official GSTR-2 offline layout) with the Excel Options sheet (open, share, export); GSTR-9 as a saved financial-year return (prepare, tables, Excel, CA package, draft JSON, mark filed); Sales Summary by HSN; SAC report; ledger import (credit reversal ledger feeding 6H; cash and liability stored, paid awaiting rules). All four sat in the Reports tab under Compliance (since the Phase 1 cleanup above, the group is "GST reports" and holds all seven Phase 1 entries). HSN accumulation is shared by GSTR-1 Table 12, the HSN report, the SAC report and GSTR-9 Tables 17/18. Tests: unit (purchase register, HSN/SAC, GSTR-9 engine and mapper, ledger parsers, rules and summary), integration `gst-reports`, `gst-gstr9`, `gst-ledgers` against TEST, and widget tests for the Excel Options sheet, table report, GSTR-9 and ledger card.
