# Deterministic replay verification

Issue: #1008 · Code: `server/src/services/deterministicReplay.ts` · Tests:
`server/src/tests/deterministicReplay.test.ts`

The indexer, backfill tool, and webhook consumers are at-least-once writers.
The same on-chain event can arrive twice, a retry can replay an already
persisted page, and two workers can race on one journal range. Determinism is
therefore a correctness property, not a performance one: every valid delivery
history must fold into the exact same projection state.

## What the verifier guarantees

`replayDeterministically(projection, events)` is a pure fold. It:

1. validates every event (`eventId`, integer `ledger >= 0`, integer
   `eventVersion >= 1`, object payload);
2. orders events by `(ledger, eventId)` — the journal total order, not
   arrival order;
3. collapses exact duplicate ids (retries) and rejects the same id delivered
   with different bytes;
4. skips events at or before a row's persisted `(lastLedger, lastEventId)`
   and counts them as `stale`;
5. fails closed on an unsupported event version in strict mode, or skips and
   reports it in lenient mode;
6. returns rows sorted by key plus a SHA-256 `fingerprint` of that state.

`verifyDeterministicReplay` runs the same journal under four histories:

| Run | Delivery history |
| --- | --- |
| `journal` | original order |
| `reverse` | reverse arrival |
| `seeded_shuffle` | reproducible concurrent interleaving |
| `retry_storm` | every event delivered three times in mixed order |

`deterministic: true` means all four produced the same fingerprint. Any
mismatch is returned in `mismatches` with both fingerprints.

## Running

The verifier is covered by the normal server suite:

```bash
cd server
npx vitest run src/tests/deterministicReplay.test.ts
```

For an incident investigation, call `verifyDeterministicReplay` from a
scratch script against the exported journal. It performs no I/O of its own and
does not mutate the events or the projection.

## Edge cases and expected outcomes

| Situation | Result |
| --- | --- |
| Duplicate delivery with identical canonical bytes | Collapsed; `duplicates` increments; fingerprint unchanged |
| Same `eventId`, different payload | `DeterministicReplayError("conflicting_event")` |
| Event older than a persisted row | Skipped as `stale`; no double-counting |
| Unknown event type | Ignored (`ignored` increments) |
| Known type, unsupported version, strict mode | Throws `unsupported_event` |
| Known type, unsupported version, lenient mode | Event skipped and listed in `unsupported` |
| Malformed event | Throws `invalid_event` before state is returned |
| Two events at the same ledger | Ordered lexicographically by `eventId` |

## Recovery and rollback

- **Conflicting event id.** Treat it as a data-integrity incident. Do not pick
  a winner. Locate both journal rows, compare with the on-chain source, and
  quarantine the bad row before replaying.
- **Unsupported version.** Stop. Deploy code that understands the version, or
  replay with the previous projection definition. Do not activate a projection
  built in lenient mode while `unsupported` is non-empty — it is missing
  events by construction.
- **Fingerprint mismatch.** Keep the currently served projection. Investigate
  the mismatching run; the fingerprint difference identifies the divergence.
  Rollback is simply to leave the old projection active; the verifier never
  writes to the database.
- **Crash between row write and checkpoint.** Resume from the checkpoint with
  the persisted rows passed as `initialRows`. Events already reflected are
  counted as `stale` instead of being applied twice.

Retries are safe because duplicate ids are collapsed before the reducer runs.
A retry storm must produce the same fingerprint as a single clean pass; that
is asserted in CI.
