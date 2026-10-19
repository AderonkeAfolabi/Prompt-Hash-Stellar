import mongoose from "mongoose";

/**
 * Append-only journal of decoded contract events (#1024).
 *
 * `ProcessedEvent` only records that an event was seen; it keeps no payload,
 * so projections could not be rebuilt without re-reading the chain. The
 * journal stores each recognized event's decoded payload together with the
 * schema version it was decoded with, which is what the replay tool reads.
 */
const eventJournalSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    ledger: { type: Number, required: true },
    txHash: { type: String, default: "" },
    contractId: { type: String, default: "" },
    eventType: { type: String, required: true, index: true },
    eventVersion: { type: Number, required: true },
    /** JSON-safe decoded payload: bigints as decimal strings, bytes as hex. */
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    source: { type: String, enum: ["indexer", "backfill"], default: "indexer" },
  },
  { timestamps: { createdAt: "journaledAt", updatedAt: false } },
);

// Replay order: ledger, then event id (Soroban event ids sort within a ledger).
eventJournalSchema.index({ ledger: 1, eventId: 1 });

eventJournalSchema.pre("findOneAndUpdate", function () {
  // Only the idempotent `$setOnInsert` append is allowed.
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (update && Object.keys(update).some((op) => op !== "$setOnInsert")) {
    throw new Error("EventJournal entries are immutable.");
  }
});
eventJournalSchema.pre("updateOne", function () {
  throw new Error("EventJournal entries are immutable.");
});
eventJournalSchema.pre("updateMany", function () {
  throw new Error("EventJournal entries are immutable.");
});

export const EventJournal =
  mongoose.models.EventJournal || mongoose.model("EventJournal", eventJournalSchema);

export default EventJournal;
