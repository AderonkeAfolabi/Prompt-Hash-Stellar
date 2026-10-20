/**
 * Permission-aware bulk action framework (#910).
 *
 * A bulk action never runs on "whatever the last filter matched". Callers send
 * an explicit selection: record ids, each paired with the `version` the caller
 * last saw. The framework then works in three steps:
 *
 *   1. plan    — checks the actor's permission, looks up every selected record,
 *                and marks each item `eligible` or with a reason it is not
 *                (not found, stale, duplicate, or ineligible for this action).
 *                Planning never writes; this is the dry run.
 *   2. confirm — the plan carries a confirmation token: an HMAC over the action,
 *                the actor, and the exact eligible set with versions. Execution
 *                must present that token. Any change to the selection or to the
 *                underlying records changes the eligible set and the token no
 *                longer matches, so the stale plan is refused.
 *   3. execute — the token is claimed in an execution ledger before anything is
 *                applied, so the same confirmed plan can run only once. Only
 *                eligible items are applied, and each outcome is reported
 *                individually.
 *
 * `apply` implementations must bump the record's `version`. That is what makes
 * a second plan differ from the first after a partial run.
 *
 * This module is pure apart from the injected `loadRecords`, `apply`, and
 * ledger. It is not yet wired to a route; see docs/operations/bulk-actions.md.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { canonicalJson } from "./canonicalSerialization";

export const BULK_SELECTION_MAX = 500;

export interface BulkActor {
  id: string;
  permissions: ReadonlySet<string>;
}

export interface BulkRecord {
  id: string;
  version: number;
}

/** One entry of the bulk input format: which record, and the version the caller saw. */
export interface BulkSelectionItem {
  recordId: string;
  expectedVersion: number;
}

export interface BulkActionDefinition<R extends BulkRecord> {
  /** Stable action name, bound into the confirmation token. */
  name: string;
  /** Permission the actor must hold; checked before any record is loaded. */
  requiredPermission: string;
  /** Returns a human-readable reason when the record cannot take this action. */
  ineligibleReason: (record: R, actor: BulkActor) => string | null;
  /** Applies the action to one record. Must bump `version`. */
  apply: (record: R, actor: BulkActor) => Promise<void>;
}

export type BulkItemCode =
  | "eligible"
  | "not_found"
  | "stale_selection"
  | "duplicate_selection"
  | "ineligible";

export interface BulkPlanItem extends BulkSelectionItem {
  code: BulkItemCode;
  reason: string | null;
}

export interface BulkPlan {
  action: string;
  actorId: string;
  total: number;
  eligibleCount: number;
  ineligibleCount: number;
  items: BulkPlanItem[];
  confirmationToken: string;
}

export type BulkActionErrorCode =
  | "invalid_selection"
  | "selection_too_large"
  | "unauthorized"
  | "confirmation_mismatch"
  | "duplicate_execution";

export class BulkActionError extends Error {
  constructor(
    readonly code: BulkActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BulkActionError";
  }
}

/** Execution ledger that makes a confirmed plan single-use. */
export interface BulkExecutionLedger {
  isClaimed(token: string): Promise<boolean>;
  /** Atomically claims the token. Returns false when it was already claimed. */
  claim(token: string): Promise<boolean>;
}

export function createMemoryBulkExecutionLedger(): BulkExecutionLedger {
  const claimed = new Set<string>();
  return {
    async isClaimed(token) {
      return claimed.has(token);
    },
    async claim(token) {
      if (claimed.has(token)) return false;
      claimed.add(token);
      return true;
    },
  };
}

/**
 * Parse the bulk input format from an untrusted request body:
 * `{ "selection": [{ "recordId": string, "expectedVersion": integer }] }`.
 */
export function parseBulkSelection(input: unknown): BulkSelectionItem[] {
  const selection = (input as { selection?: unknown } | null)?.selection;
  if (!Array.isArray(selection) || selection.length === 0) {
    throw new BulkActionError("invalid_selection", "selection must be a non-empty array.");
  }
  if (selection.length > BULK_SELECTION_MAX) {
    throw new BulkActionError(
      "selection_too_large",
      `selection may contain at most ${BULK_SELECTION_MAX} items.`,
    );
  }
  return selection.map((entry, index) => {
    const recordId = (entry as { recordId?: unknown } | null)?.recordId;
    const expectedVersion = (entry as { expectedVersion?: unknown } | null)?.expectedVersion;
    if (typeof recordId !== "string" || !recordId.trim()) {
      throw new BulkActionError("invalid_selection", `selection[${index}].recordId must be a non-empty string.`);
    }
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) {
      throw new BulkActionError(
        "invalid_selection",
        `selection[${index}].expectedVersion must be a non-negative integer.`,
      );
    }
    return { recordId: recordId.trim(), expectedVersion: expectedVersion as number };
  });
}

function computeConfirmationToken(
  secret: string,
  payload: { action: string; actorId: string; eligible: BulkSelectionItem[] },
): string {
  const eligible = [...payload.eligible]
    .sort((a, b) => a.recordId.localeCompare(b.recordId))
    .map((item) => [item.recordId, item.expectedVersion]);
  return createHmac("sha256", secret)
    .update(canonicalJson({ ...payload, eligible }))
    .digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Plan a bulk action without writing anything. Permission failures throw
 * before any record is read; per-record problems are reported on the item.
 */
export function planBulkAction<R extends BulkRecord>(input: {
  definition: BulkActionDefinition<R>;
  actor: BulkActor;
  selection: BulkSelectionItem[];
  records: ReadonlyMap<string, R>;
  confirmationSecret: string;
}): BulkPlan {
  const { definition, actor, selection, records } = input;

  if (!actor.permissions.has(definition.requiredPermission)) {
    throw new BulkActionError(
      "unauthorized",
      `Missing permission for ${definition.name}: ${definition.requiredPermission}`,
    );
  }
  if (selection.length === 0) {
    throw new BulkActionError("invalid_selection", "selection must not be empty.");
  }
  if (selection.length > BULK_SELECTION_MAX) {
    throw new BulkActionError(
      "selection_too_large",
      `selection may contain at most ${BULK_SELECTION_MAX} items.`,
    );
  }

  const seen = new Set<string>();
  const items: BulkPlanItem[] = selection.map((entry): BulkPlanItem => {
    const base = { recordId: entry.recordId, expectedVersion: entry.expectedVersion };
    if (seen.has(entry.recordId)) {
      return { ...base, code: "duplicate_selection", reason: "record is selected more than once" };
    }
    seen.add(entry.recordId);

    const record = records.get(entry.recordId);
    if (!record) {
      return { ...base, code: "not_found", reason: "record does not exist" };
    }
    if (record.version !== entry.expectedVersion) {
      return {
        ...base,
        code: "stale_selection",
        reason: `selection saw version ${entry.expectedVersion}; current version is ${record.version}`,
      };
    }
    const reason = definition.ineligibleReason(record, actor);
    if (reason) {
      return { ...base, code: "ineligible", reason };
    }
    return { ...base, code: "eligible", reason: null };
  });

  const eligible = items.filter((item) => item.code === "eligible");
  return {
    action: definition.name,
    actorId: actor.id,
    total: items.length,
    eligibleCount: eligible.length,
    ineligibleCount: items.length - eligible.length,
    items,
    confirmationToken: computeConfirmationToken(input.confirmationSecret, {
      action: definition.name,
      actorId: actor.id,
      eligible,
    }),
  };
}

export interface BulkExecutionResult {
  action: string;
  /** False when no item was eligible, so nothing was applied or claimed. */
  executed: boolean;
  applied: string[];
  failed: Array<{ recordId: string; reason: string }>;
  skipped: BulkPlanItem[];
}

/**
 * Execute a previously confirmed bulk action. The token must equal the token
 * recomputed from a fresh plan, and the token is claimed before any write.
 */
export async function executeBulkAction<R extends BulkRecord>(input: {
  definition: BulkActionDefinition<R>;
  actor: BulkActor;
  selection: BulkSelectionItem[];
  confirmationToken: string;
  confirmationSecret: string;
  loadRecords: () => Promise<ReadonlyMap<string, R>>;
  ledger: BulkExecutionLedger;
}): Promise<BulkExecutionResult> {
  const { definition, actor, selection, confirmationToken, ledger } = input;

  if (await ledger.isClaimed(confirmationToken)) {
    throw new BulkActionError("duplicate_execution", "This confirmed plan has already been executed.");
  }

  const records = await input.loadRecords();
  const plan = planBulkAction({
    definition,
    actor,
    selection,
    records,
    confirmationSecret: input.confirmationSecret,
  });

  if (!constantTimeEqual(plan.confirmationToken, confirmationToken)) {
    throw new BulkActionError(
      "confirmation_mismatch",
      "The selection or the underlying records changed since this plan was confirmed. Plan again.",
    );
  }

  const eligible = plan.items.filter((item) => item.code === "eligible");
  const skipped = plan.items.filter((item) => item.code !== "eligible");
  if (eligible.length === 0) {
    return { action: definition.name, executed: false, applied: [], failed: [], skipped };
  }

  if (!(await ledger.claim(confirmationToken))) {
    throw new BulkActionError("duplicate_execution", "This confirmed plan has already been executed.");
  }

  const applied: string[] = [];
  const failed: Array<{ recordId: string; reason: string }> = [];
  for (const item of eligible) {
    const record = records.get(item.recordId);
    if (!record) {
      failed.push({ recordId: item.recordId, reason: "record disappeared before apply" });
      continue;
    }
    try {
      await definition.apply(record, actor);
      applied.push(item.recordId);
    } catch (err) {
      failed.push({
        recordId: item.recordId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { action: definition.name, executed: true, applied, failed, skipped };
}
