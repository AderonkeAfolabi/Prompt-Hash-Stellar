# Import/export cancellation and delivery recovery

This change addresses #1022, #1023, #1028 and #1029 as a backend vertical
slice: provenance bulk imports, user exports, durable in-app notifications,
and outbound webhook delivery. It does not retrofit unrelated payment,
backup, email or blockchain operations with a new execution engine.

## Start, observe and cancel

Use a signed admin bearer token with `transfers:write` to:

1. `POST /api/transfers` with `{"kind":"import"}` or `{"kind":"export"}`.
2. Pass the returned `transferId` in the existing bulk-import or export POST
   body. Those endpoints still require `provenance:write` or `exports:write`.
3. `GET /api/transfers/:id` to inspect status and reference-only checkpoints.
4. `POST /api/transfers/:id/cancel` to request cancellation. Repeat safely.

Transfer IDs are scoped to the authenticated admin subject. Knowing another
operator's ID grants no access; it returns 404. Export status/list endpoints
require `exports:read`. These endpoints previously checked `req.admin`
without installing authentication; they now require signed, scoped tokens.
This is an intentional fail-closed correction, not a new unauthenticated
self-service export mechanism. The service's own-data authorization remains.
Bulk imports require an actor subject that references a User ObjectId, as
required by the existing Prompt.owner relationship.

Omitting `transferId` still works: execution creates a run and returns
`X-Transfer-Id`; bulk results also include `result.transferId`. Preallocating
is recommended so a lost POST response does not lose the operation identity.
The POSTs retain their existing synchronous execution/response contracts;
the export response remains 202. This does not introduce a background queue.

Cancellation is cooperative. A completed operation stays completed. Pending
or failed runs cancel immediately. A running run stops at the next boundary;
the cancellation response may therefore still say `running` with
`cancelRequested: true`. Poll until `cancelled`. Closing the HTTP response
also requests a cooperative stop through an AbortSignal; merely consuming
the request body does not cancel work. A database call already in progress
is allowed to settle. Cancellation cannot retract a committed database write.

Bulk imports are capped at 1,000 items to bound journal growth. Each prompt
and provenance insert has a deterministic ID derived from the transfer and
input index. The journal records intent before each insert, and commit after
it. Provenance points to prompts through its existing `promptId` field.
Final batch metadata updates are awaited and checkpointed even while
cancelling. Cancellation leaves imported drafts inactive and preserves
references to partial work; `result.imported` contains only fully processed
items. An interrupted item may have only a prompt checkpoint, so inspect
the journal as well as the response. Batch provenance uses the existing
`partial` status for cancelled batches; the run exposes `cancelled` explicitly.

Exports check cancellation while iterating a database cursor and close the
cursor on every exit. Publication has a separate checkpoint. Cancelled or
failed exports lose their URL, checksum and record count. The existing export
service only produces metadata/a URL: durable object storage and the actual
download implementation remain outside this slice. No temporary object is
created here. A future storage adapter must checkpoint upload/publication
and delete temporary objects on cancellation before exposing downloads.

## Retry, crashes and rollback

An ordinary failure leaves a run `failed`. Retry the same POST with the same
`transferId` and exact input; changed input/kind, different owner, concurrent
execution, completed runs and cancelled runs are rejected. Idempotent upserts
reconcile a database write whose acknowledgement was lost. A retry returns
the same prompt/provenance/artifact identities. A completed run is observed
through status instead of re-executed. Expired exports require a new run.

A crash can leave `running` plus `prepared` checkpoints. No automatic timeout
takeover is allowed: a slow worker must not compete with a retry. Operators
must first stop/drain the affected executor, reconcile every reference in
the journal with MongoDB, then conditionally change that specific running
run to `failed` (and unset `token`) to admit the existing retry path. Never
clear `cancelRequested` to force a cancelled operation back into service.
If MongoDB is unavailable during cancellation cleanup, the run remains
recoverable/ambiguous until an operator reconciles it; no false success is
reported. An operation boundary is not a distributed transaction.

Rollback is manual for bulk imports: identify drafts by the journal references
and provenance batch `batch_<transferId>`, verify no later edits or dependants,
then delete or restore only those records. Do not delete an entire batch
blindly or reuse its transfer ID. A cancelled transfer is terminal; creating
a new transfer can intentionally import the same input again.

Audit/log writes retain their existing best-effort contract. They are not the
authoritative execution journal, and repeated attempts can create repeated
audit entries. Read-only database queries are not journalled side effects.

## Notification and webhook duplicate suppression

Notification uniqueness is `(recipientWallet, type, idempotencyKey)` or
`(recipientWallet, type, dedupeKey)`. Wallets are trimmed/lowercased by writers;
keys identify a logical event, not its human-readable message. Legacy service
writers now rely on Mongo unique indexes and reconcile duplicate-key races.
Routed notifications also scope duplicate lookups to recipient and type.
Omitting an event key retains the historical non-deduplicated behavior.
Keys from unrelated uniqueness conflicts are never silently swallowed.

Webhook outbox uniqueness remains `(subscriptionId, dedupeKey)`. Sequence
allocation is monotonic: duplicate races or failures may leave gaps. Never
decrement/reuse an allocated sequence; another event may already own the next
number. A duplicate conflict is accepted only when the source-event row exists.

The worker persists a `prepared` checkpoint and consumes an attempt before
HTTP. A successful receiver response is persisted as `acknowledged` before
local completion bookkeeping. A retry of an acknowledged row completes that
bookkeeping without sending HTTP again. A crash after receiver acceptance
but before persisting acknowledgement remains ambiguous. Delivery is
**at least once**, not exactly once: receivers must deduplicate the stable
`X-PromptHash-Delivery` ID before performing their own effects. Retries and
dead-letter replay retain that ID. Attempts consumed before a crash count
toward the existing retry budget. Inspect ambiguous rows before replay.

## Retention, migration and deployment rollback

The retention worker still scrubs processed inbound events and resolved
quarantine/export jobs after 30 days, and resolved support evidence after
365 days. It preserves identities, unresolved data, audit/financial/on-chain
records and active holds. Selection now excludes held/already archived rows,
so they cannot starve later batches. The destructive update rechecks
per-record holds. A hold-ledger read failure aborts cleanup before writes;
a failed batch remains eligible for a later run. Hold creation should finish
applying its per-record flag before operators run destructive cleanup.

Expired terminal user-export records are physically deleted after their
existing 24-hour expiry. Pending exports are preserved for reconciliation;
expiry is enforced by the status endpoint independently of cleanup timing.
Deletion failures propagate and can be retried. There are no physical files
in the current adapter. Notification TTL is the documented 90 days; removal
also ends that notification's duplicate-suppression window. Terminal transfer
journals expire after 30 days; failed/running journals have no automatic TTL.
Journals contain hashes, states and reference IDs, never imported prompt bodies
or exported records. They are not covered by the separate retention-hold
ledger, which only targets its existing supported collections.

Before rollout, pause notification writers and run migration
`007_notification_deduplication` through `db:migrate`. It builds the scoped
unique indexes before removing obsolete global event-key indexes, then adds
the missing 90-day TTL. Back up/inspect legacy notifications first: existing
duplicates fail index creation for manual reconciliation, and TTL can delete
old records immediately. Do not use `syncIndexes` to remove constraints during
rollout. New TransferRun indexes must be created through the deployment's
normal Mongoose index provisioning (including the terminal journal TTL).
Export `cancelled` status and webhook checkpoint fields are additive; drain
older workers before enabling cancellation/checkpointed delivery.

Migration rollback intentionally fails closed: global uniqueness cannot be
restored losslessly after two recipients share a key, and deleted TTL data
cannot be reconstructed. Roll back by draining new workers and deploying a
compatible forward fix while retaining the scoped indexes/new fields. Restore
backups only through the normal audited recovery process, with replay impact
reviewed. Never restore a global index by automatically deleting other users'
notifications.

## Executable verification

From `server`, run:

```sh
npm test -- src/tests/transferExecution.test.ts src/tests/transferFlows.test.ts src/tests/deliveryDeduplication.test.ts src/tests/operationalRetention.test.ts src/tests/retentionCleanup.test.ts src/tests/retentionPolicy.test.ts src/tests/retentionMigration.test.ts src/tests/notificationDeduplicationMigration.test.ts src/tests/notificationDelivery.test.ts src/tests/notificationRouting.test.ts src/tests/webhookOutbox.test.ts
```

The new integration suites require MongoMemoryServer to start and fail rather
than silently skip when MongoDB is unavailable. They exercise real unique
indexes, concurrent execution, partial imports, export cursor cleanup,
owner isolation, write failures/retries, cutoff boundaries, multiple batches,
hold races, scrubbing and physical artifact-record deletion.
