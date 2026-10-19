/**
 * Migration compatibility checks for the next Prompt storage schema (#1010).
 *
 * The current storage contract is Prompt v2 (`CURRENT_PROMPT_SCHEMA_VERSION`).
 * v3 is the first version that removes the long-deprecated aliases:
 *
 *   image          → imageUrl
 *   price          → priceStroops
 *   isActive       → active
 *   listingStatus  → lifecycleState
 *
 * Removing a field is only safe when every document can be mapped without
 * guessing. This module performs that proof before a migration is written:
 * it builds a deterministic v3 candidate for every record, blocks on values
 * that would be lost or ambiguous, and returns an explicit migration and
 * rollback plan. It is read-only — it never writes to MongoDB.
 *
 * Why price is blocked rather than converted
 * ------------------------------------------
 * `price` has no documented unit in legacy records (it predates the stroop
 * contract). Multiplying it would silently change what a buyer pays. Records
 * that only have `price` are therefore reported as `unmapped_deprecated_field`
 * and must be backfilled from their original catalog/chain source.
 *
 * See docs/operations/schema-migration-compatibility.md.
 */

import { createHash } from "crypto";
import { canonicalJson } from "./canonicalSerialization";
import { CURRENT_PROMPT_SCHEMA_VERSION } from "./schemaVersioning";

/** The storage version this build is preparing for. */
export const NEXT_PROMPT_SCHEMA_VERSION = CURRENT_PROMPT_SCHEMA_VERSION + 1;

export const PROMPT_V3_MANIFEST = {
  fromVersion: CURRENT_PROMPT_SCHEMA_VERSION,
  toVersion: NEXT_PROMPT_SCHEMA_VERSION,
  removedFields: ["image", "price", "isActive", "listingStatus"] as const,
  renamedFields: {
    image: "imageUrl",
    price: "priceStroops",
    isActive: "active",
    listingStatus: "lifecycleState",
  } as const,
  requiredFields: [
    "title",
    "category",
    "description",
    "tags",
    "licence",
    "lifecycleState",
    "moderationStatus",
  ] as const,
} as const;

export type CompatibilityIssueCode =
  | "invalid_record"
  | "future_schema_version"
  | "unsupported_target_version"
  | "unmapped_deprecated_field"
  | "conflicting_rename"
  | "missing_required_field"
  | "invalid_field_type"
  | "legacy_version_upgrade";

export interface CompatibilityIssue {
  code: CompatibilityIssueCode;
  severity: "error" | "warning";
  recordId: string;
  field?: string;
  message: string;
  remediation: string;
}

export interface PromptCompatibilityResult {
  recordId: string;
  sourceVersion: number;
  compatible: boolean;
  candidate: Record<string, unknown> | null;
  issues: CompatibilityIssue[];
  /** Fields not in the v2 registry that will be carried through unchanged. */
  unknownFields: string[];
}

export interface PromptMigrationCompatibilityReport {
  fromVersion: number;
  toVersion: number;
  manifest: typeof PROMPT_V3_MANIFEST;
  checked: number;
  compatible: boolean;
  blockedRecords: number;
  errorCount: number;
  warningCount: number;
  records: PromptCompatibilityResult[];
  issues: CompatibilityIssue[];
  /** Deterministic digest of the candidate content, stable across retries. */
  fingerprint: string;
  migrationPlan: string[];
  rollbackPlan: string[];
}

export interface CompatibilityOptions {
  toVersion?: number;
}

export class SchemaMigrationCompatibilityError extends Error {
  readonly code = "schema_migration_incompatible";

  constructor(readonly report: PromptMigrationCompatibilityReport) {
    super(
      `Prompt migration to v${report.toVersion} is blocked by ${report.errorCount} compatibility error(s).`,
    );
    this.name = "SchemaMigrationCompatibilityError";
  }
}

const KNOWN_V2_FIELDS = new Set([
  "_id",
  "__v",
  "id",
  "schemaVersion",
  "creator",
  "owner",
  "title",
  "category",
  "description",
  "previewText",
  "imageUrl",
  "image",
  "tags",
  "licence",
  "priceStroops",
  "price",
  "onChainId",
  "contentHash",
  "encryptedPrompt",
  "encryptionIv",
  "wrappedKey",
  "salesCount",
  "active",
  "isActive",
  "listingStatus",
  "lifecycleState",
  "moderationStatus",
  "createdAt",
  "updatedAt",
  "content",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordIdOf(record: Record<string, unknown>, index: number): string {
  const id = record._id ?? record.id ?? record.onChainId;
  return id === undefined || id === null || id === "" ? `record-${index + 1}` : String(id);
}

function sourceVersionOf(record: Record<string, unknown>): number {
  return typeof record.schemaVersion === "number" && Number.isFinite(record.schemaVersion)
    ? record.schemaVersion
    : 0;
}

/** Map the legacy listing enum onto the lifecycle enum used by v2+. */
export function lifecycleFromListingStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  switch (status.trim().toLowerCase()) {
    case "draft":
      return "draft";
    case "ready":
    case "pending_review":
    case "review":
      return "review";
    case "active":
    case "listed":
    case "published":
    case "sold_out":
      return "published";
    case "paused":
    case "unlisted":
    case "hidden":
      return "hidden";
    case "archived":
    case "retired":
      return "archived";
    default:
      return undefined;
  }
}

/**
 * Back-derive a lifecycle state exactly as the v0→v2 read path does.
 * This is a documented default (not a guess): moderation wins, then an
 * explicit inactive flag, then the legacy listing status, then `draft`.
 */
export function derivePromptLifecycleState(
  record: Record<string, unknown>,
): string {
  const moderation = String(record.moderationStatus ?? "none");
  if (moderation === "retired") return "archived";
  if (moderation === "restricted") return "hidden";
  if (record.isActive === false) return "hidden";
  return lifecycleFromListingStatus(record.listingStatus) ?? "draft";
}

function issue(
  code: CompatibilityIssueCode,
  severity: CompatibilityIssue["severity"],
  recordId: string,
  field: string | undefined,
  message: string,
  remediation: string,
): CompatibilityIssue {
  return { code, severity, recordId, field, message, remediation };
}

/**
 * Build the exact record v3 would store. Deprecated aliases are removed only
 * when their replacement is present (or can be derived without guessing).
 * The candidate is still produced for blocked records so operators can see
 * what would be written; callers must consult `compatible` first.
 */
export function buildPromptV3Candidate(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = { ...source };

  if (candidate.imageUrl === undefined && typeof candidate.image === "string") {
    candidate.imageUrl = candidate.image;
  }
  if (candidate.active === undefined && typeof candidate.isActive === "boolean") {
    candidate.active = candidate.isActive;
  }
  if (candidate.lifecycleState === undefined) {
    candidate.lifecycleState = derivePromptLifecycleState(candidate);
  }

  // Safe, non-destructive defaults already applied by the v0→v2 read path.
  if (candidate.category === undefined) candidate.category = "Other";
  if (candidate.description === undefined) candidate.description = "";
  if (candidate.tags === undefined) candidate.tags = [];
  if (candidate.licence === undefined) candidate.licence = "standard";
  if (candidate.moderationStatus === undefined) candidate.moderationStatus = "none";

  delete candidate.image;
  delete candidate.price;
  delete candidate.isActive;
  delete candidate.listingStatus;
  candidate.schemaVersion = NEXT_PROMPT_SCHEMA_VERSION;

  return candidate;
}

function typeMatches(value: unknown, type: "string" | "array"): boolean {
  return type === "string" ? typeof value === "string" : Array.isArray(value);
}

function inspectRecord(
  raw: unknown,
  index: number,
  toVersion: number,
): PromptCompatibilityResult {
  if (!isPlainObject(raw)) {
    const recordId = `record-${index + 1}`;
    return {
      recordId,
      sourceVersion: 0,
      compatible: false,
      candidate: null,
      issues: [
        issue(
          "invalid_record",
          "error",
          recordId,
          undefined,
          "Record is not a plain object.",
          "Export the document as a JSON object and retry the compatibility check.",
        ),
      ],
      unknownFields: [],
    };
  }

  const recordId = recordIdOf(raw, index);
  const sourceVersion = sourceVersionOf(raw);
  const issues: CompatibilityIssue[] = [];

  if (sourceVersion > toVersion) {
    issues.push(
      issue(
        "future_schema_version",
        "error",
        recordId,
        "schemaVersion",
        `Record is at v${sourceVersion}, newer than the target v${toVersion}.`,
        "Upgrade the running build instead of downgrading the record; never rewrite data written by a newer deployment.",
      ),
    );
  } else if (sourceVersion > PROMPT_V3_MANIFEST.fromVersion) {
    issues.push(
      issue(
        "legacy_version_upgrade",
        "warning",
        recordId,
        "schemaVersion",
        `Record already declares v${sourceVersion}; the migration will treat it as a no-op candidate.`,
        "Verify that the record was written by the v3-compatible build before re-running the migration.",
      ),
    );
  } else if (sourceVersion < PROMPT_V3_MANIFEST.fromVersion) {
    issues.push(
      issue(
        "legacy_version_upgrade",
        "warning",
        recordId,
        "schemaVersion",
        `Legacy v${sourceVersion} record will be upgraded using the v0→v2 defaults before v3 aliases are removed.`,
        "Run the compatibility report on a backup first and confirm the reported defaults are acceptable.",
      ),
    );
  }

  const imageUrlPresent = typeof raw.imageUrl === "string" && raw.imageUrl.length > 0;
  const imagePresent = typeof raw.image === "string" && raw.image.length > 0;
  if (imageUrlPresent && imagePresent && raw.imageUrl !== raw.image) {
    issues.push(
      issue(
        "conflicting_rename",
        "error",
        recordId,
        "image",
        "Both image and imageUrl are present with different values.",
        "Decide which URL is canonical (usually imageUrl), remove the other alias, then re-run the check.",
      ),
    );
  }

  if (raw.price !== undefined && raw.priceStroops === undefined) {
    issues.push(
      issue(
        "unmapped_deprecated_field",
        "error",
        recordId,
        "price",
        "Legacy price has no priceStroops replacement; its unit is not defined by the current schema.",
        "Backfill priceStroops from the original catalog or on-chain listing, verify the amount, then re-run the check.",
      ),
    );
  } else if (raw.price !== undefined) {
    issues.push(
      issue(
        "conflicting_rename",
        "warning",
        recordId,
        "price",
        "Legacy price will be dropped in favour of the existing priceStroops value.",
        "Confirm priceStroops is authoritative for this listing before applying the migration.",
      ),
    );
  }

  if (
    typeof raw.active === "boolean" &&
    typeof raw.isActive === "boolean" &&
    raw.active !== raw.isActive
  ) {
    issues.push(
      issue(
        "conflicting_rename",
        "error",
        recordId,
        "isActive",
        "active and isActive disagree about whether the listing is available.",
        "Resolve the status with the creator/moderation record; the migration will not guess which flag is correct.",
      ),
    );
  }

  const derivedLifecycle = lifecycleFromListingStatus(raw.listingStatus);
  if (
    typeof raw.lifecycleState === "string" &&
    derivedLifecycle !== undefined &&
    raw.lifecycleState !== derivedLifecycle
  ) {
    issues.push(
      issue(
        "conflicting_rename",
        "error",
        recordId,
        "listingStatus",
        `listingStatus maps to "${derivedLifecycle}" but lifecycleState is "${raw.lifecycleState}".`,
        "Reconcile the lifecycle with moderation history before removing listingStatus.",
      ),
    );
  }

  const candidate = buildPromptV3Candidate(raw);

  for (const field of PROMPT_V3_MANIFEST.requiredFields) {
    if (candidate[field] === undefined || candidate[field] === null) {
      issues.push(
        issue(
          "missing_required_field",
          "error",
          recordId,
          field,
          `Required v${toVersion} field "${field}" is missing.`,
          `Backfill "${field}" before running the migration; the read path cannot invent it without losing information.`,
        ),
      );
    }
  }

  for (const field of ["title", "category", "description", "licence", "lifecycleState", "moderationStatus"]) {
    const value = candidate[field];
    if (value !== undefined && value !== null && !typeMatches(value, "string")) {
      issues.push(
        issue(
          "invalid_field_type",
          "error",
          recordId,
          field,
          `Field "${field}" must be a string, received ${Array.isArray(value) ? "array" : typeof value}.`,
          `Repair the record's "${field}" value from a backup or the source export before migrating.`,
        ),
      );
    }
  }
  if (candidate.tags !== undefined && !typeMatches(candidate.tags, "array")) {
    issues.push(
      issue(
        "invalid_field_type",
        "error",
        recordId,
        "tags",
        `Field "tags" must be an array, received ${typeof candidate.tags}.`,
        "Replace the scalar tag value with a JSON array before migrating.",
      ),
    );
  }

  const unknownFields = Object.keys(raw).filter((key) => !KNOWN_V2_FIELDS.has(key));
  const compatible = !issues.some((entry) => entry.severity === "error");

  return { recordId, sourceVersion, compatible, candidate, issues, unknownFields };
}

/**
 * Check whether a batch of Prompt documents can be migrated to the next
 * storage version. The report is deterministic: the same documents in the
 * same order always produce the same issues and fingerprint.
 */
export function checkPromptMigrationCompatibility(
  records: readonly unknown[],
  options: CompatibilityOptions = {},
): PromptMigrationCompatibilityReport {
  const toVersion = options.toVersion ?? NEXT_PROMPT_SCHEMA_VERSION;
  const unsupportedTarget = toVersion !== NEXT_PROMPT_SCHEMA_VERSION;

  const results = records.map((record, index) => inspectRecord(record, index, toVersion));
  const issues = results.flatMap((result) => result.issues);
  if (unsupportedTarget) {
    issues.unshift(
      issue(
        "unsupported_target_version",
        "error",
        "<manifest>",
        "schemaVersion",
        `This build only knows how to prepare Prompt v${NEXT_PROMPT_SCHEMA_VERSION}; received target v${toVersion}.`,
        "Add the target version to this module with its own rename/removal contract before running the check.",
      ),
    );
  }

  const errorCount = issues.filter((entry) => entry.severity === "error").length;
  const warningCount = issues.filter((entry) => entry.severity === "warning").length;
  const compatible = errorCount === 0;
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        fromVersion: PROMPT_V3_MANIFEST.fromVersion,
        toVersion,
        records: results.map((result) => ({
          recordId: result.recordId,
          sourceVersion: result.sourceVersion,
          candidate: result.candidate,
        })),
      }),
    )
    .digest("hex");

  return {
    fromVersion: PROMPT_V3_MANIFEST.fromVersion,
    toVersion,
    manifest: PROMPT_V3_MANIFEST,
    checked: records.length,
    compatible,
    blockedRecords: results.filter((result) => !result.compatible).length,
    errorCount,
    warningCount,
    records: results,
    issues,
    fingerprint,
    migrationPlan: [
      `1. Pause Prompt writers and take a verified backup/restore point.`,
      `2. Run the compatibility check against the same snapshot; require compatible=true and review every warning.`,
      `3. Apply the v${toVersion} transform (buildPromptV3Candidate) in batches, stamping schemaVersion=${toVersion}.`,
      `4. Validate the post-migration snapshot with the same checker before re-enabling writers.`,
      `5. Deploy the read path that expects v${toVersion}; keep the v2 fingerprints for comparison.`,
    ],
    rollbackPlan: [
      `1. Stop the migration at a batch boundary; never run an older writer alongside the new schema.`,
      `2. Restore the pre-migration backup, or reverse each batch from the retained original records (the checker never mutates them).`,
      `3. Re-run the compatibility check against the restored snapshot and compare its fingerprint with the recorded pre-migration fingerprint.`,
      `4. Keep image/price/isActive/listingStatus readable by the v${PROMPT_V3_MANIFEST.fromVersion} code path until rollback is confirmed.`,
      `5. If any record has no recoverable source for a removed alias, stop and resolve it as a forward fix; do not re-add a guessed value.`,
    ],
  };
}

/** Throw when at least one record cannot be migrated without information loss. */
export function assertPromptMigrationCompatible(
  records: readonly unknown[],
  options: CompatibilityOptions = {},
): PromptMigrationCompatibilityReport {
  const report = checkPromptMigrationCompatibility(records, options);
  if (!report.compatible) throw new SchemaMigrationCompatibilityError(report);
  return report;
}
