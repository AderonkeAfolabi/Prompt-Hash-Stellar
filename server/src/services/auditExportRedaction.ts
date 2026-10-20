/**
 * Redaction profiles and export schema for audit bundles (#911).
 *
 * An audit export can be shared beyond the people who may read every raw
 * field. A redaction profile decides which fields leave the system, and the
 * profile is chosen from the caller's scopes and the stated export purpose:
 *
 *   forensic              -> full             (needs audit:export:full)
 *   internal_investigation-> investigation    (needs audit:export)
 *   external_disclosure   -> external_share   (needs audit:export; the default)
 *
 * A caller can never obtain a richer profile than their scopes allow. Asking
 * for one is refused, not quietly downgraded, so the caller finds out.
 *
 * Redaction is deterministic: the same record under the same profile always
 * yields the same output, and an actor identifier maps to the same pseudonym
 * everywhere it appears in one export. That keeps the redacted bundle
 * internally consistent for review while hiding the identifier itself.
 *
 * This module is pure. The export and verification wiring lives in
 * `auditTrail.ts`.
 */

import { createHash } from "crypto";

/** Bundle schema version written by this code. v1 is the original #783 shape. */
export const AUDIT_EXPORT_SCHEMA_VERSION = 2;
export const SUPPORTED_AUDIT_EXPORT_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export const REDACTION_PROFILES: readonly string[] = ["full", "investigation", "external_share"];
export type RedactionProfile = "full" | "investigation" | "external_share";

export const EXPORT_PURPOSES: readonly string[] = [
  "forensic",
  "internal_investigation",
  "external_disclosure",
];
export type ExportPurpose = "forensic" | "internal_investigation" | "external_disclosure";

export const AUDIT_EXPORT_SCOPE = "audit:export";
export const AUDIT_EXPORT_FULL_SCOPE = "audit:export:full";

export const REDACTED_VALUE = "[REDACTED]";
const PSEUDONYM_DOMAIN = "audit-export-actor:";

export type ExportPolicyErrorCode = "invalid_purpose" | "profile_forbidden";

export class AuditExportPolicyError extends Error {
  constructor(
    readonly code: ExportPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditExportPolicyError";
  }
}

/** Fields of an exported record that a profile may change. */
export interface RedactableExportRecord {
  actor: string | null;
  walletHash: string | null;
  requestId: string | null;
  reason: string | null;
}

type RedactableField = keyof RedactableExportRecord;
type Treatment = "keep" | "pseudonym" | "redact";

const PROFILE_TREATMENTS: Record<RedactionProfile, Record<RedactableField, Treatment>> = {
  full: { actor: "keep", walletHash: "keep", requestId: "keep", reason: "keep" },
  investigation: { actor: "pseudonym", walletHash: "keep", requestId: "keep", reason: "keep" },
  external_share: { actor: "pseudonym", walletHash: "redact", requestId: "redact", reason: "redact" },
};

const PURPOSE_PROFILE: Record<ExportPurpose, RedactionProfile> = {
  forensic: "full",
  internal_investigation: "investigation",
  external_disclosure: "external_share",
};

const PROFILE_REQUIRED_SCOPE: Record<RedactionProfile, string> = {
  full: AUDIT_EXPORT_FULL_SCOPE,
  investigation: AUDIT_EXPORT_SCOPE,
  external_share: AUDIT_EXPORT_SCOPE,
};

/** Deterministic, domain-separated pseudonym for an admin actor identifier. */
export function pseudonymizeActor(actor: string): string {
  const digest = createHash("sha256").update(`${PSEUDONYM_DOMAIN}${actor}`).digest("hex");
  return `anon_${digest.slice(0, 16)}`;
}

/**
 * Choose the profile for a request. The purpose defaults to
 * `external_disclosure`, the most restrictive choice, when none is given.
 */
export function resolveRedactionProfile(input: {
  purpose?: string | null;
  scopes: readonly string[];
}): { purpose: ExportPurpose; profile: RedactionProfile } {
  const purpose = (input.purpose || "external_disclosure") as ExportPurpose;
  if (!EXPORT_PURPOSES.includes(purpose)) {
    throw new AuditExportPolicyError(
      "invalid_purpose",
      `purpose must be one of: ${EXPORT_PURPOSES.join(", ")}`,
    );
  }

  const profile = PURPOSE_PROFILE[purpose];
  const required = PROFILE_REQUIRED_SCOPE[profile];
  if (!input.scopes.includes(required)) {
    throw new AuditExportPolicyError(
      "profile_forbidden",
      `purpose ${purpose} requires scope ${required}`,
    );
  }
  return { purpose, profile };
}

function treat(value: string | null, treatment: Treatment): string | null {
  if (value === null || treatment === "keep") return value;
  if (treatment === "pseudonym") return pseudonymizeActor(value);
  return REDACTED_VALUE;
}

/** Apply a profile to one exported record. Null values stay null. */
export function redactExportRecord<T extends RedactableExportRecord>(
  record: T,
  profile: RedactionProfile,
): T {
  const rules = PROFILE_TREATMENTS[profile];
  return {
    ...record,
    actor: treat(record.actor, rules.actor),
    walletHash: treat(record.walletHash, rules.walletHash),
    requestId: treat(record.requestId, rules.requestId),
    reason: treat(record.reason, rules.reason),
  };
}

/** Fields a profile changes, in a stable order. Empty for `full`. */
export function redactedFieldsFor(profile: RedactionProfile): RedactableField[] {
  const rules = PROFILE_TREATMENTS[profile];
  return (Object.keys(rules) as RedactableField[]).filter((field) => rules[field] !== "keep");
}

export interface AuditExportVerificationMetadata {
  algorithm: "sha256";
  /** What `integrityChecksum` covers: the exported records, in order. */
  checksumScope: "records";
  redactionProfile: RedactionProfile;
  redactedFields: RedactableField[];
  pseudonymScheme: "sha256-domain-separated" | null;
  /**
   * `full` bundles can be checked from the bundle alone against each record's
   * `recordHash`. Redacted bundles can only be checked against the stored
   * trail, because the hashed fields have been removed.
   */
  recordHashCheck: "bundle" | "stored-trail";
}

export function buildVerificationMetadata(
  profile: RedactionProfile,
): AuditExportVerificationMetadata {
  const redactedFields = redactedFieldsFor(profile);
  return {
    algorithm: "sha256",
    checksumScope: "records",
    redactionProfile: profile,
    redactedFields,
    pseudonymScheme: redactedFields.includes("actor") ? "sha256-domain-separated" : null,
    recordHashCheck: profile === "full" ? "bundle" : "stored-trail",
  };
}
