# Khata Backend

GST billing API for the Khata Flutter clients (Android, iOS, Windows, macOS) and the future React web app.

Node 20.11+ · TypeScript (strict) · Express 5 · Supabase Postgres · Redis

## Setup

```bash
npm install
cp .env.example .env.development   # fill in every value; there are no in-code defaults
npm run infra:up                   # local Redis (docker compose)
npm run migrate                    # as the owner role, via DATABASE_MIGRATION_URL
npm run db:bootstrap               # creates the API's login role, revokes Data API grants
npm run dev
```

`GET /healthz` confirms the process is up; `GET /readyz` checks Postgres and Redis.

### Supabase connections

| Variable                 | Connects as              | Pooler mode       | Used by                   |
| ------------------------ | ------------------------ | ----------------- | ------------------------- |
| `DATABASE_URL`           | `DATABASE_APP_ROLE_NAME` | transaction       | the running API           |
| `DATABASE_MIGRATION_URL` | `postgres`               | session or direct | `migrate`, `db:bootstrap` |

The API must never connect as `postgres`, `supabase_admin` or `service_role`: those roles bypass row-level security, which silently disables every tenant boundary. `env.ts` refuses to boot production if it does, and `db:bootstrap` refuses to finish if the app role can bypass RLS.

Migrations need a session-mode connection because they hold a session-level advisory lock.

### Configuration

Every tunable is an environment variable validated by `src/config/env.ts`; a missing value stops boot. This includes things that look like constants but are set by law or policy — the notified GST rates, the document-number length limit, plan limits — so a change is a config update, not a deploy.

The remaining literals in code are contracts rather than settings: paise and thousandths-of-a-unit scales shared with every client, HTTP status codes, and formats defined by GST law or ISO/ITU standards.

## Environments

`APP_ENV` is `development` or `production`, independent of `NODE_ENV`.

Development may enable `AUTH_DEV_BYPASS` (mounting `POST /v1/auth/dev-login`) and `AUTH_DEV_FIXED_OTP`. Three independent guards keep these out of production:

1. `env.ts` refuses to boot with either enabled, and reports every unsafe setting at once.
2. `v1-router.ts` never mounts the dev router outside development.
3. `src/config/env.test.ts` asserts both in CI.

## API

All routes are under `/v1`. Success responses are `{ data }`, or `{ data, nextCursor }` for lists; errors are `{ error: { code, message, details?, requestId } }`, and clients should branch on `code`.

### Authentication flow

1. `POST /auth/otp/request` → `POST /auth/otp/verify` returns an **identity token** and the user's tenants.
2. With the identity token: `POST /onboarding/tenants` (new business) or `POST /auth/sessions` (existing tenant) returns an **access token** and a **refresh token** bound to the device.
3. `POST /auth/refresh` rotates the refresh token. Presenting an already-rotated token outside `REFRESH_TOKEN_REUSE_GRACE_SECONDS` revokes the device's session.

Access tokens are stateless, so role changes apply at the next refresh; deactivating a member or device revokes refresh tokens immediately.

### Modules

| Area      | Routes                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Auth      | `/auth/otp/*`, `/auth/sessions`, `/auth/refresh`, `/auth/logout`, `/auth/me`                              |
| Tenancy   | `/onboarding/tenants`, `/tenant`, `/tenant/subscription`, `/members`, `/devices`, `/outlets`, `/counters` |
| Catalogue | `/categories`, `/items`, `/items/by-barcode/:barcode`                                                     |
| Customers | `/customers`, `/customers/:id/ledger`                                                                     |
| Numbering | `/numbering/series`, `/numbering/series/:id/leases`, `/numbering/series/:id/gaps`, `/numbering/leases`    |
| Billing   | `/invoices`, `/invoices/:id/void`, `/invoices/:id/printed`, `/payments`, `/payments/:id/void`             |
| Stock     | `/stock/balances`, `/stock/ledger`, `/stock/adjustments`                                                  |

Roles and their permissions are defined in `src/modules/auth/permissions.ts`.

## Design rules

**Money is integer paise; quantities are thousandths.** No floating point in the money path.

**Tenant isolation is enforced by Postgres.** Every tenant table has forced RLS; `src/db/tx.ts` sets the tenant with `SET LOCAL` per transaction, because a session setting would leak across tenants on a transaction-mode pooler. A resource in another tenant returns 404, never 403.

**Documents are immutable; ledgers are append-only.** Issued invoices and payments may only change status/print fields (trigger-enforced); corrections are voids and reversing entries. Stock and customer balances are trigger-maintained projections of their ledgers.

**Clients generate ids.** Creating with an id that already exists returns the existing record, so an offline device can retry uploads safely.

**The tax engine is shared.** `src/domain/tax` is pure and must match the Dart port. The server recomputes every uploaded invoice and rejects it with `TOTALS_MISMATCH` if the device disagrees.

**Offline sales are accepted, then flagged.** An invoice upload is rejected only for structural problems (unleased number, mismatched totals, unpaid credit without a customer). Conditions a device could not see offline — credit limit, negative stock — come back as `warnings`.

### Document numbering

Devices lease contiguous number blocks per series and issue from them offline. An exclusion constraint makes overlapping blocks impossible, so two devices can never issue the same number. Unused numbers in expired blocks are reported by `/numbering/series/:id/gaps` for GSTR-1 Table 13 and never reissued.

Series formats are validated against `DOCUMENT_NUMBER_MAX_LENGTH` using the highest number they will ever print, not a sample, so a format cannot overflow mid-year. Outlet and counter codes cannot change while a series prints them.

## Scripts

| Command                                          | Purpose                                        |
| ------------------------------------------------ | ---------------------------------------------- |
| `npm run dev`                                    | Watch mode, loads `.env.development`           |
| `npm run build` / `npm start`                    | Compile to `dist/` / run it                    |
| `npm run migrate` / `migrate:status`             | Apply / list migrations (development env file) |
| `npm run db:bootstrap`                           | Create the app role and revoke Data API grants |
| `npm run migrate:deploy` / `db:bootstrap:deploy` | Same, from `dist/` with injected env           |
| `npm run check`                                  | Typecheck, lint, unit tests                    |

Migrations are forward-only and checksummed; editing an applied migration is refused.

## Status

Done: production skeleton, Supabase data layer and RLS, auth (OTP, JWT, refresh rotation, dev bypass), RBAC, tenants, outlets, counters, members, devices, plan metering, catalogue, customers and khata ledger, document numbering, invoices, payments, stock ledger.

Not yet: OpenAPI docs, idempotency keys and response caching (M3), sync push/pull and print payloads (M6), integration tests against a Supabase test project.
