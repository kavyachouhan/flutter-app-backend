# GST: what is still pending

Kept next to the architecture freeze (`A0A_ARCHITECTURE_FREEZE.md`). Last updated 12 Nov 2026. Update this file when an item closes; do not delete closed items, move them to "Done".

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

## 2. Not built yet

- **GSTR-1:** advances received and adjusted (tables 11A/11B: `at`, `txpd`), e-commerce operator tables (14, 15: `supeco`, `ecom`), all amendment sections (`b2ba`, `b2cla`, `b2csa`, `cdnra`, `cdnura`, `expa`, `ata`, `txpda`, `nila`, `hsna`). The schemas for all of them are in `data/gstn-schemas/GSTR1`; the engine does not compute them, and the portal export says so.
- **E-commerce operator GSTIN** on B2B, B2CL and B2CS rows: the Save schema has no field for it. These sales raise a warning and must be reported in the e-commerce tables on the portal.
- **GSTR-3B:** interest and late fee (5.1), payment of tax (`tx_pmt`) and liability breakup. They depend on due dates and GSTN's ledgers.
- **GSTR-2B:** the `itcrev` block is reported as unread; IMS statuses are kept in the row but no action is taken on them.
- **ITC engine:** the enums `ITC_RULES`, `ITC_STATUTORY_STATUSES`, `ITC_MOVEMENT_KINDS`, `GSTR3B_TABLE4_LINES` exist but nothing writes them (needs migration and the rules text above).
- **Export shipping bill, port code and date:** no columns exist. Export invoices raise a warning; the portal accepts them without. Adding the fields needs a migration and bill-form changes.
- **Time of supply stamping (`tax_point_*`)** on documents: waits for a published rule set (A2).
- **A2 on the device:** engine rules read from the rule set, HSN master download, HSN picker.

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

## 4. Environment and database

| Environment | Migrations | State |
|---|---|---|
| TEST | 0001-0045 applied, checked, no modified files | Proper. This round added no migration |
| DEV | 0001-0045 applied (13 Nov 2026) | Proper. The preflight had 93 blocking rows (checksum-invalid GSTINs on 93 of 99 tenants, all created 26-28 Oct, names like "Catalogue Shop", holding 119 invoices). With approval, those 93 fixture tenants were backed up and removed, the preflight re-ran with 0 blocking rows, and 0037-0045 applied. 6 tenants remain |

DEV backup of the removed tenants: `D:/Projects/Khataapp/backups/dev_fixture_tenants_2026-11-13/` (one JSONL file per table plus `MANIFEST.json` with row counts and hashes). It holds customer data from those fixtures; keep it out of both git repos.

Other follow-ups:

- Run the app on a device or emulator and walk the GST screens (not done; only analyze and unit/widget tests).
- Have the Hindi, Gujarati and Marathi GST wording reviewed by a native reader.
- `estimate_detail_test.dart` has 5 failures that look date-dependent and are unrelated to GST.
- The HSN master file leaves out 7 rows: the portal finds `040210` and not `40210`; do not call the official file defective.
- vitest only runs from a shell whose working folder has an uppercase drive letter (`cd "$(cygpath -m ...)"`) or from PowerShell.
- Nothing from this work is committed.

## 5. Done (for reference)

- Neutral return model, line-level GSTR-1 and GSTR-3B engines, versioned mappers with `data/gstn-schemas/registry.json`.
- GSTR-1 (official Save schema) and GSTR-3B (official Save schema) portal JSON, checked against the schemas.
- GSTR-2B parser rewritten to the official field names; credit per books against 2B in the 3B workings.
- Excel, CA package (in-app download), PDF built on the device, all from the same stored tables.
- Flutter tables, summary, issues tab; Hindi, Gujarati and Marathi text.
- Integration test `tests/integration/gst-returns.test.ts` (9 tests against TEST), 453 unit tests.
