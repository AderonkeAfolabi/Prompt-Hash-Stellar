/**
 * Time-boxed maintainer access grants (#912).
 *
 * Standing maintainer privilege is replaced, for the scopes listed here, by a
 * grant that names a grantee, an approver, a reason, and an expiry. The
 * decision logic (`validateMaintainerGrantRequest`, `evaluateMaintainerGrant`,
 * `summarizeMaintainerGrant`, `buildMaintainerGrantReport`) is pure and covered
 * by unit tests. The IO helpers persist and audit.
 *
 * Lifecycle, each step audited:
 *   issue  -> `maintainer_grant_issued`  (if the audit write fails, the grant is removed)
 *   use    -> `maintainer_grant_used`    (middleware, before the handler runs)
 *   deny   -> `maintainer_grant_denied`  (middleware)
 *   revoke -> `maintainer_grant_revoked`
 *
 * Enforcement lives in `middleware/maintainerAccess.ts`. See
 * docs/operations/maintainer-access-grants.md.
 */

import { randomUUID } from "crypto";
import MaintainerAccessGrant, {
  MAINTAINER_GRANT_SCOPES,
  type MaintainerGrantScope,
} from "../models/MaintainerAccessGrant";
import { recordAuditEvent } from "./auditTrail";

export const MAINTAINER_GRANT_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const MAINTAINER_GRANT_MIN_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAINTAINER_GRANT_MAX_TTL_MS = 72 * 60 * 60 * 1000; // hard ceiling: 72 hours
export const MIN_MAINTAINER_GRANT_REASON_LENGTH = 12;

export type MaintainerGrantErrorCode =
  | "invalid_grantee"
  | "invalid_approver"
  | "self_approval_forbidden"
  | "invalid_scopes"
  | "invalid_reason"
  | "invalid_ttl";

export class MaintainerGrantError extends Error {
  constructor(
    readonly code: MaintainerGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MaintainerGrantError";
  }
}

export type MaintainerDenialCode =
  | "not_found"
  | "revoked"
  | "expired"
  | "grantee_mismatch"
  | "scope_not_granted";

export interface MaintainerGrantRecord {
  grantId: string;
  grantee: string;
  approver: string;
  scopes: string[];
  reason: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy?: string | null;
  lastUsedAt?: Date | null;
  useCount: number;
}

export type MaintainerGrantDecision =
  | { ok: true; grant: MaintainerGrantRecord }
  | { ok: false; code: MaintainerDenialCode; message: string };

export interface MaintainerGrantRequest {
  grantee: string;
  approver: string;
  scopes: string[];
  reason: string;
  ttlMs?: number;
}

export interface ValidatedMaintainerGrantRequest {
  grantee: string;
  approver: string;
  scopes: MaintainerGrantScope[];
  reason: string;
  ttlMs: number;
}

/**
 * Validate an issuance request before any state is written. An approver can
 * never approve their own grant, scopes must come from the fixed allow-list,
 * and the lifetime is bounded on both sides.
 */
export function validateMaintainerGrantRequest(
  request: MaintainerGrantRequest,
): ValidatedMaintainerGrantRequest {
  const grantee = request.grantee?.trim();
  if (!grantee) {
    throw new MaintainerGrantError("invalid_grantee", "grantee is required.");
  }

  const approver = request.approver?.trim();
  if (!approver) {
    throw new MaintainerGrantError("invalid_approver", "approver is required.");
  }
  if (approver.toLowerCase() === grantee.toLowerCase()) {
    throw new MaintainerGrantError(
      "self_approval_forbidden",
      "A maintainer cannot approve their own access grant.",
    );
  }

  const scopes = Array.from(new Set(request.scopes ?? []));
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !(MAINTAINER_GRANT_SCOPES as readonly string[]).includes(scope))
  ) {
    throw new MaintainerGrantError(
      "invalid_scopes",
      `scopes must be a non-empty subset of: ${MAINTAINER_GRANT_SCOPES.join(", ")}`,
    );
  }

  const reason = request.reason?.trim();
  if (!reason || reason.length < MIN_MAINTAINER_GRANT_REASON_LENGTH) {
    throw new MaintainerGrantError(
      "invalid_reason",
      `reason must be at least ${MIN_MAINTAINER_GRANT_REASON_LENGTH} characters (ticket reference recommended).`,
    );
  }

  const ttlMs = request.ttlMs ?? MAINTAINER_GRANT_DEFAULT_TTL_MS;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs < MAINTAINER_GRANT_MIN_TTL_MS ||
    ttlMs > MAINTAINER_GRANT_MAX_TTL_MS
  ) {
    throw new MaintainerGrantError(
      "invalid_ttl",
      `ttlMs must be between ${MAINTAINER_GRANT_MIN_TTL_MS} and ${MAINTAINER_GRANT_MAX_TTL_MS}.`,
    );
  }

  return {
    grantee,
    approver,
    scopes: scopes as MaintainerGrantScope[],
    reason,
    ttlMs,
  };
}

/**
 * Pure authorization decision for one use. Order matters: revocation and expiry
 * are checked before identity and scope, so an expired grant cannot be kept
 * alive by a caller that happens to match.
 */
export function evaluateMaintainerGrant(
  grant: MaintainerGrantRecord | null | undefined,
  context: { grantee: string; scope: string; now: Date },
): MaintainerGrantDecision {
  if (!grant || !grant.grantId) {
    return { ok: false, code: "not_found", message: "Maintainer grant not found." };
  }
  if (grant.revokedAt) {
    return { ok: false, code: "revoked", message: "Maintainer grant has been revoked." };
  }
  if (!(grant.expiresAt instanceof Date) || context.now.getTime() >= grant.expiresAt.getTime()) {
    return { ok: false, code: "expired", message: "Maintainer grant has expired." };
  }
  if (context.grantee !== grant.grantee) {
    return {
      ok: false,
      code: "grantee_mismatch",
      message: "Maintainer grant belongs to a different maintainer.",
    };
  }
  if (!Array.isArray(grant.scopes) || !grant.scopes.includes(context.scope)) {
    return {
      ok: false,
      code: "scope_not_granted",
      message: "Maintainer grant does not carry the required scope.",
    };
  }
  return { ok: true, grant };
}

export type MaintainerGrantStatus = "active" | "expired" | "revoked";

export interface MaintainerGrantSummary {
  grantId: string;
  grantee: string;
  approver: string;
  scopes: string[];
  reason: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  useCount: number;
  status: MaintainerGrantStatus;
}

export function maintainerGrantStatus(grant: MaintainerGrantRecord, now: Date): MaintainerGrantStatus {
  if (grant.revokedAt) return "revoked";
  return new Date(grant.expiresAt).getTime() > now.getTime() ? "active" : "expired";
}

export function summarizeMaintainerGrant(
  grant: MaintainerGrantRecord,
  now: Date = new Date(),
): MaintainerGrantSummary {
  return {
    grantId: grant.grantId,
    grantee: grant.grantee,
    approver: grant.approver,
    scopes: grant.scopes,
    reason: grant.reason,
    issuedAt: new Date(grant.issuedAt).toISOString(),
    expiresAt: new Date(grant.expiresAt).toISOString(),
    revokedAt: grant.revokedAt ? new Date(grant.revokedAt).toISOString() : null,
    revokedBy: grant.revokedBy ?? null,
    useCount: grant.useCount ?? 0,
    status: maintainerGrantStatus(grant, now),
  };
}

export interface MaintainerGrantReport {
  generatedAt: string;
  counts: Record<MaintainerGrantStatus, number>;
  active: MaintainerGrantSummary[];
  expired: MaintainerGrantSummary[];
  revoked: MaintainerGrantSummary[];
}

/** Groups grants into the active, expired, and revoked buckets an operator reviews. */
export function buildMaintainerGrantReport(
  grants: MaintainerGrantRecord[],
  now: Date = new Date(),
): MaintainerGrantReport {
  const report: MaintainerGrantReport = {
    generatedAt: now.toISOString(),
    counts: { active: 0, expired: 0, revoked: 0 },
    active: [],
    expired: [],
    revoked: [],
  };
  for (const grant of grants) {
    const summary = summarizeMaintainerGrant(grant, now);
    report.counts[summary.status] += 1;
    report[summary.status].push(summary);
  }
  return report;
}

export interface IssueMaintainerGrantResult {
  grantId: string;
  grantee: string;
  approver: string;
  scopes: MaintainerGrantScope[];
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Create a grant and record it. If the audit write fails the grant is removed
 * again, so access is never granted without evidence of who approved it.
 */
export async function issueMaintainerGrant(
  request: MaintainerGrantRequest,
  context: { now?: Date; requestId?: string | null } = {},
): Promise<IssueMaintainerGrantResult> {
  const validated = validateMaintainerGrantRequest(request);
  const now = context.now ?? new Date();
  const expiresAt = new Date(now.getTime() + validated.ttlMs);
  const grantId = `mag_${randomUUID()}`;

  await MaintainerAccessGrant.create({
    grantId,
    grantee: validated.grantee,
    approver: validated.approver,
    scopes: validated.scopes,
    reason: validated.reason,
    issuedAt: now,
    expiresAt,
    useCount: 0,
  });

  try {
    await recordAuditEvent(
      {
        action: "maintainer_grant_issued",
        result: "success",
        actor: validated.approver,
        target: grantId,
        targetType: "maintainer_grant",
        requestId: context.requestId ?? null,
        reason: `grantee=${validated.grantee} scopes=${validated.scopes.join(",")} expiresAt=${expiresAt.toISOString()}`,
        metadata: { grantId, ttlMs: validated.ttlMs },
      },
      { throwOnError: true },
    );
  } catch (err) {
    await MaintainerAccessGrant.deleteOne({ grantId });
    throw err;
  }

  return {
    grantId,
    grantee: validated.grantee,
    approver: validated.approver,
    scopes: validated.scopes,
    issuedAt: now,
    expiresAt,
  };
}

export async function findMaintainerGrant(grantId: string): Promise<MaintainerGrantRecord | null> {
  if (!grantId) return null;
  return (await MaintainerAccessGrant.findOne({ grantId }).lean()) as MaintainerGrantRecord | null;
}

/**
 * Atomically count one use. Returns null when the grant was revoked or expired
 * between evaluation and this write, so expiry holds under concurrent requests.
 */
export async function markMaintainerGrantUsed(
  grantId: string,
  now: Date,
): Promise<MaintainerGrantRecord | null> {
  const updated = await MaintainerAccessGrant.findOneAndUpdate(
    { grantId, revokedAt: null, expiresAt: { $gt: now } },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: now } },
    { new: true },
  ).lean();
  return (updated as MaintainerGrantRecord | null) ?? null;
}

export interface RevokeMaintainerGrantResult {
  revoked: boolean;
  grantId: string;
}

/** Revoke a grant. Idempotent: an unknown or already-revoked grant returns `revoked: false`. */
export async function revokeMaintainerGrant(
  grantId: string,
  context: { actor: string; requestId?: string | null; now?: Date },
): Promise<RevokeMaintainerGrantResult> {
  const now = context.now ?? new Date();
  const grant = await findMaintainerGrant(grantId);
  if (!grant || grant.revokedAt) {
    return { revoked: false, grantId };
  }

  await MaintainerAccessGrant.findOneAndUpdate(
    { grantId, revokedAt: null },
    { $set: { revokedAt: now, revokedBy: context.actor } },
  );

  await recordAuditEvent(
    {
      action: "maintainer_grant_revoked",
      result: "success",
      actor: context.actor,
      target: grantId,
      targetType: "maintainer_grant",
      requestId: context.requestId ?? null,
      reason: `grantId=${grantId} grantee=${grant.grantee} revokedBy=${context.actor}`,
    },
    { throwOnError: true },
  );

  return { revoked: true, grantId };
}

export async function listMaintainerGrants(
  filter: { grantee?: string; limit?: number } = {},
): Promise<MaintainerGrantRecord[]> {
  const query: Record<string, unknown> = {};
  if (filter.grantee) query.grantee = filter.grantee;
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 200), 1), 500);
  return (await MaintainerAccessGrant.find(query)
    .sort({ issuedAt: -1 })
    .limit(limit)
    .lean()) as unknown as MaintainerGrantRecord[];
}

export { MAINTAINER_GRANT_SCOPES };
