# Time-boxed maintainer access grants (#912)

Maintainers do not hold standing privilege for the sensitive scopes below.
Instead, a second operator approves a **grant** that names the grantee, the
scopes, a reason, and an expiry. The grant is enforced on every request and
expires on its own.

## Model

| Field       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `grantId`   | `mag_<uuid>`, returned on issue                                      |
| `grantee`   | Admin token `sub` that may use the grant                             |
| `approver`  | Admin token `sub` that approved it. Always the authenticated caller  |
| `scopes`    | Non-empty subset of `moderation:write`, `payouts:write`, `integrity:write`, `entitlements:write`, `flags:write` |
| `reason`    | At least 12 characters; a ticket reference is expected               |
| `expiresAt` | Default 4 hours, minimum 5 minutes, maximum 72 hours                 |
| `revokedAt` | Set by revocation; a revoked grant never authorizes again            |
| `useCount`  | Number of successful uses, counted atomically                        |

Source: `server/src/models/MaintainerAccessGrant.ts`,
`server/src/services/maintainerAccessGrants.ts`.

## Rules

- **No self-approval.** `approver` must differ from `grantee`, compared
  case-insensitively. Attempts return `self_approval_forbidden`.
- **Expiry is enforced at the authorization boundary.** The guard re-reads the
  grant and compares `expiresAt` to the current time on every call. The use is
  counted with an atomic update that also requires `expiresAt > now`, so a grant
  that expires mid-request still denies. An expiry instant is already expired.
- **Identity and scope must both match.** A grant can only be used by its
  grantee, and only for a scope it lists.
- **Evidence before access.** Issuance writes `maintainer_grant_issued` with
  `throwOnError`. If that write fails, the grant is deleted and the request
  fails, so no access exists without a record of who approved it. A use is
  evidenced before the handler runs. If that write fails, the handler does not
  run and the response is 503.

## Audit actions

| Action                    | When                                      |
| ------------------------- | ----------------------------------------- |
| `maintainer_grant_issued` | Grant created (actor = approver)          |
| `maintainer_grant_used`   | Guard admitted a request (actor = grantee)|
| `maintainer_grant_denied` | Guard refused a request, with the code    |
| `maintainer_grant_revoked`| Grant revoked (actor = revoker)           |

Denials are recorded best effort. Use and issuance are recorded strictly.

## Admin API

Mounted at `/api/admin/maintainer-grants`.

| Method | Path                       | Scope                      | Purpose                                  |
| ------ | -------------------------- | -------------------------- | ---------------------------------------- |
| POST   | `/grants`                  | `maintainer:grant`         | Approve a grant for `grantee`            |
| GET    | `/grants?grantee=`         | `maintainer:grant:read`    | Report: active, expired, revoked, counts |
| GET    | `/grants/:grantId`         | `maintainer:grant:read`    | Inspect one grant                        |
| POST   | `/grants/:grantId/revoke`  | `maintainer:grant`         | End a grant early (idempotent)           |

Example issue request:

```json
{
  "grantee": "maint-bob",
  "scopes": ["payouts:write"],
  "reason": "INC-4421 payout reconciliation, ticket PAY-88",
  "ttlMs": 3600000
}
```

The response carries `grantId` and `expiresAt`. The `approver` is taken from
the authenticated token. A request body cannot name it.

## Using a grant on a route

Mount the guard after admin authentication:

```ts
router.post(
  "/payouts/:id/release",
  requireAdminScope("payouts:write"),
  requireMaintainerGrant("payouts:write"),
  handler,
);
```

The grantee sends the grant id in the `x-maintainer-grant-id` header.

| Status | `code`               | Meaning                                              |
| ------ | -------------------- | ---------------------------------------------------- |
| 400    | `missing_grant`      | Header absent                                        |
| 403    | `expired`            | Past `expiresAt`                                     |
| 403    | `revoked`            | Revoked                                              |
| 403    | `grantee_mismatch`   | Token `sub` is not the grantee                       |
| 403    | `scope_not_granted`  | Route scope is not on the grant                      |
| 403    | `use_conflict`       | Revoked or expired between check and count          |
| 404    | `not_found`          | Unknown grant id                                     |
| 503    | `admin_context_required` | Guard mounted without admin auth (fail closed)   |
| 503    | `storage_error`      | Grant store or audit store unavailable               |

**This change does not gate any existing route.** The guard and the admin API
are available now. Moving an existing privileged route behind a grant changes
who can act, so it should be a separate, reviewed change.

## Report

`GET /api/admin/maintainer-grants/grants` returns:

```json
{
  "success": true,
  "report": {
    "generatedAt": "2026-10-20T10:00:00.000Z",
    "counts": { "active": 1, "expired": 1, "revoked": 0 },
    "active": [],
    "expired": [],
    "revoked": []
  }
}
```

Each entry has `status`, `grantee`, `approver`, `scopes`, `reason`, `expiresAt`,
`revokedAt`, `revokedBy`, and `useCount`.

## Tests

`server/src/tests/maintainerAccessGrants.test.ts` covers validation, evaluation
(not found, revoked, expired at the boundary, grantee and scope mismatch),
issuance with rollback when audit fails, idempotent revocation, the report
buckets, and the guard's deny and allow branches.
