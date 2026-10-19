# Strict allow-list validation for URLs, file types, and destinations (#1025)

User-supplied URLs that the server stores, renders or later contacts are
checked against a named **allow-list policy**. A policy lists what is
permitted (schemes, ports, hosts, file types). Anything else is rejected with
a stable error code before it is persisted.

Code: `server/src/services/allowListPolicy.ts` (policies),
`server/src/routes/allowListRoutes.ts` (operator view). Delivery-time SSRF
protection (DNS pinning, per-hop redirect checks) stays in
`server/src/services/ssrfGuard.ts`. This layer stops bad destinations at the
door so they are never stored.

## Policies

| Policy | Applied at | Schemes | Ports | Hosts | File types |
| --- | --- | --- | --- | --- | --- |
| `webhook_destination` | `POST /api/webhooks` | https | default, 8443 | public DNS names; `WEBHOOK_ALLOWED_HOSTS` if set | — |
| `listing_image` | listing metadata validation | http, https | default | public DNS names; `IMAGE_ALLOWED_HOSTS` if set | png, jpg/jpeg, gif, webp, avif (when the path has an extension) |
| `report_evidence` | `POST /api/prompts/reports` evidence items | http, https | default | public DNS names; `EVIDENCE_ALLOWED_HOSTS` if set | must match the declared kind: `image` → image types, `pdf` → pdf, `text` → txt/md, `link` → not checked |

Every policy also refuses:

- embedded credentials (`https://user:pass@…`);
- **any IP literal**, including encoded forms the URL parser normalizes:
  decimal `2130706433`, hex `0x7f.0.0.1`, IPv6 `[::1]` and IPv4-mapped
  addresses. Public IPs are refused too: a destination must be a DNS name;
- single-label and internal names: `localhost`, `*.localhost`, `*.local`,
  `*.internal`, `*.lan`, `*.home.arpa`, `*.intranet`, `*.corp`;
- URLs longer than 2048 characters.

Host allow-lists accept exact hosts and `*.example.com` wildcards. A wildcard
matches subdomains only, never `example.com` itself.

### File types

`checkFileType({ kind, filename, contentType, bytes })` requires the
extension, the declared MIME type and (for binary kinds) the magic bytes to
agree. A renamed `.svg`, or an HTML page served as `image/png`, fails with
`file_type_mismatch`. SVG is never an allowed image type because it can carry
script.

## Error codes

Rejections return HTTP 400 with `{ error, code }`, where `code` is one of:
`url_invalid`, `url_too_long`, `scheme_not_allowed`,
`credentials_not_allowed`, `port_not_allowed`, `ip_literal_not_allowed`,
`host_not_allowed`, `file_type_not_allowed`, `file_type_mismatch`.

Listing validation keeps its existing message for a non-http(s) image (`Image
URL must start with http:// or https://.`) and adds the allow-list message for
the new rejections.

## Paths

- **Normal:** an allowed URL is stored as before.
- **Failure:** a disallowed URL gets a 400 with a stable code and nothing is
  stored. The violation is logged as `allow-list violation` with the policy,
  code and mode. The URL itself is not logged.
- **Retry:** validation is deterministic. Repeating the same rejected request
  with the same `Idempotency-Key` replays the same 400. After fixing the URL,
  send it as a **new** request with a new key. Reusing the old key with a
  different body is refused with `409 IDEMPOTENCY_KEY_CONFLICT`
  ([idempotency.md](../idempotency.md)).
- **Authorization:** `GET /api/admin/allow-list` (effective policies and mode)
  and `POST /api/admin/allow-list/check` (dry-run a URL or file) require the
  `allowlist:read` admin scope. Policies are code plus environment, so there
  is no endpoint that changes them; a change goes through review and deploy.

```http
POST /api/admin/allow-list/check
Authorization: Bearer <admin token with allowlist:read>

{ "policy": "webhook_destination", "url": "https://hooks.partner.io/x" }
```

The dry run always reports what **enforce** mode would decide, whatever the
current mode.

## Rollout, rollback and migration

- `ALLOWLIST_MODE=enforce` (default) rejects violations.
- `ALLOWLIST_MODE=report` logs violations but lets them through (responses are
  unchanged). This is the instant rollback lever if a policy rejects
  legitimate traffic: flip it, inspect the `allow-list violation` logs, adjust
  the policy, then flip back. Any other value enforces, so a typo fails
  closed.
- Data already stored is not rewritten. Existing webhook subscriptions that
  would now be refused are still protected at delivery time by `ssrfGuard`
  (https-only, private-address DNS pinning). To find them, list subscriptions
  and dry-run each URL through `/api/admin/allow-list/check`.
- Contract impact: the listing image contract still accepts both http and
  https (the shared schema fixtures use `http://example.com/img.png`). The new
  refusals are IP-literal and internal hosts, and paths whose extension is not
  a raster image type. Image URLs without an extension (IPFS gateways, CDN
  ids) are still accepted.
