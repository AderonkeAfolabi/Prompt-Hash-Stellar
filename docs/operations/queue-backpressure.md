# Queue backpressure for expensive background work

Issue: #1009 · Code: `server/src/jobs/jobQueue.ts`,
`server/src/routes/jobRoutes.ts` · Tests:
`server/src/tests/jobQueueBackpressure.test.ts`

Background work is unbounded by default: a request burst can enqueue thousands
of exports or analytics jobs, consuming worker time, database connections, and
downstream capacity long before the queue drains. Admission ceilings make that
failure fast and retryable instead of letting the queue starve settlement work.

## Semantics

Admission counts **pending + processing** jobs per type. A job is admitted only
when `pending + processing < limit`. The check reads the database on every
enqueue, so it self-heals after a worker restart and never leaks an in-memory
semaphore.

Default ceilings (`DEFAULT_MAX_PENDING_BY_TYPE`):

| Type | Default ceiling | Rationale |
| --- | ---: | --- |
| `settlement_poll` | 1000 | Critical path; must absorb chain bursts |
| `entitlement_repair` | 500 | Critical repair path |
| `analytics_aggregate` | 50 | Expensive, delay-tolerant |
| `export_csv` | 25 | Large scans and object storage writes |
| `stale_dispute_cleanup` | 10 | Maintenance work |
| `retention_cleanup` | 5 | Maintenance work |
| `stale_cache_repair` | 50 | Repairable backlog |

Override per type with an environment variable:

```bash
JOB_QUEUE_MAX_PENDING_EXPORT_CSV=10
JOB_QUEUE_MAX_PENDING_ANALYTICS_AGGREGATE=25
```

The value must be a non-negative safe integer. Invalid values fall back to the
default (never to "unlimited"). `0` disables the ceiling for that type; use it
only for a controlled maintenance window and restore the default afterwards.

`maxPending` can also be passed per enqueue for tests or a caller with a
tighter budget.

## API behaviour

`POST /api/jobs/enqueue` (scope `jobs:write`)

- `201` — job admitted.
- `429` — ceiling reached. The body is
  `{ error: "queue_backpressure", type, pending, processing, limit, retryAfterMs }`
  and the response carries `Retry-After` in seconds (minimum 1).
- Idempotent retry — if a `pending`/`processing` job with the same dedupe key
  exists inside the dedupe window, the original job is returned instead of a
  429. A client retrying an accepted enqueue must not be punished for a full
  queue.
- `400` — unknown job type or invalid payload/options. Unknown types never
  reach the queue.

`GET /api/jobs/pressure` (scope `jobs:read`) returns one row per known type:

```json
{
  "type": "export_csv",
  "limit": 25,
  "pending": 24,
  "processing": 1,
  "total": 25,
  "saturated": true,
  "retryAfterMs": 1000
}
```

## Edge cases

- **Concurrent enqueues.** Counting and inserting are separate statements, so
  two processes can overshoot by the number of simultaneous admissions. The
  ceiling is a strict serial bound and a best-effort concurrent bound; worker
  concurrency caps the overshoot. Do not treat it as an exact semaphore.
- **Workers stopped.** Processing jobs remain counted until they are completed
  or reaped. If workers are down for a long time, `saturated` stays true by
  design; raise the ceiling or fix the worker rather than deleting jobs.
- **Dedupe bypass.** A retry with the same dedupe key returns the existing job
  even when the queue is saturated. This is intentional and does not create a
  second unit of work.
- **Zero limit.** `0` means "no ceiling" (`saturated: false`). It is recorded
  here so an operator cannot mistake it for "reject everything".
- **Dead-letter requeue.** Requeueing a dead-letter job does not pass through
  admission; it is an operator action and should be used deliberately.
- **Per-type isolation.** A saturated export queue does not block settlement
  or repairs.

## Recovery and rollback

1. Watch `/api/jobs/pressure`; page on a saturated critical type rather than
   waiting for the queue to grow.
2. If the ceiling is too tight for a legitimate burst, raise the environment
   variable (or set `0` briefly), redeploy/restart the server, and restore the
   default once depth returns to normal.
3. If worker capacity is the real limit, scale workers before raising the
   ceiling; raising it only moves the backlog into memory and downstream load.
4. Rollback is configuration-only: remove the override or restore the previous
   value. Already queued jobs are unaffected, and no schema or data migration
   is required.
