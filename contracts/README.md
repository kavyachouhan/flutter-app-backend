# Contract vectors

Machine-checked fixtures that pin the behaviour of the pure domain code this
backend shares with its clients. The Flutter app ports the tax engine and the
numbering rules to Dart so it can bill offline; the server recomputes every
uploaded invoice and rejects any disagreement with `TOTALS_MISMATCH`. These
files are how both sides prove they agree before a device ever goes offline.

| File                     | Source of truth                                 | Consumer                                   |
| ------------------------ | ----------------------------------------------- | ------------------------------------------ |
| `tax-vectors.json`       | `src/domain/tax/engine.ts` + `src/lib/money.ts` | `packages/khata_domain` (Dart) parity test |
| `numbering-vectors.json` | `src/domain/numbering/series.ts`                | `packages/khata_domain` (Dart) parity test |

## Rules

- **Generated, never edited.** `npm run contracts:generate` rewrites both files
  from the current engine. `tests/contracts/contracts.test.ts` fails when a
  committed file no longer matches the engine, so a change to totals is always
  a deliberate, reviewed diff.
- **Deterministic.** The random sweep uses a fixed seed (`tests/contracts/prng.ts`);
  regenerating without an engine change produces an identical file.
- **The client copies, it does not link.** The Flutter repository keeps its own
  copy under `packages/khata_domain/test/fixtures/` and its CI compares that
  copy against this directory; a drift fails the client build.
- **Version.** `version` increments only when the file _format_ changes. An
  engine change that alters expected values keeps the version and shows up as
  a diff in `cases`.

## Format

Each file is `{ contract, version, notes, ..., cases[] }`. Every case has a
`name`, an `input`, and an `expected` that is either `{ result }` or
`{ error: { code, message } }`. Ports must:

- match `result` exactly, including array order;
- reject the same inputs that carry `error` (the message may differ);
- treat an absent key as `undefined`/`null` — `JSON.stringify` drops undefined
  members, so a line with no `hsnCode` simply has no such key.

See the `notes` array inside each file for contract-specific detail.
