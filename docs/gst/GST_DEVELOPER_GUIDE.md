# GST module: developer guide

A getting-started map of BillBanao's GST code, for developers joining the work. It explains what is built, where every piece lives in the backend and the Flutter app, how a figure travels from a bill to a return, and how to make the common kinds of change safely.

Companion documents in this folder:

| File | Read it for |
|---|---|
| `GST_DEVELOPER_GUIDE.md` (this file) | Orientation: structure, flows, how-tos |
| `GST_PENDING.md` | What is not built, what waits on official data, unverified assumptions, database state. **Check it before you start any GST task.** |
| `A0A_ARCHITECTURE_FREEZE.md` | The frozen design: entity vs registration, document columns, enums, rule-set schema. Change it only with review |
| `rule_46.txt`, `rule_46a.txt`, `section_15.txt`, `section_34.txt` | Official legal text the invoice and correction rules were written from |

Last checked against the code: 14 Nov 2026.

---

## 1. What the GST module does (Phase 1 scope)

Phase 1 is **exactly seven items**. They appear in this order in the app's Reports tab, under **GST reports**:

| # | Item | What the user gets |
|---|---|---|
| 1 | **GSTR-1** | Monthly sales return: prepare, review tables, download Excel / CA package / portal JSON, record that it was filed |
| 2 | **GSTR-2B** | Upload the GSTR-2B statement downloaded from the portal; match it against purchase bills; accept probable matches |
| 3 | **GSTR-3B** | Monthly summary return: same prepare → review → export → mark filed flow as GSTR-1 |
| 4 | **GSTR-9** | Annual return for a financial year, summed from the stored monthly returns. Its portal JSON is a **draft** (see `GST_PENDING.md`) |
| 5 | **GST Transaction Report** | Excel files: GSTR-1 sales, GSTR-1 credit/debit notes, and purchases plus purchase notes in the official GSTR-2 offline layout |
| 6 | **Sales Summary by HSN** | Sales by HSN code with quantity, taxable value and tax, net of credit notes |
| 7 | **SAC Report** | Service sales and purchases by SAC code |

Anything else (CMP-08, GSTR-4, e-invoice, e-way bill, GSP filing, IMS actions, amendments) is **out of scope**. Do not add it without the product owner's approval. CMP-08 was removed on 14 Nov 2026 for this reason.

**The app never files anything with the government.** It prepares figures and files; a person uploads them on the GST portal and then records the filing (with the ARN) in the app.

---

## 2. The big picture

```
 Bills, credit notes, sales debit notes, purchase bills, purchase debit notes
 (written by the normal billing modules; each carries GST snapshot columns)
            │
            ▼
 returns.repository.ts  ── loads documents and lines for one GSTIN and period (SQL)
            │
            ▼
 Pure engines in src/domain/gst/returns/  (no database access, unit-tested)
   gstr1-engine · gstr3b-engine · gstr9-engine · hsn-summary · docs-issued · purchase-register
            │  produce a neutral "return model" + display "sheets" + "issues"
            ▼
 prepare  →  stored as JSON in gst_return_periods.workings   (a snapshot; never recomputed on read)
            │
   ┌────────┼─────────────────┬──────────────────────┐
   ▼        ▼                 ▼                      ▼
 Screen   Excel / CA       Portal JSON            PDF
 tables   package          (versioned mapper,     (built on the device
 (app)    (backend)        checked against the    from the same sheets)
                            official schema)
```

The rule behind this design: **one calculation, many outputs.** Screen, Excel, CA package, JSON and PDF are all rendered from the same stored sheets, so they cannot disagree. Never compute a return figure in a second place, such as SQL in another module or arithmetic in Flutter. That was the bug class removed in the Phase 1 cleanup.

GST *reports* (transaction report, HSN, SAC) use the same engines but are worked out **live** from current documents, not stored. Returns are snapshots; reports are views.

---

## 3. Ideas to understand before changing anything

1. **Everything is per GSTIN, not per business.** A business with registrations in two states files two sets of returns. Queries scope by the GSTIN *snapshotted on the document*, never by tenant or outlet.
2. **Prepared returns are snapshots.** `prepare` computes and stores; reading never recomputes. `prepare` can be re-run until the return is marked filed; after that it is refused (corrections belong in a later period).
3. **Filing is a deliberate human act.** `POST /gst/periods/:id/file` requires `confirm: true`, is audited, and is never automatic.
4. **Money is integer paise** everywhere (no floats). Mappers convert to rupees only when writing a portal file.
5. **Portal formats are versioned data, not code edits.** `data/gstn-schemas/registry.json` picks a mapper per form and return period. A new GSTN format is a new mapper file plus a registry row; old periods keep their old mapper.
6. **Law is data where possible.** Rates and rules come from notification files in `data/gst-rules/` (milestone A2, currently paused until verified sources exist).
7. **Never invent a schema field or a legal rule.** Every portal key must exist in the official schema under `data/gstn-schemas/`. Anything assumed goes into the "Rules assumed, not verified" table in `GST_PENDING.md`.
8. **Shared rules exist twice, in TypeScript and Dart, and are vector-tested.** GSTIN checks, place of supply, invoice rules, corrections and the tax engine run offline on the device *and* on the server. Both sides read the same JSON vectors in `contracts/`, so they cannot drift.

---

## 4. Repository layout

There are two separate git repositories:

- `flutter-app-backend/`: Node.js + TypeScript (Express, PostgreSQL)
- `flutter-app/`: the Flutter app, with local packages under `flutter-app/packages/`

### 4.1 Backend: `flutter-app-backend/`

```
src/
├── domain/gst/                      PURE logic: no database, no HTTP. Most GST rules live here.
│   ├── enums.ts                     Shared GST enums (mirrored in Dart enums.dart; frozen in A0a)
│   ├── gstin.ts                     GSTIN / UIN format and checksum validation
│   ├── place-of-supply.ts           Place-of-supply resolver (intra/inter-state, SEZ, export…)
│   ├── invoice-rules.ts             Rule 46 invoice rules, document type (tax invoice / bill of supply)
│   ├── corrections.ts               Which correction a bill needs (credit note, debit note, void…)
│   ├── classify.ts                  Classifies a document/line into return sections (B2B, B2CL, B2CS…)
│   ├── composition.ts               Composition default rates + financial-year quarter helper (QRMP)
│   ├── parse-2b.ts                  Parser for the official GSTR-2B JSON
│   ├── reconcile.ts                 Matching 2B invoices against purchase bills
│   ├── rule-set.ts / rule-set-compose.ts   Versioned GST rule sets built from notification files (A2)
│   ├── entity.ts, registration.ts, time-of-supply.ts   Shared contracts for later milestones (vector-tested)
│   ├── ledgers/                     Parsers + summary for portal electronic ledgers (cash, liability, ITC reversal)
│   └── returns/                     THE RETURN ENGINES
│       ├── model.ts                 Neutral return model (portal-independent shapes)
│       ├── gstr1-engine.ts          GSTR-1 from document lines
│       ├── gstr3b-engine.ts         GSTR-3B (outward from the same lines + purchases/ITC)
│       ├── gstr9-engine.ts          GSTR-9 from twelve stored monthly returns
│       ├── hsn-summary.ts           HSN/SAC accumulation (shared by GSTR-1 Table 12, HSN, SAC, GSTR-9 17/18)
│       ├── docs-issued.ts           GSTR-1 Table 13 (documents issued)
│       ├── purchase-register.ts     GSTR-2-layout purchase register (transaction report)
│       ├── sheets.ts                Display sheets + issues shown on screen and in Excel/PDF
│       ├── registry.ts              Reads data/gstn-schemas/registry.json
│       └── mappers/                 Portal JSON writers, one file per form version
│           ├── gstr1-v2026.11.ts, gstr3b-v2026.11.ts, gstr9-v2026.11.ts
│           ├── index.ts             Registers the mappers
│           └── format.ts, types.ts
├── domain/tax/                      Tax engine (line tax, rounding); mirrored in Dart
├── modules/gst/                     HTTP + database side of GST. Mounted at /v1/gst (src/v1-router.ts)
│   ├── gst.routes.ts                All /v1/gst endpoints (start here to trace a request)
│   ├── gst.schemas.ts               Request validation (zod): return types, period bodies, 2B import body
│   ├── gst.openapi.ts               API documentation
│   ├── gst.service.ts               Return periods: create, prepare, file; ITC register list
│   ├── gst.repository.ts            gst_return_periods table access
│   ├── export.service.ts            Excel / CA package / portal JSON export of a stored return
│   ├── sheet-workbook.ts            Turns sheets into Excel sheets
│   ├── period-window.ts             Dates a period covers (month, QRMP quarter, financial year)
│   ├── gstin-scope.ts               Which GSTINs this business files for; resolves the requested one
│   ├── filing-state.ts              "Is GSTR-1 already filed for this date?" (used by corrections)
│   ├── itc.repository.ts            itc_register table (input tax credit per purchase)
│   ├── reconciliation.service.ts / .repository.ts   GSTR-2B import → ingest → reconcile → accept
│   ├── registrations.service.ts     gst_registrations (per-GSTIN settings such as round-off)
│   ├── rule-sets.service.ts         Published rule sets + HSN/SAC master for devices
│   ├── returns/
│   │   ├── returns.repository.ts    SQL loaders feeding the engines
│   │   ├── returns.service.ts       computeGstr1 / computeGstr3b
│   │   ├── gstr9.service.ts         computeGstr9 (reads the year's stored returns)
│   │   ├── payload-export.ts        Builds + validates the portal JSON via the mapper
│   │   └── schema-store.ts          Loads official JSON schemas and validates with ajv
│   ├── reports/
│   │   └── gst-reports.service.ts   Transaction report, HSN report, SAC report
│   └── ledgers/                     Ledger import (LedgerSource seam for a future GSP fetch)
├── modules/adjustment-notes/        Sales debit notes and financial credit notes ("Correct this bill")
├── modules/invoices/invoice-supply.ts   Applies place of supply + party snapshots to a bill
├── modules/reports/reports.registry.ts  Reports-tab catalogue; the GST entries are the seven above (all `screen:` entries)
├── db/migrations/                   SQL migrations (GST: 0018, 0037–0045, 0047–0049)
├── db/gst/rules-cli.ts              `npm run gst:rules` (check / publish rule sets, load HSN master)
└── db/preflight/gst-registrations.ts  Read-only check run before the GST migrations

data/                                Official inputs. Code reads only the first four
├── gstn-schemas/                    Official GSTN JSON schemas (GSTR1, GSTR2B, GSTR3B, GSTR9) + registry.json
├── gstn-ledger/                     Ledger schemas + classification-rules.json (empty on purpose)
├── gst-rules/                       One JSON per CBIC notification + README (how to change rules)
├── CBIC/                            Notification PDFs + HSN_SAC.xlsx (loads hsn_master)
└── *_Offline_Utility, gst_returns_offline_tool, ITC_0*   Reference copies of GSTN tools; no code reads them

contracts/*-vectors.json             Shared test vectors (gstin, pos, tos, invoice-rules, corrections, tax, ruleset…)
tests/contracts/                     Generates the vectors (`npm run contracts:generate`)
tests/integration/gst-*.test.ts      Integration tests against the TEST database
docs/gst/                            This folder
```

### 4.2 Flutter app: `flutter-app/`

```
lib/
├── features/gst/
│   ├── gst_screens.dart             GST Filing hub; return periods list (optionally one type);
│   │                                new-period form; period detail (prepare / export / mark filed); ITC screen
│   ├── gst_statement_screens.dart   GSTR-2B: list, upload form, detail with matches and "accept"
│   ├── gst_providers.dart           Riverpod providers (periods keyed by type + pages, ITC, 2B)
│   ├── reports/
│   │   ├── gstr_transaction_report_screen.dart   GST Transaction Report (four Excel kinds)
│   │   ├── gst_table_report_screen.dart          Sales Summary by HSN and SAC Report (one screen, two kinds)
│   │   ├── gstr9_screen.dart                     GSTR-9 year picker, prepare, ledger import card
│   │   └── excel_options_sheet.dart              Open / share / save a generated Excel file
│   └── returns/
│       ├── return_workings_screen.dart  Tabbed tables of a prepared GSTR-1 / 3B / 9
│       ├── return_table.dart, return_format.dart   Draw one table; format cells
│       ├── return_pdf.dart              Builds the PDF on the device from the stored sheets
│       └── gst_export_actions.dart      Download Excel / CA / JSON
├── features/reports/reports_screen.dart   Reports tab; group "compliance" is titled "GST reports"
├── features/creditnotes/correct_bill.dart "Correct this bill": sales debit notes, financial credit notes
├── features/admin/business_screen.dart    GST identity, composition, round-off per registration
├── core/billing/party_gst.dart            Party GST treatment + supply scenario on a bill
├── core/catalogue/rules.dart              Allowed GST rates, HSN format check (until A2 rule sets are live)
├── core/creditnotes/adjustment_notes_repository.dart   Offline outbox for adjustment notes
├── core/db/tables.dart                    Local tables: GstRegistrations, SalesDebitNotes, FinancialCreditNotes
├── app/router.dart                        Routes (see section 6)
└── l10n/ (arb files in flutter-app/l10n/) English, Hindi, Gujarati, Marathi text

packages/
├── khata_api/lib/src/endpoints/gst_endpoints.dart   Every /gst API call (GstEndpoints)
├── khata_api/lib/src/models/gst_return_models.dart  ReturnWorkings, ReturnSheet, ReturnColumn
└── khata_domain/lib/src/gst/        Dart twins of the shared domain rules:
    gstin, place_of_supply, invoice_rules, corrections, enums (used by billing),
    rule_set, entity, registration, time_of_supply (contracts for later milestones)
    Tests: packages/khata_domain/test/gst_contract_test.dart + test/fixtures/*-vectors.json

test/features/gst/                   Widget tests (GSTR-9, table report, Excel sheet, return tables)
test/app/gst_reports_nav_test.dart   Real-router test: GST reports pages open without crashing
```

**What runs where.** Return preparation, reconciliation, exports, ledgers and rule-set publishing are **server-side only**: no local tables, nothing synced. The device runs the tax engine, place of supply, GSTIN checks, invoice rules and corrections **offline** while billing. That is why those rules have Dart twins.

---

## 5. The seven modules, end to end

For each item: where the user taps, the Flutter screen, the API call, and the backend code that does the work.

| Item | App path | Flutter screen | API | Backend |
|---|---|---|---|---|
| GSTR-1 | Reports → GST reports → GSTR-1 | `GstPeriodsScreen(returnType: 'gstr1')` → `GstPeriodFormScreen` → `GstPeriodDetailScreen` → `ReturnWorkingsScreen` | `GET/POST /gst/periods`, `POST /gst/periods/:id/prepare`, `GET /gst/periods/:id/export?format=xlsx\|ca\|json`, `POST /gst/periods/:id/file` | `gst.service.ts` → `returns.service.computeGstr1` → `gstr1-engine.ts`; export via `export.service.ts` + `mappers/gstr1-v2026.11.ts` |
| GSTR-2B | Reports → GST reports → GSTR-2B | `GstStatementsScreen` → `GstStatementFormScreen` → `GstStatementDetailScreen` | `POST /gst/2b-imports` (returns a signed upload URL), `/ingest`, `/reconcile`, `GET /matches`, `POST /matches/:matchId/accept` | `reconciliation.service.ts` → `parse-2b.ts`, `reconcile.ts` |
| GSTR-3B | Reports → GST reports → GSTR-3B | `GstPeriodsScreen(returnType: 'gstr3b')` and the same detail screens | same as GSTR-1 | `computeGstr3b` → `gstr3b-engine.ts`; credit from `itc_register`; compares against a prepared GSTR-1 |
| GSTR-9 | Reports → GST reports → GSTR-9 | `Gstr9Screen` (+ ledger import card) → `ReturnWorkingsScreen` | `/gst/periods` with `returnType: 'gstr9'`, `/gst/ledger-imports` | `gstr9.service.ts` → `gstr9-engine.ts`; `mappers/gstr9-v2026.11.ts` (DRAFT); ledgers in `modules/gst/ledgers/` |
| GST Transaction Report | Reports → GST reports | `GstrTransactionReportScreen` | `GET /gst/reports/transactions?kind=…` | `gst-reports.service.exportTransactionReport`, `purchase-register.ts` |
| Sales Summary by HSN | Reports → GST reports | `GstTableReportScreen(kind: hsnSales)` | `GET /gst/reports/hsn-sales` | `gst-reports.service.hsnSalesReport` → `hsn-summary.ts` |
| SAC Report | Reports → GST reports | `GstTableReportScreen(kind: sac)` | `GET /gst/reports/sac` | `gst-reports.service.sacReport` → `hsn-summary.ts` + `hsn_master` |

The same return and 2B screens are also reachable from **More → GST Filing** (and Settings → Taxes), which additionally holds the **ITC register** screen (`GstItcScreen`, `GET /gst/itc-register`).

### Life of a return period

```
open  ──prepare──▶  prepared  ──(prepare again, any number of times)──▶  prepared
                       │
                       └──file (confirm: true, ARN optional)──▶  filed   (locked: prepare refused)
```

- Create: `POST /gst/periods` with a client-generated `id`, `returnType` (`gstr1` / `gstr3b` / `gstr9`), `periodYear`, `periodMonth`. It is idempotent: the same scope returns the existing period. A composition business is refused (its returns are not in Phase 1).
- Prepare: computes, stores `{form, sheets, summary, issues, model}` in `gst_return_periods.workings`, and writes an audit entry.
- Export: rendered from the stored workings only. JSON goes through the mapper chosen by the registry and is validated against the official schema; it is refused if invalid.

---

## 6. Flutter routing (read this before adding a GST page)

Routes are defined in `lib/app/router.dart`.

| Route | Screen | Where it sits |
|---|---|---|
| `/report-gst/gstr1`, `/report-gst/gstr3b` | `GstPeriodsScreen(returnType: …)` | Top level, **outside** the tab shell |
| `/report-gst/gstr2b` | `GstStatementsScreen` | Top level |
| `/report-gst/transactions`, `/hsn-sales`, `/sac`, `/gstr9` | Report screens | Top level |
| `/report-gst/periods/new`, `/report-gst/periods/:id`, `/report-gst/statements/new`, `/report-gst/statements/:id` | Form / detail pages when opened from GST reports | Top level |
| `/more/gst`, `/more/gst/periods[/new\|/:id]`, `/more/gst/itc`, `/more/gst/statements[/new\|/:id]` | Same pages opened from the More tab | **Inside** the tab shell |

How a Reports-tab row opens its screen: the backend catalogue entry has `screen: 'gstr1'` (etc.), and `Routes.screenReportPath(screen)` maps it to a route.

**Important:** never push a `/more/...` route from a `/report-gst/...` page. Doing so builds the tab shell twice and crashes with "A GlobalKey was used multiple times". Use the helpers, which choose the right twin automatically:

```dart
context.push(Routes.gstPeriodNewFor(context, returnType: 'gstr3b'));
context.push(Routes.gstPeriodPathFor(context, periodId));
context.push(Routes.gstStatementNewFor(context));
context.push(Routes.gstStatementPathFor(context, importId));
```

`test/app/router_test.dart` checks that every `static const String` route in `Routes` has a screen, so write route constants as plain string literals.

---

## 7. Supporting pieces the seven modules depend on

These are not on the GST reports list, but the returns are wrong without them. Do not remove them.

| Piece | Why it matters | Where |
|---|---|---|
| Document GST columns and snapshots | Every bill stores supplier/buyer GSTIN, place of supply, supply scenario, tax heads at issue time. Returns read these, not live party data | migrations 0039, 0044; `invoice-supply.ts` |
| GST registrations | One row per GSTIN; round-off setting; which GSTINs a business files for | `gst_registrations`, `registrations.service.ts`, `gstin-scope.ts` |
| Adjustment notes | Sales debit notes appear in GSTR-1 CDNR/CDNUR, Table 13 and GSTR-9. Financial credit notes appear in no return (by design) | `modules/adjustment-notes/`, `correct_bill.dart` |
| ITC register | Credit per purchase bill; feeds GSTR-3B Table 4 and GSTR-9 Table 6. Back-filled on every prepare | `itc_register`, `itc.repository.ts` |
| GSTR-2B tables | 2B credit check in 3B workings and GSTR-9 8A | `gstr2b_imports`, `gstr2b_invoices`, `gstr2b_matches` |
| Ledgers | GSTR-9 6H (credit reclaimed) and Table 9 (tax paid, still unknown until classification rules exist) | `gst_ledger_imports`, `gst_ledger_entries` |
| HSN/SAC master | SAC report classification; HSN descriptions | `hsn_master`, loaded from `data/CBIC/HSN_SAC.xlsx` |
| Rule sets (A2, paused) | Will replace hard-coded rates; nothing is published yet | `gst_rule_sets`, `data/gst-rules/` |

Some database columns and enums exist for **later** milestones and are intentionally unused: `irn_state` / `pending_irn` (e-invoice), lock epochs and issuance tables (offline locks), `sales_channel` / `eco_gstin` (e-commerce). They are frozen in the A0a design; leave them alone.

---

## 8. Database

| Table | Purpose | Migration |
|---|---|---|
| `gst_return_periods` | One row per GSTIN + return type + period; status open/prepared/filed; `workings` JSON snapshot | 0018, 0047, 0049 |
| `itc_register` | Input tax credit per purchase | 0018 |
| `gstr2b_imports`, `gstr2b_invoices`, `gstr2b_matches` | 2B upload jobs, parsed invoices, match results | 0018 |
| `gst_registrations`, `gst_registration_profiles`, `entity_turnover_by_fy` | Registration (GSTIN level) and entity (PAN level) data | 0037, 0044 |
| `gst_rule_sets`, `hsn_master` | Versioned rule sets; HSN/SAC master | 0037, 0043 |
| `customer_addresses` | Ship-to addresses with GSTIN | 0038 |
| `sales_debit_notes`, `sales_debit_note_lines`, `financial_credit_notes` | Corrections after issue | 0045 |
| `gst_ledger_imports`, `gst_ledger_entries` | Imported portal ledgers | 0048 |

Environments: **TEST** is where GST migrations are applied first; **DEV** is updated only by the owner. The current state of each is in `GST_PENDING.md` section 4. Migrations from 0035 on are linted: any destructive statement needs a `-- destructive-ok: <KIND> — reason` comment line (see `src/db/migration-lint.ts`).

---

## 9. Permissions and plans

- `gst:read`: view returns, reports, 2B, ITC. `gst:manage`: create/prepare/file returns, upload 2B, accept matches, import ledgers. Defined in `src/modules/auth/permissions.ts`; enforced in `gst.routes.ts`.
- Reports-tab GST entries also need `reports:financial` (except HSN and SAC).
- Plan feature `gst_workings` (Standard, Pro, Trial; not Lite) is checked with `assertFeature` in every GST service.
- In Flutter, the More → GST Filing entry needs `Permission.gstRead`; "New return" needs `Permission.gstManage`.

---

## 10. How to…

**…change how a return figure is computed.** Change the engine in `src/domain/gst/returns/` (and `returns.repository.ts` if it needs new data), never the screen or a mapper. Add or adjust a unit test next to the engine (`returns-engine.test.ts`, `gstr9-engine.test.ts`, `hsn-summary.test.ts`). Users must prepare again; filed returns keep their snapshot.

**…support a new GSTN portal format.** Put the official schema under `data/gstn-schemas/<FORM>/`, add `mappers/<form>-v<yyyy.mm>.ts`, register it in `mappers/index.ts`, and add a row to `registry.json` with `effectiveFrom`. Do not edit the old mapper; old periods still use it. Mark `verification` honestly (`schema_verified` only when validated against the official schema).

**…add a GST report.** Compute it from the existing engines (usually `hsn-summary.ts` or `sheets.ts`), expose it in `gst-reports.service.ts` + `gst.routes.ts`, add an entry with a `screen:` key to `reports.registry.ts` (and the `screen` type in `reports.types.ts`), then add the route in `router.dart` and the call in `gst_endpoints.dart`. Confirm it is in scope first.

**…record a new GST notification (rates/rules).** Follow `data/gst-rules/README.md`: one JSON per notification, then `npm run gst:rules -- check`. Publishing is refused until rates are verified against the official CBIC text.

**…change a shared rule (GSTIN, place of supply, invoice rules, corrections, tax).** Change the TypeScript in `src/domain/gst/` **and** the Dart twin in `packages/khata_domain/lib/src/gst/`, update the cases in `tests/contracts/`, run `npm run contracts:generate`, and copy the regenerated vectors into `flutter-app/packages/khata_domain/test/fixtures/`. Both test suites must pass.

**…add a GST page in Flutter.** If it can be opened from GST reports, give it a `/report-gst/...` twin and navigate with a `...For(context, …)` helper (section 6). Add l10n strings to all four arb files in `flutter-app/l10n/`.

---

## 11. Running and testing

Backend (`flutter-app-backend/`):

```bash
npx tsc --noEmit                      # type check
npm run lint
npx vitest run                        # unit tests (engines, mappers, parsers, ledgers)
npx vitest run --config vitest.integration.config.ts tests/integration/gst-returns.test.ts \
  --testTimeout 240000 --hookTimeout 240000   # integration, against the TEST database
npm run contracts:generate            # regenerate shared vectors after changing a shared rule
npm run gst:rules -- check            # validate rule notification files (defaults to DEV env)
```

GST integration files: `gst-returns`, `gst-reports`, `gst-gstr9`, `gst-ledgers`, `gst-corrections`, `gst-foundations`, `gst-supply`.

Flutter (`flutter-app/`):

```bash
flutter gen-l10n
flutter analyze
flutter test test/features/gst test/features/reports test/app
cd packages/khata_domain && flutter test   # shared GST contract vectors
```

Known gotchas:

- **vitest on Windows** only finds tests when the shell's working folder has an **uppercase** drive letter. Use PowerShell, or in Git Bash `cd "$(cygpath -m /d/Projects/Khataapp/flutter-app-backend)"`.
- Integration tests hit a remote TEST database: they are slow, so use long timeouts. GSTR-9 prepare is query-heavy.
- Never run a formatter over a whole directory; format only the files you changed.
- Windows desktop build failing with CMake "Permission denied": antivirus real-time scanning (see `GST_PENDING.md`), not the code.
- The Docker image copies `data/gstn-schemas` and `data/gstn-ledger`; rebuild after changing them.

---

## 12. Rules of the road

1. Stay inside the Phase 1 list in section 1. Ask before building anything else.
2. One calculation per figure: engines in `src/domain/gst/returns/`. No GST arithmetic in SQL report queries or in Flutter.
3. Never add a portal JSON key that is not in the official schema; never present an unverified rule as fact. Record assumptions in `GST_PENDING.md`.
4. Filed returns are immutable; do not add code that rewrites them.
5. Shared rules change on both sides (TS and Dart) with vectors.
6. Keep `GST_PENDING.md` current: when you close an item, move it to "Done" instead of deleting it.
