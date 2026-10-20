import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redaction profiles and export schema for audit bundles (#911).
 *
 * Pure policy and redaction checks run without I/O. The export and verify
 * tests stub AuditLog.find with a correctly chained trail, as auditExport.test
 * does. The route tests cover refusals that happen before any database work.
 */

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const header = req.headers["x-test-admin"];
    if (!header) {
      res.status(401).json({ error: "Unauthorized: admin bearer token required." });
      return;
    }
    const [sub, scopes] = String(header).split("|");
    if (!scopes.split(",").includes(scope)) {
      res.status(401).json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    req.admin = { sub, scope: scopes.split(",") };
    next();
  },
}));
vi.mock("../db/connectDb", () => ({ default: async () => undefined }));

import { AuditLog } from "../models/AuditLog";
import { auditRouter } from "../routes/auditRoutes";
import {
  AuditExportPolicyError,
  REDACTED_VALUE,
  buildVerificationMetadata,
  pseudonymizeActor,
  redactExportRecord,
  resolveRedactionProfile,
} from "../services/auditExportRedaction";
import {
  computeRecordHash,
  exportAuditBundle,
  hashWalletAddress,
  verifyAuditExport,
} from "../services/auditTrail";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";

const GENESIS = "0".repeat(64);
const WALLET = "GABC";

interface RowSpec {
  actor?: string | null;
  walletAddress?: string | null;
  reason?: string | null;
  action?: string;
}

/** Builds a correctly chained set of stored audit rows. */
function buildChain(specs: RowSpec[]): any[] {
  let previousHash = GENESIS;
  return specs.map((spec, index) => {
    const row: any = {
      _id: `65f00000000000000000000${index}`,
      action: spec.action ?? "admin_auth_success",
      result: "success",
      promptId: null,
      walletAddress: spec.walletAddress ?? null,
      actor: spec.actor ?? null,
      requestId: `req-${index}`,
      reason: spec.reason ?? null,
      clientIp: null,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
      previousHash,
      integrityVersion: 2,
    };
    row.recordHash = computeRecordHash(row);
    previousHash = row.recordHash;
    return row;
  });
}

/** Stubs AuditLog.find for both the export cursor and the stored-trail lookup. */
function mockStore(rows: any[]) {
  vi.spyOn(AuditLog, "find").mockImplementation(((query: any) => {
    if (query?.recordHash) {
      const wanted = new Set(query.recordHash.$in);
      return { lean: async () => rows.filter((row) => wanted.has(row.recordHash)) };
    }
    const chain: any = {
      sort: () => chain,
      limit: () => chain,
      lean: () => chain,
      cursor: () => ({
        async *[Symbol.asyncIterator]() {
          yield* rows;
        },
      }),
    };
    return chain;
  }) as any);
}

// Stored rows hold the wallet hash, never the raw address (see recordAuditEvent).
const SAMPLE: RowSpec = {
  actor: "ops-jane",
  walletAddress: hashWalletAddress(WALLET),
  reason: "sub=ops-jane scope=audit:export investigation INC-9",
};

describe("resolveRedactionProfile", () => {
  it("defaults to the most restrictive purpose and profile", () => {
    expect(resolveRedactionProfile({ scopes: ["audit:export"] })).toEqual({
      purpose: "external_disclosure",
      profile: "external_share",
    });
  });

  it("maps internal investigation to the investigation profile", () => {
    expect(
      resolveRedactionProfile({ purpose: "internal_investigation", scopes: ["audit:export"] }),
    ).toEqual({ purpose: "internal_investigation", profile: "investigation" });
  });

  it("refuses a forensic export without audit:export:full instead of downgrading it", () => {
    let thrown: unknown;
    try {
      resolveRedactionProfile({ purpose: "forensic", scopes: ["audit:export"] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuditExportPolicyError);
    expect((thrown as AuditExportPolicyError).code).toBe("profile_forbidden");
  });

  it("allows a forensic export for a caller holding audit:export:full", () => {
    expect(
      resolveRedactionProfile({ purpose: "forensic", scopes: ["audit:export", "audit:export:full"] }),
    ).toEqual({ purpose: "forensic", profile: "full" });
  });

  it("rejects unknown purposes", () => {
    try {
      resolveRedactionProfile({ purpose: "marketing", scopes: ["audit:export"] });
      throw new Error("expected invalid_purpose");
    } catch (err) {
      expect((err as AuditExportPolicyError).code).toBe("invalid_purpose");
    }
  });
});

describe("redactExportRecord", () => {
  const record = {
    actor: "ops-jane",
    walletHash: "abc123",
    requestId: "req-1",
    reason: "investigating INC-9",
  };

  it("leaves every field alone under the full profile", () => {
    expect(redactExportRecord(record, "full")).toEqual(record);
  });

  it("pseudonymizes the actor only under the investigation profile", () => {
    const redacted = redactExportRecord(record, "investigation");
    expect(redacted.actor).toBe(pseudonymizeActor("ops-jane"));
    expect(redacted.walletHash).toBe("abc123");
    expect(redacted.requestId).toBe("req-1");
    expect(redacted.reason).toBe("investigating INC-9");
  });

  it("pseudonymizes the actor and redacts wallet, request, and reason for external share", () => {
    expect(redactExportRecord(record, "external_share")).toEqual({
      actor: pseudonymizeActor("ops-jane"),
      walletHash: REDACTED_VALUE,
      requestId: REDACTED_VALUE,
      reason: REDACTED_VALUE,
    });
  });

  it("keeps nulls as nulls so redaction does not invent values", () => {
    const empty = { actor: null, walletHash: null, requestId: null, reason: null };
    expect(redactExportRecord(empty, "external_share")).toEqual(empty);
  });

  it("gives the same pseudonym for the same actor and a different one for another", () => {
    expect(pseudonymizeActor("ops-jane")).toBe(pseudonymizeActor("ops-jane"));
    expect(pseudonymizeActor("ops-jane")).not.toBe(pseudonymizeActor("ops-bob"));
    expect(pseudonymizeActor("ops-jane")).toMatch(/^anon_[0-9a-f]{16}$/);
  });

  it("describes what each profile changed in the verification metadata", () => {
    expect(buildVerificationMetadata("full")).toMatchObject({
      redactedFields: [],
      pseudonymScheme: null,
      recordHashCheck: "bundle",
    });
    expect(buildVerificationMetadata("external_share")).toMatchObject({
      redactedFields: ["actor", "walletHash", "requestId", "reason"],
      pseudonymScheme: "sha256-domain-separated",
      recordHashCheck: "stored-trail",
    });
  });
});

describe("audit export by redaction profile (#911)", () => {
  let rows: any[];

  beforeEach(() => {
    vi.restoreAllMocks();
    rows = buildChain([SAMPLE, { actor: "ops-bob", action: "admin_auth_denied", reason: "scope" }]);
    mockStore(rows);
  });

  it("exports differ by profile and sensitive fields are absent from the redacted export", async () => {
    const full = await exportAuditBundle({}, { profile: "full" });
    const external = await exportAuditBundle({}, { profile: "external_share" });

    expect(full.records[0].actor).toBe("ops-jane");
    expect(external.records[0].actor).toBe(pseudonymizeActor("ops-jane"));

    const serialized = JSON.stringify(external);
    expect(serialized).not.toContain("ops-jane");
    expect(serialized).not.toContain("ops-bob");
    expect(serialized).not.toContain(hashWalletAddress(WALLET));
    expect(serialized).not.toContain("req-0");
    expect(serialized).not.toContain("INC-9");
  });

  it("stamps the schema version, profile, and verification metadata on every bundle", async () => {
    const bundle = await exportAuditBundle({}, { profile: "external_share" });
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.redactionProfile).toBe("external_share");
    expect(bundle.verification.recordHashCheck).toBe("stored-trail");
  });

  it("verifies a redacted export against the stored trail", async () => {
    const external = await exportAuditBundle({}, { profile: "external_share" });
    expect(await verifyAuditExport(external)).toEqual({
      valid: true,
      recordCount: 2,
      checksumValid: true,
      errors: [],
    });
  });

  it("detects a redacted record that was edited after export", async () => {
    const external = await exportAuditBundle({}, { profile: "external_share" });
    external.records[0].actor = pseudonymizeActor("someone-else");

    const result = await verifyAuditExport(external);
    expect(result.valid).toBe(false);
    expect(result.checksumValid).toBe(false);
    expect(result.errors).toContain("Record 1: differs from the stored audit record.");
  });

  it("still verifies a full export by its recordHash", async () => {
    const full = await exportAuditBundle({}, { profile: "full" });
    expect((await verifyAuditExport(full)).valid).toBe(true);
  });

  it("produces an empty but valid export when nothing matches", async () => {
    mockStore([]);
    const bundle = await exportAuditBundle({}, { profile: "external_share" });
    expect(bundle.recordCount).toBe(0);
    expect(await verifyAuditExport(bundle)).toEqual({
      valid: true,
      recordCount: 0,
      checksumValid: true,
      errors: [],
    });
  });

  it("accepts a schema v1 bundle, which had no schema or profile fields", async () => {
    const full = await exportAuditBundle({}, { profile: "full" });
    const legacy = {
      records: full.records,
      integrityChecksum: full.integrityChecksum,
    };
    expect((await verifyAuditExport(legacy)).valid).toBe(true);
  });

  it("rejects an unsupported schema version and an unknown profile", async () => {
    const full = await exportAuditBundle({}, { profile: "full" });

    const future = await verifyAuditExport({ ...full, schemaVersion: 99 });
    expect(future.valid).toBe(false);
    expect(future.errors).toEqual(["Unsupported export schema version: 99."]);

    const unknown = await verifyAuditExport({ ...full, redactionProfile: "partial" });
    expect(unknown.valid).toBe(false);
    expect(unknown.errors).toEqual(["Unknown redaction profile: partial."]);
  });
});

describe("audit export route refusals (#911)", () => {
  let http: HttpTestServer;

  beforeAll(async () => {
    http = await startHttpServer((app) => {
      app.use("/api/audit", auditRouter);
    });
  });

  afterAll(async () => {
    await http?.close();
  });

  it("refuses a forensic export to a caller without audit:export:full", async () => {
    const res = await jsonCall(http.baseUrl, "/api/audit/export?purpose=forensic", {
      headers: { "x-test-admin": "ops-jane|audit:export" },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("profile_forbidden");
  });

  it("rejects an unknown purpose with 400", async () => {
    const res = await jsonCall(http.baseUrl, "/api/audit/export?purpose=marketing", {
      headers: { "x-test-admin": "ops-jane|audit:export" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_purpose");
  });

  it("refuses callers without audit:export at all", async () => {
    const res = await jsonCall(http.baseUrl, "/api/audit/export", {
      headers: { "x-test-admin": "viewer|flags:read" },
    });
    expect(res.status).toBe(401);
  });
});
