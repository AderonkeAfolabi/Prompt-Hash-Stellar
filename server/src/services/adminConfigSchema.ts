/**
 * Schema-driven validation and diff preview for high-risk admin configuration (#909).
 *
 * A proposed configuration change is checked against a declared schema before
 * anything is written, so an invalid value never reaches
 * `applyAuditedConfigChange`. `buildConfigDiffPreview` shows the operator the
 * field-level before/after diff and the patch that would restore the current
 * state, so a change can be reviewed before it is applied.
 *
 * Everything here is pure: no database or network access. Persistence and
 * audit stay in `adminConfigAudit.ts` and the route layer.
 */

export const FLAG_STATUSES = ["enabled", "disabled", "experimental"] as const;
export const FLAG_ENVIRONMENTS = ["development", "staging", "production"] as const;

/** A single declared field. Anything not declared is rejected. */
export type ConfigFieldRule =
  | { type: "enum"; values: readonly string[] }
  | { type: "integer"; min: number; max: number }
  | { type: "boolean-map"; keys: readonly string[] };

export interface ConfigSchema {
  /** Stable identifier written into validation errors and audit notes. */
  name: string;
  fields: Record<string, ConfigFieldRule>;
  /** Request keys that are not config fields but are accepted (e.g. audit `reason`). */
  passthroughKeys: readonly string[];
}

/** Update schema for an existing feature flag (PATCH /api/flags/:name). */
export const FEATURE_FLAG_UPDATE_SCHEMA: ConfigSchema = {
  name: "feature_flag.update",
  fields: {
    status: { type: "enum", values: FLAG_STATUSES },
    environments: { type: "boolean-map", keys: FLAG_ENVIRONMENTS },
    rolloutPercentage: { type: "integer", min: 0, max: 100 },
  },
  passthroughKeys: ["reason"],
};

export interface ConfigValidationIssue {
  /** Dotted path of the offending field, or "" for the whole body. */
  path: string;
  message: string;
}

export type ConfigValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ConfigValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkField(
  path: string,
  rule: ConfigFieldRule,
  value: unknown,
  issues: ConfigValidationIssue[],
): void {
  switch (rule.type) {
    case "enum":
      if (typeof value !== "string" || !rule.values.includes(value)) {
        issues.push({ path, message: `must be one of: ${rule.values.join(", ")}` });
      }
      return;
    case "integer":
      if (!Number.isInteger(value) || (value as number) < rule.min || (value as number) > rule.max) {
        issues.push({ path, message: `must be an integer between ${rule.min} and ${rule.max}` });
      }
      return;
    case "boolean-map":
      if (!isPlainObject(value)) {
        issues.push({ path, message: "must be an object of booleans" });
        return;
      }
      for (const [key, flag] of Object.entries(value)) {
        if (!rule.keys.includes(key)) {
          issues.push({ path: `${path}.${key}`, message: `unknown key; allowed: ${rule.keys.join(", ")}` });
        } else if (typeof flag !== "boolean") {
          issues.push({ path: `${path}.${key}`, message: "must be a boolean" });
        }
      }
      return;
  }
}

/**
 * Validate a proposed change against a schema. Unknown keys, wrong types,
 * out-of-range values, and empty patches are all rejected. On success the
 * returned `value` holds only the declared fields that were provided.
 */
export function validateConfigInput(schema: ConfigSchema, input: unknown): ConfigValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: "", message: "body must be a JSON object" }] };
  }

  const issues: ConfigValidationIssue[] = [];
  const allowed = new Set([...Object.keys(schema.fields), ...schema.passthroughKeys]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push({ path: key, message: "unknown field" });
    }
  }

  const value: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema.fields)) {
    if (input[key] === undefined) continue;
    const issuesBefore = issues.length;
    checkField(key, rule, input[key], issues);
    if (issues.length === issuesBefore) {
      value[key] =
        rule.type === "boolean-map" ? { ...(input[key] as Record<string, boolean>) } : input[key];
    }
  }

  if (Object.keys(value).length === 0 && issues.length === 0) {
    issues.push({ path: "", message: `at least one of ${Object.keys(schema.fields).join(", ")} is required` });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value };
}

export interface ConfigFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ConfigDiffPreview {
  changes: ConfigFieldChange[];
  changedFields: string[];
  noop: boolean;
  /** Patch body that restores the current state when sent back to the same endpoint. */
  rollbackPatch: Record<string, unknown>;
  rollbackNotes: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    isPlainObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/**
 * Field-level diff between the stored state and a validated patch. Environment
 * entries are compared one by one, so changing only `production` reports only
 * `environments.production`.
 */
export function buildConfigDiffPreview(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): ConfigDiffPreview {
  const changes: ConfigFieldChange[] = [];
  const rollbackPatch: Record<string, unknown> = {};
  const beforeEnvironments: Record<string, unknown> = isPlainObject(before.environments)
    ? before.environments
    : {};

  for (const [key, proposed] of Object.entries(patch)) {
    if (key === "environments" && isPlainObject(proposed)) {
      const rollbackEnvironments: Record<string, unknown> = {};
      for (const [env, afterValue] of Object.entries(proposed)) {
        const beforeValue = beforeEnvironments[env] ?? false;
        if (stableJson(beforeValue) !== stableJson(afterValue)) {
          changes.push({ field: `environments.${env}`, before: beforeValue, after: afterValue });
          rollbackEnvironments[env] = beforeValue;
        }
      }
      if (Object.keys(rollbackEnvironments).length > 0) {
        rollbackPatch.environments = rollbackEnvironments;
      }
      continue;
    }

    const beforeValue = before[key];
    if (stableJson(beforeValue) !== stableJson(proposed)) {
      changes.push({ field: key, before: beforeValue ?? null, after: proposed });
      rollbackPatch[key] = beforeValue ?? null;
    }
  }

  const changedFields = changes.map((change) => change.field);
  const noop = changes.length === 0;
  const rollbackNotes = noop
    ? "No field would change; nothing to roll back."
    : `To undo this change, send PATCH with ${JSON.stringify(rollbackPatch)}. Changed fields: ${changedFields.join(", ")}.`;

  return { changes, changedFields, noop, rollbackPatch, rollbackNotes };
}
