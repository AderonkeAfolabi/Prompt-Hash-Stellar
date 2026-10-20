import { describe, expect, it, vi } from "vitest";
import {
  BULK_SELECTION_MAX,
  BulkActionError,
  BulkActionDefinition,
  BulkActor,
  createMemoryBulkExecutionLedger,
  executeBulkAction,
  parseBulkSelection,
  planBulkAction,
} from "../services/bulkActions";

/**
 * Permission-aware bulk actions (#910). Everything here is pure: records live
 * in a Map and `apply` is a spy, so the dry-run "performs no writes" guarantee
 * is checked directly against the record state.
 */

interface PromptRecord {
  id: string;
  version: number;
  status: "published" | "draft";
  visible: boolean;
}

const SECRET = "test-confirmation-secret-0000";
const OPERATOR: BulkActor = {
  id: "ops-jane",
  permissions: new Set(["prompts:bulk-update"]),
};
const VIEWER: BulkActor = { id: "viewer-tom", permissions: new Set(["prompts:read"]) };

function makeRecords(): Map<string, PromptRecord> {
  return new Map<string, PromptRecord>([
    ["p1", { id: "p1", version: 1, status: "published", visible: true }],
    ["p2", { id: "p2", version: 3, status: "published", visible: true }],
    ["p3", { id: "p3", version: 2, status: "draft", visible: false }],
  ]);
}

function makeDefinition(apply = vi.fn(async (record: PromptRecord) => {
  record.visible = false;
  record.version += 1;
})): BulkActionDefinition<PromptRecord> {
  return {
    name: "prompts_hide",
    requiredPermission: "prompts:bulk-update",
    ineligibleReason: (record) =>
      record.status === "published" ? (record.visible ? null : "already hidden") : "record is not published",
    apply,
  };
}

function plan(
  records: Map<string, PromptRecord>,
  selection: Array<{ recordId: string; expectedVersion: number }>,
  actor: BulkActor = OPERATOR,
  definition = makeDefinition(),
) {
  return planBulkAction({
    definition,
    actor,
    selection,
    records,
    confirmationSecret: SECRET,
  });
}

describe("planBulkAction", () => {
  it("marks every item eligible when all selected records qualify", () => {
    const result = plan(makeRecords(), [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p2", expectedVersion: 3 },
    ]);
    expect(result.total).toBe(2);
    expect(result.eligibleCount).toBe(2);
    expect(result.ineligibleCount).toBe(0);
    expect(result.items.every((item) => item.code === "eligible")).toBe(true);
  });

  it("applies only to eligible items and reports a reason for each failure", () => {
    const result = plan(makeRecords(), [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p3", expectedVersion: 2 },
      { recordId: "missing", expectedVersion: 1 },
    ]);
    expect(result.eligibleCount).toBe(1);
    expect(result.ineligibleCount).toBe(2);
    expect(result.items.map((item) => [item.recordId, item.code])).toEqual([
      ["p1", "eligible"],
      ["p3", "ineligible"],
      ["missing", "not_found"],
    ]);
    expect(result.items[1].reason).toBe("record is not published");
    expect(result.items[2].reason).toBe("record does not exist");
  });

  it("flags stale selections whose version no longer matches", () => {
    const result = plan(makeRecords(), [{ recordId: "p2", expectedVersion: 2 }]);
    expect(result.items[0].code).toBe("stale_selection");
    expect(result.items[0].reason).toBe("selection saw version 2; current version is 3");
    expect(result.eligibleCount).toBe(0);
  });

  it("flags a record selected twice as a duplicate on the second occurrence", () => {
    const result = plan(makeRecords(), [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p1", expectedVersion: 1 },
    ]);
    expect(result.items.map((item) => item.code)).toEqual(["eligible", "duplicate_selection"]);
    expect(result.eligibleCount).toBe(1);
  });

  it("refuses an actor without the required permission", () => {
    let thrown: unknown;
    try {
      plan(makeRecords(), [{ recordId: "p1", expectedVersion: 1 }], VIEWER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BulkActionError);
    expect((thrown as BulkActionError).code).toBe("unauthorized");
  });

  it("rejects empty and oversized selections", () => {
    expect(() => plan(makeRecords(), [])).toThrow(/must not be empty/);
    const oversized = Array.from({ length: BULK_SELECTION_MAX + 1 }, (_, i) => ({
      recordId: `p${i}`,
      expectedVersion: 1,
    }));
    try {
      plan(makeRecords(), oversized);
      throw new Error("expected selection_too_large");
    } catch (err) {
      expect((err as BulkActionError).code).toBe("selection_too_large");
    }
  });

  it("produces a dry run that performs no writes", () => {
    const records = makeRecords();
    const before = JSON.stringify([...records.values()]);
    const apply = vi.fn();
    plan(records, [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p2", expectedVersion: 3 },
    ], OPERATOR, makeDefinition(apply));
    expect(apply).not.toHaveBeenCalled();
    expect(JSON.stringify([...records.values()])).toBe(before);
  });

  it("binds the confirmation token to the eligible set, not to selection order", () => {
    const a = plan(makeRecords(), [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p2", expectedVersion: 3 },
    ]);
    const b = plan(makeRecords(), [
      { recordId: "p2", expectedVersion: 3 },
      { recordId: "p1", expectedVersion: 1 },
    ]);
    expect(a.confirmationToken).toBe(b.confirmationToken);
  });
});

describe("executeBulkAction", () => {
  it("applies all eligible records and reports each outcome", async () => {
    const records = makeRecords();
    const apply = vi.fn(async (record: PromptRecord) => {
      record.visible = false;
      record.version += 1;
    });
    const selection = [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p3", expectedVersion: 2 },
    ];
    const { confirmationToken } = plan(records, selection, OPERATOR, makeDefinition(apply));

    const result = await executeBulkAction({
      definition: makeDefinition(apply),
      actor: OPERATOR,
      selection,
      confirmationToken,
      confirmationSecret: SECRET,
      loadRecords: async () => records,
      ledger: createMemoryBulkExecutionLedger(),
    });

    expect(result.executed).toBe(true);
    expect(result.applied).toEqual(["p1"]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((item) => item.recordId)).toEqual(["p3"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(records.get("p1")).toMatchObject({ visible: false, version: 2 });
    expect(records.get("p3")).toMatchObject({ visible: false, version: 2 });
  });

  it("refuses a token whose selection no longer matches the records", async () => {
    const records = makeRecords();
    const apply = vi.fn();
    const selection = [{ recordId: "p1", expectedVersion: 1 }];
    const { confirmationToken } = plan(records, selection);

    // Someone else changes p1 after the plan was confirmed.
    records.set("p1", { ...records.get("p1")!, version: 2 });

    await expect(
      executeBulkAction({
        definition: makeDefinition(apply),
        actor: OPERATOR,
        selection: [{ recordId: "p1", expectedVersion: 2 }],
        confirmationToken,
        confirmationSecret: SECRET,
        loadRecords: async () => records,
        ledger: createMemoryBulkExecutionLedger(),
      }),
    ).rejects.toMatchObject({ code: "confirmation_mismatch" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("refuses to execute the same confirmed plan twice", async () => {
    const records = makeRecords();
    const apply = vi.fn(async (record: PromptRecord) => {
      record.version += 1;
    });
    const selection = [{ recordId: "p1", expectedVersion: 1 }];
    const { confirmationToken } = plan(records, selection);
    const ledger = createMemoryBulkExecutionLedger();
    const run = () =>
      executeBulkAction({
        definition: makeDefinition(apply),
        actor: OPERATOR,
        selection,
        confirmationToken,
        confirmationSecret: SECRET,
        loadRecords: async () => records,
        ledger,
      });

    await run();
    await expect(run()).rejects.toMatchObject({ code: "duplicate_execution" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("refuses unauthorized actors even with a valid token", async () => {
    const records = makeRecords();
    const apply = vi.fn();
    const selection = [{ recordId: "p1", expectedVersion: 1 }];
    const { confirmationToken } = plan(records, selection);

    await expect(
      executeBulkAction({
        definition: makeDefinition(apply),
        actor: VIEWER,
        selection,
        confirmationToken,
        confirmationSecret: SECRET,
        loadRecords: async () => records,
        ledger: createMemoryBulkExecutionLedger(),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports a per-record failure and keeps going with the rest", async () => {
    const records = makeRecords();
    const apply = vi.fn(async (record: PromptRecord) => {
      if (record.id === "p1") throw new Error("ledger write failed");
      record.version += 1;
    });
    const selection = [
      { recordId: "p1", expectedVersion: 1 },
      { recordId: "p2", expectedVersion: 3 },
    ];
    const { confirmationToken } = plan(records, selection);

    const result = await executeBulkAction({
      definition: makeDefinition(apply),
      actor: OPERATOR,
      selection,
      confirmationToken,
      confirmationSecret: SECRET,
      loadRecords: async () => records,
      ledger: createMemoryBulkExecutionLedger(),
    });

    expect(result.applied).toEqual(["p2"]);
    expect(result.failed).toEqual([{ recordId: "p1", reason: "ledger write failed" }]);
  });

  it("does not claim the token when nothing is eligible", async () => {
    const records = makeRecords();
    const apply = vi.fn();
    const selection = [{ recordId: "p3", expectedVersion: 2 }];
    const { confirmationToken } = plan(records, selection);
    const ledger = createMemoryBulkExecutionLedger();

    const result = await executeBulkAction({
      definition: makeDefinition(apply),
      actor: OPERATOR,
      selection,
      confirmationToken,
      confirmationSecret: SECRET,
      loadRecords: async () => records,
      ledger,
    });

    expect(result).toMatchObject({ executed: false, applied: [], failed: [] });
    expect(apply).not.toHaveBeenCalled();
    expect(await ledger.isClaimed(confirmationToken)).toBe(false);
  });
});

describe("parseBulkSelection", () => {
  it("accepts the documented input format", () => {
    expect(
      parseBulkSelection({ selection: [{ recordId: " p1 ", expectedVersion: 0 }] }),
    ).toEqual([{ recordId: "p1", expectedVersion: 0 }]);
  });

  it("rejects malformed selections", () => {
    expect(() => parseBulkSelection({})).toThrow(/non-empty array/);
    expect(() => parseBulkSelection({ selection: [{ recordId: "", expectedVersion: 1 }] })).toThrow(
      /recordId/,
    );
    expect(() => parseBulkSelection({ selection: [{ recordId: "p1", expectedVersion: -1 }] })).toThrow(
      /expectedVersion/,
    );
  });
});
