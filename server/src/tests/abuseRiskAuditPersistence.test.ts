import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_SCHEMA_ACTIONS,
  AuditLog,
} from "../models/AuditLog";

/**
 * Regression test for the audit-persistence gap surfaced by #1046.
 *
 * `recordAuditEvent` is fire-and-forget: if the Mongoose schema enum rejects
 * an action, the event is logged to pino and then SILENTLY dropped from the
 * DB, so `GET /api/audit/export?action=...` finds nothing. Before the fix,
 * the schema hard-coded a 20-action subset that omitted every `abuse_risk_*`
 * (and most other declared) actions — meaning risk decisions never reached
 * the tamper-evident trail.
 *
 * These tests hold the invariant that the schema enum is a superset of the
 * declared `AUDIT_ACTIONS` contract, so a newly declared action is always
 * persistable.
 */

function actionEnum(): string[] {
  const path = AuditLog.schema.path("action");
  // Mongoose exposes the enum as `enumValues` on the SchemaString path.
  return (path as unknown as { enumValues?: string[] }).enumValues ?? [];
}

function newDoc(action: string) {
  return new AuditLog({
    action,
    result: "success",
    recordHash: "h".repeat(64),
    previousHash: "h".repeat(64),
  });
}

describe("AuditLog schema enum covers the declared contract", () => {
  it("accepts every AUDIT_ACTIONS entry (incl. abuse_risk_*)", () => {
    const allowed = actionEnum();
    const missing = AUDIT_ACTIONS.filter((a) => !allowed.includes(a));
    expect(missing).toEqual([]);
  });

  it("accepts every AUDIT_SCHEMA_ACTIONS entry", () => {
    const allowed = actionEnum();
    const missing = AUDIT_SCHEMA_ACTIONS.filter((a) => !allowed.includes(a));
    expect(missing).toEqual([]);
  });

  it("declares the three abuse_risk actions used by the guard and admin routes", () => {
    const allowed = actionEnum();
    expect(allowed).toContain("abuse_risk_decision");
    expect(allowed).toContain("abuse_risk_review_resolved");
    expect(allowed).toContain("abuse_risk_subject_reset");
  });

  it("validates a document carrying an abuse_risk_decision action", () => {
    const doc = newDoc("abuse_risk_decision");
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it("rejects an unknown action so typos do not pollute the trail", () => {
    const doc = newDoc("abuse_risk_typo");
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(String(err?.errors?.action?.message ?? "")).toMatch(
      /not a valid enum value/,
    );
  });
});
