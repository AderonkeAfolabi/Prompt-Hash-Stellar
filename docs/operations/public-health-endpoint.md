# Public health endpoint with dependency-aware status (#1027)

The legacy `GET /health` always answers `"ok"`, even when MongoDB is down, so
load balancers and status pages cannot tell a broken replica from a healthy
one. The `/api/health` endpoints check each dependency and only report what is
safe to publish.

Code: `server/src/services/publicHealth.ts`, `server/src/routes/healthRoutes.ts`.

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health/live` | public | Liveness. Never touches a dependency, so it is safe as a container liveness probe. |
| `GET /api/health` | public | Readiness, with redacted per-dependency status. Use as the load-balancer and status-page probe. |
| `GET /api/health/details` | `health:read` | Full report: raw error detail, attempts, observed values. `?refresh=true` bypasses the cache. |

`GET /health` is unchanged for existing consumers.

### Response (`/api/health`)

```json
{
  "status": "degraded",
  "checkedAt": "2026-10-19T17:00:00.000Z",
  "cached": false,
  "dependencies": [
    { "name": "database", "status": "up", "critical": true, "latencyMs": 3 },
    { "name": "indexer", "status": "degraded", "critical": false, "latencyMs": 4, "reason": "unhealthy" },
    { "name": "stellar_rpc", "status": "down", "critical": false, "latencyMs": 2003, "reason": "timeout" }
  ]
}
```

`reason` is one of `timeout | unreachable | http_error | unhealthy |
check_failed`; the same codes as [public-status.md](../public-status.md).
Raw error text (hostnames, IPs, connection strings) is never published.

## Dependencies and status rules

| Dependency | Critical | up | degraded | down |
| --- | --- | --- | --- | --- |
| `database` | yes | connected and `ping` answers | — | disconnected, ping fails or times out |
| `indexer` | no | checkpoint touched within 60 s | 60 s – 10 min, or no checkpoint yet | older than 10 min |
| `stellar_rpc` | no | `getHealth` → `healthy` | any other RPC status | HTTP error, unreachable, timeout |

`stellar_rpc` is only checked when `STELLAR_RPC_URL` or
`PUBLIC_STELLAR_RPC_URL` is set.

Overall status:

- `down` (HTTP **503**, `Retry-After: 30`): a critical dependency is down.
- `degraded` (HTTP 200): a non-critical dependency is down, or any dependency
  is degraded. The API still serves, possibly with stale marketplace data.
- `ok` (HTTP 200): everything is up.

## Retry, timeout and caching

- Each check has a 2 s timeout, so a hung dependency cannot hang the endpoint.
- A `down` result or an error is retried once after 150 ms. One dropped packet
  does not flip the service to `down`. A `degraded` answer is real and is not
  retried.
- Results are cached for `HEALTH_CACHE_TTL_MS` (default 10 s), and concurrent
  evaluations share one in-flight probe round. Public callers can never force
  a refresh, so hammering `/api/health` causes at most one probe round per TTL
  against MongoDB and the RPC. Only `health:read` admins can pass
  `?refresh=true`.
- Every response carries `Cache-Control: no-store` so CDNs do not pin a stale
  status.

## Operational edge cases

- **Recovery shows up after at most one TTL.** After fixing a dependency,
  either wait `HEALTH_CACHE_TTL_MS` or call
  `/api/health/details?refresh=true` to update the cached view immediately.
- **Indexer with no new events:** the indexer renews its lease on every poll,
  which bumps the checkpoint's `updatedAt`. A quiet chain therefore still
  reads as `up`. A stopped indexer degrades after 60 s.
- **Fresh deploy:** until the indexer writes its first checkpoint, `indexer`
  is `degraded` with reason `unhealthy`. This is expected on an empty
  database.
- **Probe choice:** point container liveness at `/api/health/live` and
  readiness/LB at `/api/health`. Pointing liveness at `/api/health` would
  restart healthy replicas during a database outage.

## Tuning and rollback

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEALTH_CACHE_TTL_MS` | `10000` | Report cache lifetime |
| `HEALTH_INDEXER_DEGRADED_AFTER_MS` | `60000` | Checkpoint age before `indexer` degrades |
| `HEALTH_INDEXER_DOWN_AFTER_MS` | `600000` | Checkpoint age before `indexer` is down |

The new routes are additive. To roll back, point probes back at `/health`
(unchanged) or revert the route mount in `server/src/server.ts`. No data is
written.
