# Prompt schema migration compatibility (v2 → v3)

Issue: #1010 · Code: `server/src/services/schemaMigrationCompatibility.ts`,
`server/scripts/checkSchemaCompatibility.ts` · Tests:
`server/src/tests/schemaMigrationCompatibility.test.ts`

The current Prompt storage contract is **v2**. The next version, **v3**,
removes the long-deprecated aliases:

| Removed in v3 | Replaced by |
| --- | --- |
| `image` | `imageUrl` |
| `price` | `priceStroops` |
| `isActive` | `active` |
| `listingStatus` | `lifecycleState` |

Removing a field is safe only when every document can be mapped without
guessing. The compatibility checker proves that before a migration is written.
It is read-only: it never connects to MongoDB unless `--mongo` is requested,
and it never mutates the input documents.

## Why `price` is blocked, not converted

Legacy `price` predates the stroop contract and has no documented unit.
Multiplying it would silently change what a buyer pays. A record with `price`
but no `priceStroops` is therefore a blocking
`unmapped_deprecated_field` error. Backfill `priceStroops` from the original
catalog or on-chain listing, verify the amount, and re-run the check.

When both fields exist, `price` is dropped and the mismatch is reported as a
**warning** so the operator can confirm that `priceStroops` is authoritative.

## Checks performed

For each record the checker reports:

- `future_schema_version` — record was written by a build newer than the
  target. Never downgrade such data; upgrade the running build instead.
- `legacy_version_upgrade` — v0/v1 records will receive v0→v2 defaults while
  upgrading to v3. Warning only; review the reported defaults.
- `conflicting_rename` — alias and replacement disagree (`image`/`imageUrl`,
  `active`/`isActive`, `listingStatus`/derived `lifecycleState`). Blocking.
- `unmapped_deprecated_field` — only `price` exists. Blocking.
- `missing_required_field` — a v3 required field is absent and cannot be
  derived safely. The safe defaults for `category`, `description`, `tags`,
  `licence`, and `moderationStatus` are already applied by the read path;
  `lifecycleState` is back-derived by the documented v0→v2 fallback (moderation
  → inactive flag → listing status → `draft`). `title` cannot be invented.
- `invalid_field_type` — string/array fields have the wrong shape.
- `invalid_record` — the export entry is not a JSON object.
- `unsupported_target_version` — the build only knows how to prepare v3.

The report includes a deterministic `fingerprint` over the candidate records,
an explicit migration plan, and a rollback plan.

## Running the gate

```bash
# Against a backup/restore-point export (array or {"records": [...]}):
cd server
npm run schema:compat -- --input /secure/backup/prompts-v2.json

# Full machine-readable report:
npm run schema:compat -- --input /secure/backup/prompts-v2.json --json

# Read-only scan of the live database:
MONGODB_URI=mongodb://... npm run schema:compat -- --mongo --limit 10000

# Explicit target (used to prove the gate rejects unknown versions):
npm run schema:compat -- --input snapshot.json --to-version 3
```

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Every record is migratable without information loss |
| `1` | At least one record is blocked, or the input could not be read |
| `2` | Invalid command-line arguments |

Warnings do not fail the gate; errors do. `--json` emits the complete report,
including per-record candidates, issues, fingerprint, and both plans.

## Migration procedure

1. Pause Prompt writers and take a verified backup/restore point.
2. Export the same snapshot and run the compatibility check. Require
   `compatible: true`; review every warning and every `unknownFields` entry.
3. Apply `buildPromptV3Candidate` in batches, stamping `schemaVersion: 3`.
4. Validate the post-migration snapshot with the same checker before
   re-enabling writers.
5. Deploy the read path that expects v3. Keep v2 fingerprints for comparison.

## Edge cases

- **Future-version records.** A v4 record mixed into the snapshot blocks the
  run. Do not rewrite it with v3 code. Roll the deployment forward.
- **Conflicting aliases.** Resolve the canonical value first. The checker will
  not choose between two different URLs or two disagreeing `active` flags.
- **Unknown status strings.** `lifecycleFromListingStatus` returns `undefined`
  for unrecognised values; if no `lifecycleState` exists the record is blocked
  as missing rather than defaulted to `draft`.
- **Custom fields.** Unknown fields are carried through unchanged and listed in
  `unknownFields` so a reviewer can decide whether they belong in v3.
- **Same snapshot, same fingerprint.** Re-running a check is deterministic. A
  different record order produces a different fingerprint; always export in a
  stable order when comparing runs.
- **Partial apply.** Batches are independent. Stop at a batch boundary and
  restore the backup if the post-check fails.

## Rollback

The checker never mutates data, so rollback is restoring the pre-migration
backup (or reversing each batch from retained originals).

1. Stop the migration at a batch boundary; never run an older writer alongside
   the new schema.
2. Restore the pre-migration backup.
3. Re-run the compatibility check on the restored snapshot and compare its
   fingerprint with the recorded pre-migration fingerprint.
4. Keep the v2 read path for `image`/`price`/`isActive`/`listingStatus` until
   rollback is confirmed.
5. If any removed alias has no recoverable source, treat it as a forward fix.
   Do not re-add a guessed value just to make the check pass.
