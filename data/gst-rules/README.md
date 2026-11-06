# GST rules: how to change them

GST law changes by notification, so the rules are data here, written the way the law is:
one small file per notification. Almost every change is a new file and one command, with no code
change and no app release. Devices download published versions.

| Path | What it is |
|---|---|
| `data/CBIC/` | The source documents: notification PDFs and the HSN/SAC workbook |
| `data/gst-rules/notifications/*.json` | One file per notification: what it adds and what it ends |
| `data/gst-rules/base.json` | Reference data that is not dated law: state codes, UQC, GSTR-1A field lists |

## Current state: nothing can be published yet

This folder holds only what was read from a CBIC PDF in `data/CBIC`: Notifs. 02–10/2026-CT(R).
There is no verified foundation yet, so `base.json` is empty and these are missing: state codes, UQC,
allowed rates, thresholds, the cess rule, and the rate schedules (9/2025, 10/2025 and their amendments).
`check` reports `No cess rule in force` and `publish` refuses until the cess rule is added from its source.

## When a new notification arrives

1. Put the PDF in `data/CBIC/`. `check` fails until a rule file accounts for it, so none can be forgotten.
2. Add `notifications/<effective-date>-<number>-ctr.json`:

   ```json
   {
     "notification": "11/2026-CT(R)",
     "issued": "2026-12-20",
     "effectiveFrom": "2027-01-01",
     "sourceFile": "data/CBIC/notfctn_11_CTR_En.pdf",
     "verificationStatus": "primary_verified",
     "treatment": "encoded",
     "add": {
       "taxRates": [
         {
           "id": "hsn-1234-new-rate",
           "scope": { "kind": "hsn", "codePrefixes": ["1234"] },
           "taxability": "taxable",
           "ratePercent": 5,
           "condition": null,
           "exemptionBasis": null,
           "rcmCategoryCode": null
         }
       ]
     },
     "end": { "taxRates": ["hsn-1234-old-rate"] }
   }
   ```

3. `npm run gst:rules -- check`
4. `npm run gst:rules -- publish`

Rates are the full GST rate. A notification's Schedule I "2.5%" is central tax, so write `5`.

## What a file can say

- **`treatment`**:
  - `encoded`: the rule changes are in this file.
  - `no_rule_impact`: read, and nothing the engine evaluates changes. Needs a `reason`.
  - `deferred`: changes rules, not encoded yet. Needs a `reason`; `check` lists these so they stay visible.
- **`add` / `end`**: `end` closes an earlier entry by id on this notification's effective date. Earlier
  documents keep the old rule, because entries are dated and never removed.
- **Collections**: `allowedRates`, `taxRates`, `thresholds`, `rcmCategories`, `blockedCredits`,
  `einvoiceExclusions`, `validationRules`, `ewbIntraStateThresholds`, plus a `cess` block.
- **`verificationStatus`**: `primary_verified` requires `sourceFile`. A version with an in-force rate
  still `secondary_only` cannot be published; `--draft` stores it for review and it is never selected.
- **Conditions on a rate**:
  - `unit_value_at_most` and `unit_value_above` are worked out automatically (value in paise).
  - `manual_selection` means the seller chooses between candidates.
- **Portal validations**: switching a check between `warn` and `block` is a change to `validationRules`
  here, with no code change.

## If a published rule turns out to be wrong

Fix the file and publish again. The version gets a new revision of the same date. The old revision stays
readable, and documents keep the revision they were computed with: nothing issued is recomputed.

## When code does have to change

Only for something new in kind: a new rule type (`ThresholdKey`, `TaxRateConditionKey`), or a new
statutory calculation. Those are in `src/domain/gst/` with a Dart twin in
`packages/khata_domain/lib/src/gst/`, proven equal by the vectors in `contracts/`.

## The HSN/SAC master

Download the list from the GST portal (Services > User Services > Search HSN Code > Download HSN
Directory), replace `data/CBIC/HSN_SAC.xlsx` (sheets `HSN_MSTR` and `SAC_MSTR`) and run
`npm run gst:rules -- hsn`.

The download holds a few rows whose code has no leading zero or contains a space (`40210`, `2307 00`),
each beside a row with the proper code (`040210`, `230700`). The portal's own search recognises `040210`
and not `40210`, so the properly formed row is kept. The import lists every row it changes or leaves
out; check that list when you load a new download. A code that makes no sense at all stops the load.

The master holds codes and descriptions only. Many descriptions read "OTHER", so a picker should show
the parent code's description too. Rates come from the rule set.
