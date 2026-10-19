/**
 * Migration compatibility checks for the next Prompt storage schema (#1010).
 *
 * The checker is deliberately pure: it never connects to MongoDB and never
 * mutates the input, so every assertion below can run without an environment.
 * The suite pins the normal v2→v3 migration, the legacy alias mappings, every
 * blocking condition, deterministic retries, and the rollback contract.
 */

import { describe, expect, it } from "vitest";
import {
  NEXT_PROMPT_SCHEMA_VERSION,
  PROMPT_V3_MANIFEST,
  SchemaMigrationCompatibilityError,
  assertPromptMigrationCompatible,
  buildPromptV3Candidate,
  checkPromptMigrationCompatibility,
  derivePromptLifecycleState,
  lifecycleFromListingStatus,
} from "../services/schemaMigrationCompatibility";
import { CURRENT_PROMPT_SCHEMA_VERSION } from "../services/schemaVersioning";

function validPrompt(overrides: Record<string, unknown> = {}) {
  return {
    _id: "prompt-1",
    schemaVersion: CURRENT_PROMPT_SCHEMA_VERSION,
    creator: "GCREATOR",
    title: "A useful prompt",
    category: "Writing",
    description: "Summarise a document.",
    tags: ["writing", "summary"],
    licence: "standard",
    imageUrl: "https://cdn.example/prompt-1.png",
    priceStroops: "10000000",
    active: true,
    lifecycleState: "published",
    moderationStatus: "none",
    ...overrides,
  };
}

describe("Prompt v3 candidate", () => {
  it("normal path: maps a v2 record without changing any live value", () => {
    const report = checkPromptMigrationCompatibility([validPrompt()]);

    expect(report.fromVersion).toBe(CURRENT_PROMPT_SCHEMA_VERSION);
    expect(report.toVersion).toBe(NEXT_PROMPT_SCHEMA_VERSION);
    expect(report.toVersion).toBe(3);
    expect(report.compatible).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.blockedRecords).toBe(0);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);

    const [record] = report.records;
    expect(record.compatible).toBe(true);
    expect(record.candidate).toMatchObject({
      schemaVersion: 3,
      title: "A useful prompt",
      imageUrl: "https://cdn.example/prompt-1.png",
      priceStroops: "10000000",
      active: true,
      lifecycleState: "published",
    });
    expect(record.candidate).not.toHaveProperty("image");
    expect(record.candidate).not.toHaveProperty("price");
    expect(record.candidate).not.toHaveProperty("isActive");
    expect(record.candidate).not.toHaveProperty("listingStatus");
    expect(record.unknownFields).toEqual([]);
  });

  it("maps every deprecated alias when the replacement is absent", () => {
    const legacy = validPrompt({
      schemaVersion: 1,
      imageUrl: undefined,
      image: "https://legacy.example/prompt.png",
      priceStroops: undefined,
      price: 12.5,
      active: undefined,
      isActive: false,
      lifecycleState: undefined,
      listingStatus: "ready",
    });

    const candidate = buildPromptV3Candidate(legacy);
    expect(candidate).toMatchObject({
      schemaVersion: 3,
      imageUrl: "https://legacy.example/prompt.png",
      active: false,
      // The documented read path gives the inactive flag precedence over
      // listingStatus, so the record becomes hidden rather than review.
      lifecycleState: "hidden",
    });
    expect(candidate).not.toHaveProperty("image");
    expect(candidate).not.toHaveProperty("isActive");
    expect(candidate).not.toHaveProperty("listingStatus");

    // `price` has no unit, so it is removed from the candidate but blocks the
    // migration until priceStroops is backfilled from the source.
    const report = checkPromptMigrationCompatibility([legacy]);
    expect(report.compatible).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "unmapped_deprecated_field",
        severity: "error",
        recordId: "prompt-1",
        field: "price",
      }),
    );
    expect(report.warningCount).toBe(1); // legacy v1 upgrade warning
  });

  it("maps every listingStatus alias deterministically and rejects unknowns", () => {
    expect(lifecycleFromListingStatus("draft")).toBe("draft");
    expect(lifecycleFromListingStatus("ready")).toBe("review");
    expect(lifecycleFromListingStatus("pending_review")).toBe("review");
    expect(lifecycleFromListingStatus("active")).toBe("published");
    expect(lifecycleFromListingStatus("sold_out")).toBe("published");
    expect(lifecycleFromListingStatus("paused")).toBe("hidden");
    expect(lifecycleFromListingStatus("archived")).toBe("archived");
    expect(lifecycleFromListingStatus("PUBLISHED")).toBe("published");
    expect(lifecycleFromListingStatus("not-a-status")).toBeUndefined();
    expect(lifecycleFromListingStatus(42)).toBeUndefined();
  });

  it("back-derives lifecycle with the documented moderation/inactive precedence", () => {
    expect(derivePromptLifecycleState({})).toBe("draft");
    expect(derivePromptLifecycleState({ listingStatus: "published" })).toBe("published");
    expect(derivePromptLifecycleState({ listingStatus: "published", isActive: false })).toBe("hidden");
    expect(derivePromptLifecycleState({ listingStatus: "published", moderationStatus: "restricted" })).toBe("hidden");
    expect(derivePromptLifecycleState({ listingStatus: "draft", moderationStatus: "retired" })).toBe("archived");
    expect(derivePromptLifecycleState({ listingStatus: "not-a-status" })).toBe("draft");
  });

  it("is a pure function: the source record is not mutated", () => {
    const source = validPrompt({ image: "https://legacy.example/x.png" });
    const snapshot = JSON.parse(JSON.stringify(source));

    buildPromptV3Candidate(source);

    expect(source).toEqual(snapshot);
  });
});

describe("migration blockers", () => {
  it("blocks conflicting image aliases", () => {
    const report = checkPromptMigrationCompatibility([
      validPrompt({ image: "https://other.example/new.png" }),
    ]);

    expect(report.compatible).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "conflicting_rename", field: "image", severity: "error" }),
    );
  });

  it("treats identical image aliases as safe and drops the duplicate", () => {
    const url = "https://cdn.example/prompt-1.png";
    const report = assertPromptMigrationCompatible([validPrompt({ image: url })]);

    expect(report.records[0].candidate).toMatchObject({ imageUrl: url });
    expect(report.records[0].candidate).not.toHaveProperty("image");
  });

  it("blocks conflicting boolean aliases", () => {
    const report = checkPromptMigrationCompatibility([
      validPrompt({ active: true, isActive: false }),
    ]);

    expect(report.compatible).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "conflicting_rename", field: "isActive" }),
    );
  });

  it("blocks lifecycle values that disagree with listingStatus", () => {
    const report = checkPromptMigrationCompatibility([
      validPrompt({ listingStatus: "paused", lifecycleState: "published" }),
    ]);

    expect(report.compatible).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "conflicting_rename",
        field: "listingStatus",
        severity: "error",
      }),
    );
  });

  it("drops a legacy price with a warning when priceStroops already exists", () => {
    const report = checkPromptMigrationCompatibility([
      validPrompt({ price: 1, priceStroops: "9000000" }),
    ]);

    expect(report.compatible).toBe(true);
    expect(report.warningCount).toBe(1);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "conflicting_rename", field: "price", severity: "warning" }),
    );
    expect(report.records[0].candidate).toMatchObject({ priceStroops: "9000000" });
    expect(report.records[0].candidate).not.toHaveProperty("price");
  });

  it("blocks missing required fields and wrong types", () => {
    const noTitle = validPrompt({ title: undefined });
    const badTags = validPrompt({ _id: "prompt-2", tags: "not-an-array" });
    const badCategory = validPrompt({ _id: "prompt-3", category: 7 });

    const report = checkPromptMigrationCompatibility([noTitle, badTags, badCategory]);

    expect(report.compatible).toBe(false);
    expect(report.blockedRecords).toBe(3);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_required_field", recordId: "prompt-1", field: "title" }),
        expect.objectContaining({ code: "invalid_field_type", recordId: "prompt-2", field: "tags" }),
        expect.objectContaining({ code: "invalid_field_type", recordId: "prompt-3", field: "category" }),
      ]),
    );
  });

  it("fails closed on a record written by a newer build", () => {
    const report = checkPromptMigrationCompatibility([validPrompt({ schemaVersion: 4 })]);

    expect(report.compatible).toBe(false);
    expect(report.issues[0]).toMatchObject({
      code: "future_schema_version",
      severity: "error",
      recordId: "prompt-1",
    });
  });

  it("rejects an unknown target version instead of guessing a transform", () => {
    const report = checkPromptMigrationCompatibility([validPrompt()], { toVersion: 9 });

    expect(report.compatible).toBe(false);
    expect(report.issues[0]).toMatchObject({
      code: "unsupported_target_version",
      severity: "error",
      recordId: "<manifest>",
    });
  });

  it("reports malformed non-object records by index and keeps checking the rest", () => {
    const report = checkPromptMigrationCompatibility([null, validPrompt(), "oops"]);

    expect(report.compatible).toBe(false);
    expect(report.checked).toBe(3);
    expect(report.blockedRecords).toBe(2);
    expect(report.records[0]).toMatchObject({ recordId: "record-1", candidate: null });
    expect(report.records[1].compatible).toBe(true);
    expect(report.records[2]).toMatchObject({ recordId: "record-3", candidate: null });
  });

  it("lists unknown fields so operators can review custom data before removal", () => {
    const report = checkPromptMigrationCompatibility([
      validPrompt({ customAttribution: { source: "import" } }),
    ]);

    expect(report.compatible).toBe(true);
    expect(report.records[0].unknownFields).toEqual(["customAttribution"]);
  });
});

describe("deterministic retries and operational plans", () => {
  it("produces an identical fingerprint when the same snapshot is checked again", () => {
    const snapshot = [validPrompt(), validPrompt({ _id: "prompt-2", active: false })];

    const first = checkPromptMigrationCompatibility(snapshot);
    const retry = checkPromptMigrationCompatibility(snapshot);
    const reversed = checkPromptMigrationCompatibility([...snapshot].reverse());

    expect(retry.fingerprint).toBe(first.fingerprint);
    expect(retry.issues).toEqual(first.issues);
    expect(retry.records).toEqual(first.records);

    // Order is part of the snapshot identity: a reversed export must not
    // silently masquerade as the same run.
    expect(reversed.fingerprint).not.toBe(first.fingerprint);
  });

  it("changes the fingerprint when a blocking value changes", () => {
    const before = checkPromptMigrationCompatibility([validPrompt()]);
    const after = checkPromptMigrationCompatibility([validPrompt({ priceStroops: "1" })]);

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("returns explicit migration and rollback plans for operators", () => {
    const report = checkPromptMigrationCompatibility([validPrompt()]);

    expect(report.migrationPlan.length).toBeGreaterThanOrEqual(5);
    expect(report.migrationPlan.join(" ")).toContain("backup");
    expect(report.migrationPlan.join(" ")).toContain("v3");
    expect(report.rollbackPlan.length).toBeGreaterThanOrEqual(5);
    expect(report.rollbackPlan.join(" ")).toContain("Restore the pre-migration backup");
    expect(report.rollbackPlan.join(" ")).toContain("fingerprint");
    expect(PROMPT_V3_MANIFEST.removedFields).toEqual([
      "image",
      "price",
      "isActive",
      "listingStatus",
    ]);
  });

  it("throws a typed error carrying the full report", () => {
    let thrown: unknown;
    try {
      assertPromptMigrationCompatible([validPrompt({ title: undefined })]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SchemaMigrationCompatibilityError);
    const error = thrown as SchemaMigrationCompatibilityError;
    expect(error.code).toBe("schema_migration_incompatible");
    expect(error.report.compatible).toBe(false);
    expect(error.message).toContain("v3");
  });

  it("returns the report for compatible input without throwing", () => {
    expect(() => assertPromptMigrationCompatible([validPrompt()])).not.toThrow();
  });
});
