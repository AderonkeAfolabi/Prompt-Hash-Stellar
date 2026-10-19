import { EventJournal } from "../models/EventJournal";
import { logger } from "./structuredLogger";

/**
 * Event journal writer/reader for the projection replay tool (#1024).
 * See docs/operations/event-replay.md.
 */

export interface JournalEntry {
  eventId: string;
  ledger: number;
  txHash?: string;
  contractId?: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  source?: "indexer" | "backfill";
}

export interface JournalCursor {
  ledger: number;
  eventId: string;
}

/** Make a decoded payload storable: bigint → decimal string, bytes → hex. */
export function normalizePayload(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalizePayload(v)]),
    );
  }
  return value;
}

/**
 * Idempotent append: the first write for an `eventId` wins and re-delivery
 * of the same event (indexer retry, overlapping backfill) is a no-op.
 * Returns true when a new entry was written.
 */
export async function appendToJournal(entry: JournalEntry): Promise<boolean> {
  const result = await EventJournal.findOneAndUpdate(
    { eventId: entry.eventId },
    {
      $setOnInsert: {
        eventId: entry.eventId,
        ledger: entry.ledger,
        txHash: entry.txHash ?? "",
        contractId: entry.contractId ?? "",
        eventType: entry.eventType,
        eventVersion: entry.eventVersion,
        payload: normalizePayload(entry.payload),
        source: entry.source ?? "indexer",
      },
    },
    { upsert: true, new: false, includeResultMetadata: true },
  );
  return !result?.lastErrorObject?.updatedExisting;
}

/**
 * Journal from the indexer hot path. Never throws: a journal outage must not
 * stall indexing, but it leaves a gap a replay cannot see, so it is logged
 * loudly with the event id for a targeted backfill.
 */
export async function journalIndexedEvent(entry: JournalEntry): Promise<void> {
  try {
    await appendToJournal(entry);
  } catch (err) {
    logger.error("event journal append failed — backfill required for this event", {
      action: "event_journal_append",
      eventId: entry.eventId,
      ledger: entry.ledger,
      eventType: entry.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Next page of journal entries strictly after `cursor`, in replay order. */
export async function readJournalPage(cursor: JournalCursor, limit: number): Promise<any[]> {
  return EventJournal.find({
    $or: [
      { ledger: { $gt: cursor.ledger } },
      { ledger: cursor.ledger, eventId: { $gt: cursor.eventId } },
    ],
  })
    .sort({ ledger: 1, eventId: 1 })
    .limit(limit)
    .lean();
}
