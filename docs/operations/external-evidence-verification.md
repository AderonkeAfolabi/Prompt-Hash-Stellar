# External evidence verification

Issue: #1011 · Code: `server/src/services/externalEvidenceVerification.ts`,
`server/src/routes/externalEvidenceRoutes.ts`,
`server/src/models/ExternalEvidenceRecord.ts` · Tests:
`server/src/tests/externalEvidenceVerification.test.ts`

External systems can import evidence (moderation results, partner attestations,
audit bundles) only if the server can prove who produced it and that it has not
changed in transit. Verification is fail-closed and happens **before** anything
is persisted or trusted.

## Envelope

```json
{
  "evidenceId": "partner-a:2026-10-19:0001",
  "issuer": "partner-a",
  "scope": "evidence:submit",
  "payload": { "subject": "prompt-42", "score": 97 },
  "payloadHash": "<sha256 of canonicalJson(payload)>",
  "issuedAt": "2026-10-19T10:00:00.000Z",
  "expiresAt": "2026-10-20T10:00:00.000Z",
  "nonce": "8f14e45fceea167a",
  "keyId": "partner-key-1",
  "signature": "<base64 Ed25519 signature>"
}
```

- `payloadHash` is SHA-256 over `canonicalJson(payload)` (sorted keys,
  `undefined` dropped, dates ISO-8601).
- The signature is Ed25519 over `canonicalJson` of the metadata:
  `{ evidenceId, issuer, scope, payloadHash, issuedAt, expiresAt, nonce, keyId }`.
  `expiresAt` is always present in the signing input (`null` when absent), so
  omitting it cannot be confused with an empty value.
- `evidenceId` is the idempotency key; `(issuer, nonce)` is single-use.

Trusted partners can build an envelope with `signExternalEvidence`. The server
only verifies.

## Trusted key registry

Configure `EXTERNAL_EVIDENCE_TRUSTED_KEYS` as JSON (an array or
`{"keys": [...]}`):

```json
[
  {
    "keyId": "partner-key-1",
    "issuer": "partner-a",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "scopes": ["evidence:submit", "prompt:read"],
    "notBefore": "2026-01-01T00:00:00.000Z",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "revokedAt": null,
    "label": "Partner A primary"
  }
]
```

`publicKey` accepts PEM, base64 SPKI DER, or a raw 32-byte base64/base64url
Ed25519 key. `scopes` supports exact values, `prefix*`, and `*`. An empty or
malformed registry fails closed with `503`; there is no "accept any key" mode.

## API

Both routes require an admin bearer token in addition to the issuer signature:

| Route | Scope | Success |
| --- | --- | --- |
| `POST /api/external-evidence/verify` | `evidence:write` | `201` new, `200` exact duplicate (`duplicate: true`) |
| `GET /api/external-evidence/:evidenceId` | `evidence:read` | `200` stored record, `404` unknown |

Error responses use stable codes:

| Status | Code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_envelope` | Missing/malformed field or non-JSON payload |
| 400 | `payload_hash_mismatch` | Payload changed after signing |
| 401 | `unknown_key` | `keyId` not in the registry |
| 401 | `revoked_key` | `revokedAt` is in the past |
| 401 | `key_not_yet_valid` / `key_expired` | Key outside its validity window |
| 401 | `invalid_signature` | Ed25519 verification failed |
| 403 | `issuer_mismatch` | Key belongs to another issuer |
| 403 | `scope_not_allowed` | Key was not granted the envelope scope |
| 409 | `evidence_conflict` | Same `evidenceId`, different bytes |
| 409 | `nonce_reuse` | Same `(issuer, nonce)` used by another evidence id |
| 410 | `evidence_expired` / `evidence_too_old` | Outside the acceptance window |
| 422 | `evidence_from_future` | `issuedAt` beyond clock skew |
| 503 | `trusted_keys_unconfigured` / `trusted_keys_invalid` | Registry unusable |
| 503 | `replay_store_unavailable` | MongoDB unavailable |

Defaults: 5-minute clock skew, 30-day maximum age for envelopes without an
expiry. Both are configurable through `VerifyExternalEvidenceOptions`; the
route uses the defaults.

## Idempotency, retries and replay

- Replaying the exact same envelope returns the stored record with
  `duplicate: true` and does not create a second row. The retry must still
  pass key and timestamp validation (it is re-authenticated, not blindly
  trusted); re-export with fresh timestamps if the acceptance window closed.
- Reusing an `evidenceId` with any different byte (payload, metadata,
  signature) is `409 evidence_conflict`. The first verified record wins.
- Reusing a nonce under a different `evidenceId` is `409 nonce_reuse`.
- Unique indexes on `evidenceId` and `(issuer, nonce)` make this safe across
  concurrent instances. A loser of the insert race re-reads the winner and
  either returns the duplicate or reports the conflict.
- Failed verification is never persisted.

## Operational edge cases

- **Key rotation.** Add the new key to the registry, leave the old one with a
  future `revokedAt`, deploy, then let partners switch. Removing a key
  immediately makes its in-flight evidence unverifiable.
- **Revocation.** Set `revokedAt` to the revocation time. Envelopes signed
  before revocation but imported after it are rejected; this is deliberate.
- **Clock drift.** `evidence_from_future` after a partner clock jump: fix the
  partner clock. Do not raise skew beyond a few minutes.
- **Too-old evidence.** Re-export from the partner with a fresh `issuedAt` and
  nonce. Never edit stored evidence timestamps.
- **Conflicts.** Treat as an integrity incident. Compare the stored payload
  with the partner's source; do not delete the original record to "make room".
- **Mongo unavailable.** The import returns `503`; nothing is stored. Retry
  after the dependency recovers. Do not fall back to the in-memory store in
  production — it cannot enforce cross-instance nonce uniqueness.
- **Registry outage.** A missing/invalid environment variable rejects all
  imports. Restore the previous known-good registry and redeploy.

## Recovery and rollback

Verified evidence is append-only. If a bad envelope was accepted:

1. Identify the `evidenceId` and `fingerprint` from the audit response/logs.
2. Revoke the signing key first so no further evidence is accepted.
3. Quarantine the record (mark it out-of-band in the consuming workflow); do
   not rewrite its payload or signature.
4. Restore the previous consumer state from a backup if the payload was used.
5. Roll back the deployment or registry by redeploying the previous
   `EXTERNAL_EVIDENCE_TRUSTED_KEYS` value. Records already verified remain
   readable; new imports from the revoked key fail closed.

The in-memory replay store exists for tests and local verification only. Every
production instance must use `createMongoExternalEvidenceStore()`.
