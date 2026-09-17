# Khata Backend — Project Context

> **Purpose.** A handover document. Load it at the start of a new session (human or AI) to continue work without re-deriving what was decided, built, verified, or learned. It records state as of **17 September 2026**, after milestones **M1** and **M2**.
>
> **Contains no secrets.** Credentials live only in `.env.development`, which is gitignored.

---

## 1. Product and stack

GST billing and khata (customer credit ledger) app for Indian retail. **One backend** serves Flutter clients on Android, iOS, Windows and macOS, and a future React web app.

- Node 20.11+ (running 22.20), TypeScript strict, ESM, Express 5
- Supabase Postgres (via the Supavisor pooler), Redis
- Zod validation, pino logging, prom-client metrics, jose JWT
- Vitest 5 + supertest; ESLint 9 flat config (`recommendedTypeChecked`); Prettier

Product backlog: [`master-feature-list.md`](../master-feature-list.md) (phases P0–P3, a cut list, monetisation gating).

Reference repo reviewed: `piratuks/invoice-builder` (MIT). It is an Electron desktop app (React + SQLite + `@react-pdf/renderer`), **not** a dependency candidate. Only three ideas are worth borrowing: its layout-builder JSON as prior art for print templates, its 80mm thermal layout, and its UBL 2.1 / Peppol XML export for P3 e-invoicing.

---

## 2. Codebase conventions (follow these)

**Module layout.** `src/modules/<name>/<name>.routes.ts | .service.ts | .repository.ts | .schemas.ts`.

- **Routes**: permission check → `validate()` → service → `{ data }` / `{ data, nextCursor }`.
- **Services**: own transactions, cross-module rules, `recordAudit`, metrics.
- **Repositories**: own SQL; alias columns `AS "camelCase"`; a `COLUMNS` whitelist for `buildSet`.

**Database access.** Only through `src/db/tx.ts`: `withTransaction`, `withReadTransaction`, `withUnscopedTransaction`. It sets tenant context with `set_config(..., true)` (transaction-scoped). **Never** use a session-scoped `SET` — see §8.

**New tenant tables** must call `app.setup_tenant_table('<table>')` (RLS + FORCE + policy + `server_seq`/`updated_at` triggers + sync index). Immutable documents add `app.guard_document_update(...)` and `app.restrict_table(..., ARRAY['DELETE'])`; append-only ledgers use `restrict_table(..., ARRAY['UPDATE','DELETE'])`. **Every migration ends with `SELECT app.grant_runtime_privileges();`**.

**Configuration.** Only `src/config/env.ts` may read `process.env` (ESLint-enforced). Every variable is required unless marked optional, with no in-code defaults. A new variable goes into `env.ts`, `.env.example` and `tests/fixtures/env.ts` in the same change. `assertProductionSafety` and `assertCoherence` gate boot.

**Money and quantities.** Money is integer **paise**; quantities are **thousandths** of a unit. No floats in the money path.

**Errors.** `ErrorCode` values in `src/lib/errors.ts` are the client contract and are **additive only**; never rename one.

**Client IDs.** Clients generate UUIDs. Creating with an existing id returns the existing record, which is what makes offline retries safe.

**API contract.** Success `{ data }` or `{ data, nextCursor }`; errors `{ error: { code, message, details?, requestId } }`. A resource in another tenant returns **404, never 403**.

---

## 3. Built before this work began

Auth (OTP, JWT, rotating refresh tokens with reuse detection, dev-login bypass), RBAC (5 roles, 25 permissions in `src/modules/auth/permissions.ts`), tenants and onboarding, outlets, counters, members, devices, entitlements (quotas), catalogue, customers and khata ledger, document numbering (device-leased blocks), invoices (issue/void/printed), payments (receipts + allocations), stock ledger, health (`/healthz`, `/readyz`, `/metrics`).

The pure GST tax engine (`src/domain/tax/engine.ts`) is mirrored by a Dart port on the client. The server recomputes every uploaded invoice and rejects disagreement with `TOTALS_MISMATCH`.

### Route surface (all under `/v1`)

| Area | Routes |
| --- | --- |
| Auth | `/auth/otp/request`, `/auth/otp/verify`, `/auth/sessions`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/dev-login` (development only) |
| Tenancy | `/onboarding/tenants`, `/tenant`, `/tenant/subscription`, `/members`, `/devices`, `/outlets`, `/counters` |
| Catalogue | `/categories`, `/items`, `/items/by-barcode/:barcode` |
| Customers | `/customers`, `/customers/:id/ledger` |
| Numbering | `/numbering/series`, `/numbering/series/:id/leases`, `/numbering/series/:id/gaps`, `/numbering/leases` |
| Billing | `/invoices`, `/invoices/:id/void`, `/invoices/:id/printed`, `/payments`, `/payments/:id/void` |
| Stock | `/stock/balances`, `/stock/ledger`, `/stock/adjustments` |
| Audit | `/audit` *(added in M1)* |

### Migrations applied

`0001_foundation` · `0002_tenancy` · `0003_catalogue_customers` · `0004_billing_stock` · `0005_hardening` *(M1)*

---

## 4. Roadmap

Approved plan; executed **milestone by milestone with a review between each**. The full plan also exists locally at `~/.claude/plans/role-you-are-validated-moth.md` (not in the repo — this document is the portable version).

| # | Milestone | Status |
| --- | --- | --- |
| M1 | Schema debt, audit route, entitlement primitives | ✅ Done |
| M2 | Integration test infrastructure | ✅ Done |
| M3 | OpenAPI from the existing Zod schemas | ⏭ Next (pending decision, §11) |
| M4 | Sync push/pull — highest risk | Pending |
| M5 | Credit notes and returns | Pending |
| M6 | Held bills, expenses, day close | Pending |
| M7 | Reports kernel + 12 P0 reports | Pending |
| M8 | Print payloads, templates, custom fields | Pending |
| M9 | Outbox, idempotency middleware, WhatsApp, alerts | Pending |
| M10 | Bulk import/export, barcode labels | Pending — **P0 complete** (~19.5 weeks total) |
| M11–M14 | Purchases · pricing/discounts/banking/UPI · GST compliance · storefront | P1 (~11 weeks) |
| M15–M18 | Multi-outlet · sales workflow chain · one vertical (pharmacy recommended) · i18n/stock count | P2 (~11 weeks) |
| M19–M21 | Tally sync · e-invoice/e-way bill · loyalty/theft detection/GTIN | P3 (~8.5 weeks) |

---

## 5. Decisions already made (do not re-litigate)

1. **One sequenced roadmap**, executed milestone by milestone.
2. **Rendering**: the server returns a normalised, template-resolved **print payload** (JSON). Flutter renders ESC/POS and PDF locally. **No server-side PDF engine.**
3. **Integration tests run against a dedicated Supabase test project** (real pooler, real roles).
4. **Integration tests before sync; OpenAPI alongside; idempotency middleware after sync.** Sync push must **not** use an `Idempotency-Key` header — a batch is partially retryable, and a header-scoped cache would make a partly failed batch non-retryable.
5. **Sync design**: a single tenant-wide `server_seq` watermark covers every table. Push dispatches to existing services (no business logic in the sync module), **one transaction per operation**, HTTP 200 with per-operation `applied | replayed | rejected` and an explicit `retryable` flag. Mutable masters use optimistic concurrency (`baseServerSeq` → `STALE_WRITE`), not last-writer-wins.
6. **Credit notes get their own tables**, not a discriminator column on `invoices` (the `payment_allocations` FK, the `grand_total >= 0` CHECK, and every existing aggregate argue against merging).
7. **Reports**: one shared kernel and registry behind `GET /reports/:reportId`, with outlet scoping applied at a single point. **Never** a generic query endpoint.
8. **Print**: layouts live in code; template selection, overrides, custom-field definitions and the print profile live in the database. Custom-field *values* are write-once JSONB on the document.

---

## 6. M1 — completed

**Goal.** Close schema and utility gaps that later milestones would otherwise inherit.

**Migration `0005_hardening.sql`**

- `item_barcodes`: added `deleted_at`; `item_barcodes_uq` recreated as partial `WHERE deleted_at IS NULL`. Hard deletes were invisible to syncing devices, which kept resolving deleted barcodes.
- `invoice_lines`: added and backfilled `outlet_id` and `document_date` (`NOT NULL`, FK to outlets), so item-wise and category-wise reports need no join. Safe to denormalise because the table forbids UPDATE.
- New indexes: `invoice_lines_item_idx`, `invoice_lines_outlet_idx`, `payments_outlet_idx`, `payments_mode_idx`, `customer_ledger_time_idx`.

**Code**

- New audit module: `src/modules/audit/audit.{routes,service,repository,schemas}.ts` → `GET /v1/audit` (filters, newest-first keyset paging; `audit_log.id` is BIGSERIAL, rendered as text).
- `src/modules/entitlements/entitlements.ts`: `FEATURES` catalogue, `hasFeature` (lookup order: exact key → `group.*` → `*`; an explicit `false` overrides a wildcard), `assertFeature` (throws `FEATURE_NOT_IN_PLAN`, 402). The free subscription seeds `features` from `PLAN_FREE_FEATURES`.
- `recordAudit` now fires on invoice **issue** and payment **receipt**, not only on void.
- Barcode reads filter `deleted_at IS NULL`; `replaceBarcodes` and `softDeleteItem` soft-delete.
- `invoicesRepository.insertLines` takes `outletId` and `documentDate` as arguments.
- Added `ErrorCode.FEATURE_NOT_IN_PLAN`; env var `PLAN_FREE_FEATURES` (optional CSV).

**Verified** directly in the catalogs after applying: all four `invoice_lines` triggers re-enabled (`tgenabled = 'O'`), `relforcerowsecurity` restored, partial index confirmed, all indexes present. App role `khata_api` confirmed `rolsuper = false`, `rolbypassrls = false`.

---

## 7. M2 — completed

**Goal.** Prove the database-level guarantees against a real database before building sync on top of them.

**Harness** — `tests/integration/setup/`

| File | Role |
| --- | --- |
| `env.ts` | Reuses the unit fixture, swaps in real DB settings. Requires explicit `TEST_DATABASE_URL` / `TEST_DATABASE_MIGRATION_URL`; loads `.env.development` locally via `process.loadEnvFile`. Redis stays unreachable on purpose (rate limiting fails open; dev-login needs no OTP). |
| `database.ts` | Owner connection; `assertSchemaReady` (all migrations applied, app role cannot bypass RLS); `truncateAll`. |
| `global-setup.ts` | Asserts schema, truncates once per run. Does **not** apply migrations. |
| `tenant.ts` | `createTenant()` onboards through the real API (dev-login → `POST /onboarding/tenants`) and returns authenticated request helpers. Generates unique phone numbers and GSTINs. |
| `fixtures.ts` | `createItem`, `createCustomer`, `createSeries`, `leaseBlock`, `invoicePayload`, `expectedTotals` (computed independently of the server engine on purpose). |
| `body.ts` | Typed `data()`, `rows()`, `error()` envelope accessors; `expectStatus()` (reports the error body on a status mismatch). |
| `write-env-file.ts` | CI-only generator for `.env.development`; refuses to overwrite outside `CI=true`. |

**Suites — 37 tests, 6 files, all passing**

| File | Proves |
| --- | --- |
| `tenancy.test.ts` | Onboarding, cross-tenant 404, no list leakage, 401 on missing/bad tokens |
| `sync-sequencing.test.ts` | `server_seq` unique, increasing under concurrent writers, never below a published watermark, per-tenant counters |
| `numbering.test.ts` | Contiguous blocks, **no overlap under concurrent leases**, format ceiling, idempotent series creation |
| `billing.test.ts` | GST totals, `TOTALS_MISMATCH`, `NUMBER_NOT_LEASED`, replay idempotency, stock + khata restored exactly on void, voided numbers kept, `CREDIT_SALE_REQUIRES_CUSTOMER`, receipts settle khata |
| `immutability.test.ts` | Trigger blocks financial edits; revoked DELETE/UPDATE on invoices, lines, ledgers, audit log; print counter still moves |
| `hardening.test.ts` | Barcode soft-delete stops resolving, keeps the row, frees the barcode for reuse; audit written on issue; audit paging |

**Other changes**: `vitest.integration.config.ts` (serial files, 30 s timeouts); `vitest.config.ts` now **excludes** `tests/integration/**`; npm scripts `test:integration` and `ci:env`; CI `integration` job (needs `verify`, skipped for forks); ESLint exempts `write-env-file.ts` from `no-console`; README gained a Tests section.

---

## 8. Hard-won findings (read before touching these areas)

1. **Supabase direct host is IPv6-only.** `db.<ref>.supabase.co` has only AAAA records and fails with `ENOTFOUND` here. Use the Supavisor pooler: `aws-0-ap-south-1.pooler.supabase.com` — port **6543** (transaction mode) for the API, **5432** (session mode) for migrations, which hold a session-level advisory lock. Pooler usernames are `<role>.<project-ref>`.
2. **TLS chain is untrusted by Node.** Supavisor fails verification with `self-signed certificate in certificate chain`. Locally `DATABASE_SSL_REJECT_UNAUTHORIZED=false` (still encrypted, not chain-verified). **Production must verify** — see debt §10.1.
3. **Session-scoped settings leak across pooled backends — observed, not theorised.** A brand-new connection reported `app.tenant_id` set by an earlier one. Always use `set_config(key, value, true)` inside a transaction. Any sync test that sets tenant context at session scope will corrupt other tests non-deterministically.
4. **`npm test` could have wiped the database.** Integration files matched `vitest.config.ts`'s `tests/**` glob; importing their harness swapped in the live `DATABASE_URL`, and `beforeAll` truncates. Fixed with an explicit exclude. Symptom to watch for: the unit count rising above 106.
5. **Migrations run as the owner, and FORCE RLS still applies to the owner.** `app.current_tenant_id()` is NULL in a migration, so a backfill `UPDATE` on a tenant table silently matches zero rows. `restrict_table` triggers also fire for the owner. A backfill must suspend the relevant triggers and `NO FORCE ROW LEVEL SECURITY`, then restore both — see `0005_hardening.sql` — and should suspend the `server_seq` trigger to avoid republishing every row to every device.
6. **`migrate.ts` and `bootstrap.ts` are CLI-only.** They run at module top level and call `process.exit`; they cannot be imported by a test harness.
7. **Importing `src/config/env.ts` validates all ~97 variables**, so any script touching it (including `migrate`) needs a complete env, not just database secrets.
8. **Uniqueness constraints that shape fixtures**: `document_series_scope_uq` allows one series per (outlet, counter, document type, **financial year**) — prefix is not part of it. `tenants_gstin_uq` is **global** across tenants.
9. **An unpaid invoice needs a customer** (`CREDIT_SALE_REQUIRES_CUSTOMER`); tests without a customer must tender the full total.
10. **Concurrent vitest runs share a transform cache** and can produce spurious whole-suite failures. Run `check` and `test:integration` sequentially.
11. **ESLint `no-console` is not relaxed for `tests/**`** (only `no-restricted-properties` is). CLI scripts need an explicit exemption.
12. **Typed test bodies.** `supertest`'s `res.body` is `any`, so `recommendedTypeChecked` rejects direct member access — use `body.ts`.

---

## 9. Feature coverage vs `master-feature-list.md`

**Not complete.** Roughly half of P0 has backend support; **P1, P2 and P3 are at zero.**

**§1 Non-negotiable rules — 7 of 8 hold** (immutable invoices, append-only stock, per-counter number blocks, client UUIDs, pure shared tax engine, seat/outlet metering, DB-enforced isolation; four of these are test-proven). **i18n is partial**: `locale` columns only.

**§2 P0**

| Area | Built | Missing |
| --- | --- | --- |
| 2.1 Billing | GST + non-GST, barcode lookup, fuzzy/alias search, line and bill discounts, round-off, charges, split tender, change due, void + audit | Held/parked bills; returns via credit note; offline mode is foundations only (no sync) |
| 2.2 Invoice output | — | All six items |
| 2.3 Catalogue | Items with HSN/tax/MRP/prices/UOM, categories, multiple barcodes, service items | Bulk Excel import/export; barcode labels |
| 2.4 Inventory | Adjustments with reason codes; reorder level + `belowReorder` filter | Stock movement on purchase/return; low-stock alerts; fast/dead-stock views |
| 2.5 Customers & khata | Master, ledger + statement, credit-limit warning, purchase history | WhatsApp reminders |
| 2.6 Money | Receipts with partial and multi-invoice allocation | Expenses; day close |
| 2.7 Reports | — | All 12 |
| 2.8 Platform | RBAC; one API for all clients | Sync/backup; languages |

**§6 Wedges — 1 of 4**: document numbering is built and proven (gap reporting still invoice-only). Onboarding import and GSTR-2B are unbuilt; support is not software.

**§8 Monetisation**: quotas enforced. Feature gating exists but has **zero call sites** — nothing is gated yet (M7 wires it).

---

## 10. Known debts and open items

1. **TLS verification disabled locally.** `src/db/pool.ts:36` and `src/db/migration-client.ts:11` hardcode `ssl: { rejectUnauthorized }` with no CA option. Production needs a new `DATABASE_SSL_CA` variable threaded into both.
2. **`JWT_SECRET` is a placeholder** in `.env.development`. Harmless in development; `assertProductionSafety` will block a production boot until replaced.
3. **Development and integration tests share one Supabase project.** `DATABASE_URL` and `TEST_DATABASE_URL` point at the same database, and **the integration suite truncates every table**. Split them before this database holds anything worth keeping.
4. **CI secrets not yet configured**: `TEST_DATABASE_URL`, `TEST_DATABASE_MIGRATION_URL`, `TEST_DATABASE_APP_ROLE_NAME`, `TEST_DATABASE_APP_ROLE_PASSWORD` must be added to GitHub repository secrets before the `integration` job can pass.
5. **`assertFeature` has no call sites** — mechanism only.
6. **`expectStatus` is not retrofitted** onto existing assertions, which still use `.expect(status)` and report only the number on failure.
7. **Gap reporting is invoice-only** (`src/modules/numbering/numbering.service.ts:171`); fixed in M5.
8. **Blockers still pending for M4** (found during planning, not yet fixed):
   - `devices.last_sync_seq` sits on a `setup_tenant_table` table, so writing it allocates a new `server_seq` → non-convergent sync loop. Move to a non-synced `device_sync_state` table.
   - `tx.ts` cannot open `REPEATABLE READ`; a multi-table pull under READ COMMITTED can permanently skip rows.
   - Master creates (`createCustomer`, `createItem`, `createCategory`) must be verified replay-idempotent before being registered as pushable.
   - A `users` rename does not bump `memberships.server_seq`, so renamed staff never reach devices.
9. **Nothing is committed.** All M1 and M2 work is uncommitted on `main`.

---

## 11. Next step and pending decision

**Recommended**: M3 (OpenAPI, ~1 week), then M4 (sync). Five client platforms consume this API, and sync envelopes should be specified before they are built. "Offline mode" and "cloud sync" are two separate P0 items, both blocked on M4.

**Alternative raised with the owner, undecided**: reorder to **M5 credit notes → M6 expenses/day close/held bills → M7 reports** for visible product sooner. Trade-off: sync is then built later against a larger surface.

---

## 12. Command reference

```bash
npm run dev                  # watch mode, loads .env.development
npm run check                # typecheck + lint + unit tests (expect 8 files / 106 tests)
npm run format:check         # CI gate; covers ts, json, md, yml
npm run migrate:status       # list migrations (owner connection, session pooler)
npm run migrate              # apply pending migrations
npm run db:bootstrap         # create/update app role khata_api, revoke Data API grants
npm run test:integration     # 6 files / 37 tests against the TEST_ database — TRUNCATES IT
npm run ci:env               # CI only: compose .env.development from fixtures + secrets
```

Setup order on a fresh database: `migrate` → `db:bootstrap` → `dev` or `test:integration`.
