# Audit evidence for administrative configuration changes (#1026)

Every admin change to runtime configuration leaves a tamper-evident record in
the existing hash-chained audit trail (`AuditLog`, see
[audit-log-usage.md](./audit-log-usage.md)). Feature flags are the first
configuration surface covered; the helper is generic so other admin config
(policy limits, maintenance banners) can adopt it the same way.

Code: `server/src/services/adminConfigAudit.ts`,
`server/src/routes/featureFlagRoutes.ts`, `server/src/routes/auditRoutes.ts`.

## What gets recorded

Each `POST /api/flags`, `PATCH /api/flags/:name` and `DELETE /api/flags/:name`
writes one `admin_config_change` record:

| Field | Value |
| --- | --- |
| `actor` | the admin token subject (`req.admin.sub`) — never a client-supplied value |
| `target` / `targetType` | `feature_flag:<name>` / `admin_config` |
| `result` | `success` or `failure` |
| `beforeState` / `afterState` | sanitized snapshots (`null` before a create / after a delete) |
| `metadata.changedFields` | top-level fields that differ, sorted |
| `metadata.changeId` | the request's `Idempotency-Key`, or a generated UUID |
| `metadata.noop` | `true` when the change did not alter anything (a retry) |
| `reason` | optional `reason` from the request body (max 500 chars) |
| `requestId` | correlation id |

The change id is echoed in the `X-Config-Change-Id` response header.

`createdBy` on a new flag is now the authenticated admin. The old route
accepted it from the request body, so any value could be written there.

## Paths

- **Normal:** the change is applied, then recorded. The record is chained into
  the audit hash chain, so `verifyAuditTrail()` covers it.
- **Failure:** if the change itself throws (unknown flag, duplicate name,
  validation error), a `failure` record is written on a best-effort basis. Its
  before and after state are the same and `metadata.error` holds the
  (truncated) message. The caller gets the usual 400.
- **No evidence, no change:** the success record is written with
  `throwOnError`. If it cannot be persisted (audit store down, validation
  error), the change is **rolled back** to its before-state and the request
  fails with `503 audit_evidence_unavailable`, `Retry-After: 30` and
  `rolledBack: true|false`. So configuration never changes without a matching
  audit record.
- **Retry:** send the request again, ideally with the same `Idempotency-Key`.
  If the first attempt applied, the retry finds nothing to change and is
  recorded as `noop: true` under the same change id. Both attempts show in the
  trail, and it is clear only one of them mutated anything.
- **Authorization:** mutations require `flags:write`. Requests without it are
  rejected by `requireAdminScope` before any handler runs. They leave no
  config-change record but are already logged as `admin_auth_denied`.

## Reading the evidence

```http
GET /api/audit/config-changes?configType=feature_flag&configKey=strict_settlement_checks
Authorization: Bearer <admin token with audit:export>
```

Filters: `configType`, `configKey` (requires `configType`), `actor`,
`changeId`, `since`, `until`, `limit` (1–200). Results are newest first and
include `recordHash`/`previousHash`. To produce a signed bundle for an
investigation, use `GET /api/audit/export?scope=admin` (all `admin_*` actions,
including `admin_config_change`) and verify it with
`POST /api/audit/export/verify`.

## Operational edge cases

- **Rollback itself fails** (e.g. the database went away between the write and
  the restore): the response still says `audit_evidence_unavailable`, but
  `rolledBack: false`. The server logs
  `admin config: rollback after audit failure FAILED — manual repair needed`
  with the target and change id. Compare the flag with the last
  `admin_config_change` record for that target and restore it by hand, then
  re-apply the change once the audit store is healthy.
- **Concurrent edits of the same flag:** before-state is read just before the
  change, so two admins racing on one flag each record what they saw. The
  records stay chronologically ordered in the chain. A restore after an audit
  failure can overwrite a concurrent edit; that edit's own record shows what
  to re-apply.
- **Sensitive values:** snapshots pass through `sanitizeAuditState`. Any key
  that looks like a secret, token, key or hash is stored as `[REDACTED]`.
- **Audit store outage:** while `AuditLog` writes fail, every config mutation
  returns 503 by design. Reads (`GET /api/flags`) and flag evaluation keep
  working.

## Migration and compatibility

- No schema migration. Records use the existing `AuditLog` fields.
  `admin_config_change` was added to `AUDIT_ACTIONS`, so the schema enum
  accepts it.
- `admin_maintenance_change` is now in `AUDIT_ACTIONS` too.
  `recordMaintenanceChange` already wrote it, but the schema enum rejected it,
  so maintenance banner changes were silently lost from the trail. They are
  persisted now.
- The route contract is unchanged on success (same body and status codes). The
  new parts are the `X-Config-Change-Id` header, an optional `reason` body
  field, and the 503 response when evidence cannot be recorded.
- Rollback of this feature: revert the route change. Records already written
  stay valid in the chain.
