/**
 * Deterministic replay verification for concurrent writers and retries (#1008).
 *
 * The indexer, backfill tool, and webhook consumers are all at-least-once
 * writers: the same event can arrive twice, events can be journaled out of
 * delivery order, and two workers can race to process the same page. A replay
 * is only trustworthy if every one of those delivery histories folds into the
 * exact same projection state.
 *
 * This module provides a pure replay fold plus a verifier that replays the
 * same journal under several delivery orders (original, reversed, seeded
 * shuffle, and a retry storm full of duplicates). It never touches MongoDB and
 * never mutates the events or the projection, so it is safe to run from tests,
 * CI, or an operator investigation.
 *
 * Ordering contract
 * -----------------
 * Events are ordered by `(ledger, eventId)` — the same total order used by the
 * journal reader — not by arrival time. Event ids are unique; a second copy of
 * the same id with different bytes is a hard failure rather than a silent
 * last-writer-wins.
 *
 * Failure and recovery
 * --------------------
 * An unsupported event version fails the replay in strict mode (the default)
 * before any state is returned, mirroring the production replay engine. In
 * lenient mode the event is skipped and reported, because a projection built
 * by dropping an event must never be activated.
 *
 * See docs/operations/deterministic-replay.md.
 */

import { createHash } from "crypto";
import { canonicalJson } from "./canonicalSerialization";
import type { ProjectionDefinition, ReplayEvent } from "./projectionReplay";

export interface DeterministicReplayRow {
  key: string;
  data: unknown;
  lastLedger: number;
  lastEventId: string;
}

export interface UnsupportedReplayEvent {
  eventId: string;
  ledger: number;
  eventType: string;
  eventVersion: number;
  supportedVersions: readonly number[];
}

export interface DeterministicReplayOptions {
  /**
   * Throw on an event type the projection knows but at an unsupported version.
   * Defaults to true, matching `runReplay`'s strict mode. Ignored event types
   * never fail.
   */
  strict?: boolean;
  /**
   * Rows already persisted by a previous page. Replaying events at or before
   * their `(lastLedger, lastEventId)` is counted as stale and skipped, which is
   * the crash-recovery path where rows are ahead of the checkpoint.
   */
  initialRows?: readonly DeterministicReplayRow[];
}

export interface DeterministicReplayResult {
  rows: DeterministicReplayRow[];
  fingerprint: string;
  applied: number;
  ignored: number;
  duplicates: number;
  stale: number;
  unsupported: UnsupportedReplayEvent[];
}

export interface ReplayVerificationRun {
  order: "journal" | "reverse" | "seeded_shuffle" | "retry_storm";
  fingerprint: string;
  applied: number;
  duplicates: number;
  stale: number;
}

export interface DeterministicReplayVerification {
  deterministic: boolean;
  fingerprint: string;
  baseline: DeterministicReplayResult;
  runs: ReplayVerificationRun[];
  mismatches: string[];
}

export type DeterministicReplayErrorCode =
  | "invalid_event"
  | "conflicting_event"
  | "unsupported_event";

export class DeterministicReplayError extends Error {
  constructor(
    readonly code: DeterministicReplayErrorCode,
    message: string,
    readonly eventId?: string,
  ) {
    super(message);
    this.name = "DeterministicReplayError";
  }
}

/** Total journal order: ledger ascending, then event id lexicographically. */
export function compareReplayEvents(a: ReplayEvent, b: ReplayEvent): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function validateEvent(event: ReplayEvent): void {
  if (
    !event ||
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    !Number.isSafeInteger(event.ledger) ||
    event.ledger < 0 ||
    typeof event.eventType !== "string" ||
    event.eventType.length === 0 ||
    !Number.isSafeInteger(event.eventVersion) ||
    event.eventVersion < 1 ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new DeterministicReplayError(
      "invalid_event",
      `Malformed replay event: ${String((event as ReplayEvent | undefined)?.eventId ?? "<unknown>")}`,
      (event as ReplayEvent | undefined)?.eventId,
    );
  }
}

/**
 * Sort, validate, and de-duplicate a delivery batch. Duplicate ids with the
 * exact same canonical bytes are collapsed (a retry); the same id with
 * different bytes is rejected because no correct state can be derived from
 * two different histories.
 */
export function normalizeReplayBatch(events: readonly ReplayEvent[]): {
  events: ReplayEvent[];
  duplicates: number;
} {
  const byId = new Map<string, { event: ReplayEvent; canonical: string }>();
  let duplicates = 0;

  for (const event of events) {
    validateEvent(event);
    const canonical = canonicalJson({
      eventId: event.eventId,
      ledger: event.ledger,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      payload: event.payload,
    });
    const seen = byId.get(event.eventId);
    if (seen) {
      if (seen.canonical !== canonical) {
        throw new DeterministicReplayError(
          "conflicting_event",
          `Event ${event.eventId} was delivered with two different payloads; refusing to choose one.`,
          event.eventId,
        );
      }
      duplicates += 1;
      continue;
    }
    byId.set(event.eventId, { event, canonical });
  }

  return {
    events: [...byId.values()].map((entry) => entry.event).sort(compareReplayEvents),
    duplicates,
  };
}

function isAfter(event: ReplayEvent, row: DeterministicReplayRow | undefined): boolean {
  if (!row) return true;
  return (
    event.ledger > row.lastLedger ||
    (event.ledger === row.lastLedger && event.eventId > row.lastEventId)
  );
}

/** Stable SHA-256 over the sorted projection state. */
export function fingerprintReplayRows(rows: readonly DeterministicReplayRow[]): string {
  const ordered = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Fold events into a projection without any I/O. The reducer itself must be
 * pure; this function enforces the ordering, duplicate, and stale-event rules
 * around it.
 */
export function replayDeterministically(
  projection: ProjectionDefinition<any>,
  events: readonly ReplayEvent[],
  options: DeterministicReplayOptions = {},
): DeterministicReplayResult {
  const strict = options.strict ?? true;
  const { events: ordered, duplicates } = normalizeReplayBatch(events);
  const rows = new Map<string, DeterministicReplayRow>(
    (options.initialRows ?? []).map((row) => [row.key, { ...row }]),
  );
  const unsupported: UnsupportedReplayEvent[] = [];
  let applied = 0;
  let ignored = 0;
  let stale = 0;

  for (const event of ordered) {
    const versions = projection.supportedEvents[event.eventType];
    if (!versions) {
      ignored += 1;
      continue;
    }

    if (!versions.includes(event.eventVersion)) {
      const detail: UnsupportedReplayEvent = {
        eventId: event.eventId,
        ledger: event.ledger,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        supportedVersions: [...versions],
      };
      unsupported.push(detail);
      if (strict) {
        throw new DeterministicReplayError(
          "unsupported_event",
          `unsupported_version: ${event.eventType} v${event.eventVersion} at ledger ${event.ledger} (${event.eventId})`,
          event.eventId,
        );
      }
      continue;
    }

    const key = projection.keyOf(event);
    if (key === null) {
      ignored += 1;
      continue;
    }

    const current = rows.get(key);
    if (!isAfter(event, current)) {
      // Rows written before a crash may be replayed with an older page. The
      // event is already reflected in the row, so applying it again would
      // double-count purchases or revenue.
      stale += 1;
      continue;
    }

    const next = projection.apply(current ? (current.data as any) : null, event);
    if (next === null) {
      rows.delete(key);
    } else {
      rows.set(key, {
        key,
        data: next,
        lastLedger: event.ledger,
        lastEventId: event.eventId,
      });
    }
    applied += 1;
  }

  const orderedRows = [...rows.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  return {
    rows: orderedRows,
    fingerprint: fingerprintReplayRows(orderedRows),
    applied,
    ignored,
    duplicates,
    stale,
    unsupported,
  };
}

/** Deterministic PRNG (mulberry32) so shuffle permutations are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const out = [...input];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Replay one journal under multiple delivery orders and prove the projection
 * fingerprint never changes. `retry_storm` duplicates every event several
 * times and interleaves them, modelling overlapping indexer/backfill writers.
 */
export function verifyDeterministicReplay(
  projection: ProjectionDefinition<any>,
  events: readonly ReplayEvent[],
  options: DeterministicReplayOptions & { seed?: number } = {},
): DeterministicReplayVerification {
  const baseline = replayDeterministically(projection, events, options);
  const seed = options.seed ?? 0x5eed;

  const shuffled = seededShuffle(events, seed);
  const retryStorm = [...events, ...seededShuffle(events, seed + 1), ...events.slice().reverse()];

  const permutations: Array<{
    order: ReplayVerificationRun["order"];
    events: readonly ReplayEvent[];
  }> = [
    { order: "journal", events },
    { order: "reverse", events: [...events].reverse() },
    { order: "seeded_shuffle", events: shuffled },
    { order: "retry_storm", events: retryStorm },
  ];

  const runs: ReplayVerificationRun[] = [];
  const mismatches: string[] = [];

  for (const permutation of permutations) {
    const result = replayDeterministically(projection, permutation.events, options);
    runs.push({
      order: permutation.order,
      fingerprint: result.fingerprint,
      applied: result.applied,
      duplicates: result.duplicates,
      stale: result.stale,
    });
    if (result.fingerprint !== baseline.fingerprint) {
      mismatches.push(
        `${permutation.order} produced ${result.fingerprint}, expected ${baseline.fingerprint}`,
      );
    }
  }

  return {
    deterministic: mismatches.length === 0,
    fingerprint: baseline.fingerprint,
    baseline,
    runs,
    mismatches,
  };
}
