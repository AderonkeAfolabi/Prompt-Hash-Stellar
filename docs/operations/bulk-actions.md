# Permission-aware bulk actions (#910)

Bulk actions change many records at once. They must never act on "whatever the
last filter matched", because a stale filter or an unchecked selection can touch
records the operator did not mean to change. The framework in
`server/src/services/bulkActions.ts` enforces three steps.

## 1. Plan (dry run, no writes)

The caller sends an explicit selection. Each entry pairs a record id with the
`version` the caller last saw:

```json
{
  "selection": [
    { "recordId": "prompt_41", "expectedVersion": 3 },
    { "recordId": "prompt_42", "expectedVersion": 1 }
  ]
}
```

`parseBulkSelection` validates this shape. It requires a non-empty array of at
most 500 items, each with a non-empty `recordId` and a non-negative integer
`expectedVersion`.

Planning checks the actor's permission first, before any record is read. Each
item then gets one code:

| Code                  | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `eligible`            | Will be applied                                          |
| `not_found`           | Record does not exist                                    |
| `stale_selection`     | Current `version` differs from `expectedVersion`         |
| `duplicate_selection` | Same record appears more than once; later copies flagged |
| `ineligible`          | The action's own rule rejected it (with a reason)        |

The plan reports `total`, `eligibleCount`, and `ineligibleCount`, and includes a
`confirmationToken`. Planning writes nothing.

## 2. Confirm

The `confirmationToken` is an HMAC over the action name, the actor, and the
**eligible set with versions** (sorted by record id, so selection order does not
matter). Execution must send this token back. If any eligible record changes,
or the selection changes which records are eligible, the recomputed token differs
and the execution is refused with `confirmation_mismatch`. The operator must plan
again.

## 3. Execute

`executeBulkAction` runs in this order:

1. If the token is already in the execution ledger, refuse with
   `duplicate_execution`.
2. Load the records and re-plan. Refuse an actor without the permission
   (`unauthorized`), or a token that does not match (`confirmation_mismatch`).
3. If nothing is eligible, return `executed: false` without claiming the token.
4. Atomically claim the token in the ledger. If the claim fails, refuse with
   `duplicate_execution`. This is the single-use guarantee.
5. Apply the action to each eligible record. A failure on one record is reported
   in `failed` and does not stop the others.

The result lists `applied`, `failed` (with reasons), and `skipped` (the plan
items that were not eligible).

## Defining an action

```ts
const hidePrompts: BulkActionDefinition<PromptRecord> = {
  name: "prompts_hide",
  requiredPermission: "prompts:bulk-update",
  ineligibleReason: (record) =>
    record.status === "published" ? null : "record is not published",
  // apply() must bump `version`, so a later plan no longer matches an old token.
  apply: async (record) => {
    await setVisible(record.id, false);
  },
};
```

## Requirements for production use

- **The execution ledger must be durable.** `createMemoryBulkExecutionLedger`
  is for tests and single-process use. A deployment needs a store where `claim`
  is an atomic insert under a unique index, so that two processes cannot both
  claim one token.
- **`apply` must bump `version`** inside the same write as the change, or the
  stale-selection check cannot detect a partial run.
- **Audit each execution** through `recordAuditEvent` using the caller's token
  subject as `actor`. The framework does not write audit events itself.
- **The confirmation secret** must be a server-side secret. It must not be the
  admin token secret reused for other purposes.

## Status

The framework is implemented and unit-tested (`server/src/tests/bulkActions.test.ts`).
It is **not yet wired to an HTTP route or to a concrete action**, so no production
endpoint runs bulk changes yet. Adding one is a follow-up that needs its own
route scope, durable ledger, and audit mapping.
