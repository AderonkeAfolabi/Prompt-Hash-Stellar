import type mongoose from "mongoose";

export async function up(db: mongoose.mongo.Db): Promise<void> {
  const notifications = db.collection("notifications");
  // Build scoped constraints before dropping old constraints. Duplicate legacy
  // rows fail the migration; operators must reconcile them, never auto-delete.
  for (const key of ["dedupeKey", "idempotencyKey"]) {
    await notifications.createIndex(
      { recipientWallet: 1, type: 1, [key]: 1 },
      { unique: true, partialFilterExpression: { [key]: { $type: "string" } } },
    );
  }
  const indexes = await notifications.listIndexes().toArray();
  for (const index of indexes) {
    if (
      index.unique &&
      Object.keys(index.key).length === 1 &&
      (index.key.dedupeKey || index.key.idempotencyKey) &&
      index.name
    ) {
      await notifications.dropIndex(index.name);
    }
  }
  // Privacy policy already specifies 90 days, but the previous schema omitted
  // the TTL definition. Enabling it can delete old notifications immediately.
  await notifications.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 90 * 86400 },
  );
}

export async function down(): Promise<void> {
  // Global uniqueness cannot be restored losslessly once two recipients share
  // an event key. Keep the constraints and use the documented forward rollback.
  throw new Error(
    "Notification deduplication requires forward rollback; see docs/operations/transfer-recovery.md",
  );
}
