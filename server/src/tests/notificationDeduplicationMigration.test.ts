import { describe, expect, it, vi } from "vitest";
import { up, down } from "../db/migrations/007_notification_deduplication";

describe("notification deduplication migration", () => {
  it("installs scoped constraints before removing global uniqueness and enables documented retention", async () => {
    const collection = {
      createIndex: vi.fn().mockResolvedValue("index"),
      listIndexes: () => ({
        toArray: async () => [
          { name: "_id_", key: { _id: 1 }, unique: true },
          { name: "dedupeKey_1", key: { dedupeKey: 1 }, unique: true },
          {
            name: "idempotencyKey_1",
            key: { idempotencyKey: 1 },
            unique: true,
          },
          {
            name: "recipientWallet_1_type_1_dedupeKey_1",
            key: { recipientWallet: 1, type: 1, dedupeKey: 1 },
            unique: true,
          },
        ],
      }),
      dropIndex: vi.fn(),
    };
    await up({ collection: () => collection } as any);
    expect(collection.createIndex).toHaveBeenCalledWith(
      { recipientWallet: 1, type: 1, dedupeKey: 1 },
      {
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: "string" } },
      },
    );
    expect(collection.createIndex).toHaveBeenCalledWith(
      { recipientWallet: 1, type: 1, idempotencyKey: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: "string" } },
      },
    );
    expect(collection.createIndex.mock.invocationCallOrder[1]).toBeLessThan(
      collection.dropIndex.mock.invocationCallOrder[0],
    );
    expect(collection.dropIndex.mock.calls).toEqual([
      ["dedupeKey_1"],
      ["idempotencyKey_1"],
    ]);
    expect(collection.createIndex).toHaveBeenLastCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: 90 * 86400 },
    );
  });
  it("does not remove constraints after an index build fails and refuses destructive rollback", async () => {
    const collection = {
      createIndex: vi.fn().mockRejectedValue(new Error("legacy duplicates")),
      dropIndex: vi.fn(),
    };
    await expect(up({ collection: () => collection } as any)).rejects.toThrow(
      "legacy duplicates",
    );
    expect(collection.dropIndex).not.toHaveBeenCalled();
    await expect(down()).rejects.toThrow("forward rollback");
  });
});
