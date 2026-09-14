# Khata Backend

GST billing API for the Khata Flutter clients (Android, iOS, Windows, macOS) and the future React web app. One backend serves every platform.

Node 20+ · TypeScript (strict) · Express 5 · PostgreSQL (Supabase) · Redis

---

## Quick start

```bash
cp .env.example .env.development
npm install
docker compose up -d        # Postgres on :5433, Redis on :6379
npm run migrate
npm run seed
npm run dev                 # http://localhost:3000
```

Then `GET /healthz` to confirm it is up, and `/docs` for the API surface.

> **Port 5433 is deliberate.** A PostgreSQL installed directly on the host usually owns 5432; the container avoids it so the two cannot collide.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch mode with pretty logs |
| `npm run build` / `start` | Compile to `dist/`, run compiled output |
| `npm run migrate` / `migrate:status` | Apply pending migrations / show schema state |
| `npm run seed` | Development tenant, outlets, counters, sample catalogue |
| `npm test` | Unit tests, plus integration tests when Postgres is reachable |
| `npm run check` | `typecheck` + `lint` + `test` — what CI runs |

---

## The two environments

`APP_ENV` (`development` | `production`) drives behaviour. It is deliberately **separate** from `NODE_ENV`, which stays `production` in any built image so Express and the dependency tree take their optimised paths.

| | development | production |
|---|---|---|
| Secrets | `.env.development` (git-ignored) | injected by the platform; no `.env` on disk |
| Database | docker-compose Postgres | Supabase, as the `app_user` role |
| SMS | `console` — logs the OTP | real provider |
| OTP | `AUTH_DEV_FIXED_OTP` accepted for any number | random, hashed, single-use |
| `POST /v1/auth/dev-login` | enabled — token pair, no OTP | **route is never registered** |
| Logs | pretty, debug | JSON, info |

### Why the bypass is safe

A leaked dev bypass is total account takeover, so three independent guards stand between it and production:

1. **The process refuses to boot.** `src/config/env.ts` collects *every* unsafe production setting — the bypass, a fixed OTP, the console SMS provider, a placeholder JWT secret, a wildcard CORS origin, non-TLS database, connecting as Supabase's `postgres` role — and throws with the full list. It fails closed, loudly, at startup.
2. **The route does not exist.** The dev router is mounted behind `if (env.APP_ENV === 'development')` in `app.ts`, so in production the handler is never wired to a path — not merely guarded inside the handler.
3. **CI asserts both.** `src/config/env.test.ts` proves each violation is rejected and that development configurations are left alone. A regression fails the build.

Everything else is identical across environments, so development exercises the real code path.

---

## Architecture

```
Flutter (offline-first, local SQLite)  ──┐
React web (future)                     ──┼──►  Express API  ──►  Postgres (RLS)
Integrations (future)                  ──┘         │
                                                   └──►  Redis (rate limit, cache, OTP, idempotency)
```

Clients only ever talk to Express. Supabase is used as hosted Postgres — our own SQL, our own migrations, our own JWTs. No `supabase-js`, no Supabase Auth.

### Module layout

```
src/
├─ config/env.ts       the only place process.env is read; validates and freezes at boot
├─ lib/                errors, logger, context (ALS), money, ids, pagination
├─ db/                 pool, tx (tenant scoping), migrate, migrations/*.sql
├─ cache/              Redis client and degradation policy
├─ middleware/         request context, validation, error handling
├─ domain/             pure, dependency-free, unit-tested
│  ├─ tax/             the GST engine — mirrored in Dart
│  └─ numbering/       financial years, series formats, number blocks
├─ modules/<feature>/  routes → controller → service → repository
└─ observability/      Prometheus metrics
```

Every module follows `routes → controller → service → repository`. Controllers hold no logic, services own transactions, repositories own SQL.

---

## The four rules that shape everything

These come from the design constraints in [master-feature-list.md](master-feature-list.md) §1. Each one is a rewrite if retrofitted, so all four hold from the first migration.

### 1. Money is integer paise, never a float

Every amount — column, API field, intermediate value — is a whole number of paise. `0.1 + 0.2 !== 0.3` is not a curiosity in a billing product: over a few hundred bills a day it is a cash drawer that does not reconcile and a GST return that does not match.

`src/lib/money.ts` parses decimal strings directly rather than via `parseFloat`, and distributes amounts with the largest-remainder method so an apportioned discount sums to *exactly* the discount.

### 2. Tenant isolation is enforced by the database

Every table carries `tenant_id`, has RLS **enabled and forced**, and has a policy comparing against `app.current_tenant_id()`. `src/db/tx.ts` is the only sanctioned way to query, and it issues `SET LOCAL app.tenant_id` as the first statement of every transaction.

`SET LOCAL`, not `SET`: the Supabase pooler runs pgbouncer in transaction mode, so a session-scoped setting would leak one tenant's context onto the next tenant's query.

> **Never connect as Supabase's `postgres` role.** It has `BYPASSRLS`, which silently disables every isolation policy while the application still appears to work. `env.ts` refuses to start if the production connection string uses it.

A resource belonging to another tenant returns **404, not 403** — a 403 would confirm the record exists.

### 3. Documents are immutable; ledgers are append-only

Issued invoices are frozen by a database trigger; corrections are credit/debit notes. `stock_ledger_entries` has no UPDATE or DELETE path at all — reversals are negative entries. A ledger you can edit is not a ledger, and theft detection, stock audits and khata disputes all depend on that.

### 4. Offline-first means the device is the source of truth until it syncs

Documents carry client-generated UUIDv7s, so a retried upload over a flaky connection stores exactly one row. The tax engine runs identically on the device, so offline totals match the server. Sync cursors use a per-tenant counter allocated under a row lock — a plain `BIGSERIAL` would let sequence order diverge from commit order, and a client paging past the gap would lose that row permanently.

---

## Document numbering — the wedge

> "Your invoice numbers will never duplicate."

Four properties must hold at once, and the combination is what makes it hard:

- **Unique** — two cashiers billing simultaneously on one counter cannot collide.
- **Gapless** — GST expects a continuous series; gaps must be declarable in GSTR-1 Table 13, not hidden.
- **Offline** — a device with no network must still issue a legally numbered invoice.
- **FY-scoped** — the series resets on 1 April.

"Offline" rules out the obvious designs: a database sequence needs the network, and a client-side counter cannot know what other devices used. The answer is **leasing** — while online, a device reserves a contiguous block of numbers (default 50) and consumes them locally. Blocks never overlap, so offline issuance cannot collide. Unused numbers in an expired block are reported as gaps rather than recycled.

### The 16-character ceiling

GST rule 46(b) caps a document number at 16 characters. That is tighter than it sounds:

| Format | Room for | Max documents |
|---|---|---|
| `INV/2026-27/…` | 4 digits | 9,999 |
| `INV/26-27/…` | 6 digits | 999,999 |
| `INV/C1/26-27/…` | 3 digits | 999 |
| `INV/C1/…` | 9 digits | 999,999,999 |

So numbers use the short financial-year form, and a **per-counter series drops the year segment** — it is already implied by the invoice date. `validateSeriesFormat()` checks the *ceiling*, not a sample: a format that renders fine on invoice 1 and breaks on invoice 10,000 fails in February with the year's filings already depending on it.

---

## The tax engine

`src/domain/tax/` is a pure function — no clock, no database, no randomness. It has to be: the Dart port in the Flutter app must produce byte-identical results, or a device bills offline and the server rejects a sale whose cash is already in the drawer.

Order of operations (changing it changes every total in the system):

1. Line gross = `unitPrice × quantity`
2. Line discount
3. Bill discount, apportioned by post-line-discount value with largest-remainder
4. Back out tax if prices are MRP-inclusive
5. Tax per line
6. CGST/SGST split (intra-state) or IGST (inter-state)
7. Additional charges
8. Round-off to the nearest rupee, reported separately

**Rounding is half away from zero, applied once per line**, and totals are summed from rounded lines. Rounding the total independently is the classic invoice bug: the printed lines then do not add up to the printed total, and a customer who checks will find it. `Math.round` is not equivalent — it rounds `-2.5` to `-2`, so credit notes would round in the opposite direction from the invoices they reverse.

Covers GST and non-GST (unregistered) and composition modes, inclusive and exclusive pricing, cess, and produces the tax-rate breakup and HSN summary GSTR-1 needs.

---

## Printing

**ESC/POS bytes are generated on the device, never on the server.** Printers are BLE-attached to the phone and must work with no network, so the existing `ReceiptBuilder` in the Flutter app keeps that job.

The backend serves a `PrintDocument` — a resolved, tax-computed, template-applied structure of typed blocks (header, logo, line items, totals, QR, footer) — plus template and branding configuration. Column widths match the Flutter app's `PaperWidth`: 32 columns at 58 mm, 48 at 80 mm.

---

## Status

| Milestone | State |
|---|---|
| M0 — skeleton, config, logging, errors, health, Docker, CI | **done** |
| M1 — pool, tenant-scoped transactions, migration runner, foundation + tenancy schema | **done** |
| M2 — auth (OTP, JWT, refresh rotation), RBAC, outlets/counters, entitlements | in progress |
| M3 — rate limiting, idempotency, caching, OpenAPI | pending |
| M4 — tax engine, numbering | **done** (pure domain; repositories pending) |
| M5 — catalogue, customers, invoices, stock ledger, khata | pending |
| M6 — sync push/pull, print payload, integration suite, seed | pending |

Out of scope for this phase and slotting in later without touching the spine: purchases/PO, credit-debit notes, GSTR workings and 2B reconciliation, reports, WhatsApp, online storefront, multi-outlet transfer, vertical modules.
