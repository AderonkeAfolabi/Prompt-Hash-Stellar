import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Schema-driven admin config (#909).
 *
 * Pure validation and diff tests run without any I/O. The route tests cover the
 * paths that must reject before storage is touched: invalid bodies never reach
 * `applyAuditedConfigChange`, and callers without `flags:write` are refused.
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
    req.admin = { sub };
    next();
  },
}));

import { featureFlagRouter } from "../routes/featureFlagRoutes";
import { featureFlagService } from "../services/featureFlagService";
import {
  buildConfigDiffPreview,
  FEATURE_FLAG_UPDATE_SCHEMA,
  validateConfigInput,
} from "../services/adminConfigSchema";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";

const WRITER = { "x-test-admin": "ops-alice|flags:write,flags:read" };
const READ_ONLY = { "x-test-admin": "viewer|flags:read" };

let http: HttpTestServer;

beforeAll(async () => {
  http = await startHttpServer((app) => {
    app.use("/api/flags", featureFlagRouter);
  });
});

afterAll(async () => {
  await http?.close();
});

describe("validateConfigInput", () => {
  it("accepts a valid update and returns only declared fields", () => {
    const result = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, {
      status: "experimental",
      environments: { staging: true },
      rolloutPercentage: 25,
      reason: "INC-12 staged rollout",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        status: "experimental",
        environments: { staging: true },
        rolloutPercentage: 25,
      },
    });
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    const result = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, {
      status: "enabled",
      createdBy: "someone-else",
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "createdBy", message: "unknown field" }],
    });
  });

  it("rejects a status outside the declared enum", () => {
    const result = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, { status: "on" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("status");
    }
  });

  it("rejects rollout percentages that are out of range or not integers", () => {
    for (const rolloutPercentage of [-1, 101, 12.5, "50", null]) {
      const result = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, { rolloutPercentage });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0].path).toBe("rolloutPercentage");
      }
    }
  });

  it("rejects unknown environments and non-boolean environment values", () => {
    const unknownEnv = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, {
      environments: { sandbox: true },
    });
    expect(unknownEnv).toEqual({
      ok: false,
      issues: [
        {
          path: "environments.sandbox",
          message: "unknown key; allowed: development, staging, production",
        },
      ],
    });

    const notBoolean = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, {
      environments: { production: "yes" },
    });
    expect(notBoolean.ok).toBe(false);
    if (!notBoolean.ok) {
      expect(notBoolean.issues[0]).toEqual({
        path: "environments.production",
        message: "must be a boolean",
      });
    }
  });

  it("rejects non-object bodies and empty patches", () => {
    expect(validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, ["enabled"]).ok).toBe(false);
    const empty = validateConfigInput(FEATURE_FLAG_UPDATE_SCHEMA, { reason: "only a reason" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.issues[0].message).toContain("at least one of");
    }
  });
});

describe("buildConfigDiffPreview", () => {
  const before = {
    name: "stellar_atomic_settlement",
    status: "disabled",
    environments: { development: true, staging: false, production: false },
    rolloutPercentage: 0,
  };

  it("reports only the fields that would change, with before and after values", () => {
    const preview = buildConfigDiffPreview(before, { status: "enabled", rolloutPercentage: 0 });
    expect(preview.changedFields).toEqual(["status"]);
    expect(preview.changes).toEqual([{ field: "status", before: "disabled", after: "enabled" }]);
    expect(preview.noop).toBe(false);
  });

  it("diffs environments one entry at a time", () => {
    const preview = buildConfigDiffPreview(before, {
      environments: { development: true, production: true },
    });
    expect(preview.changedFields).toEqual(["environments.production"]);
    expect(preview.changes[0]).toEqual({
      field: "environments.production",
      before: false,
      after: true,
    });
  });

  it("produces a rollback patch that restores the previous values", () => {
    const preview = buildConfigDiffPreview(before, {
      status: "enabled",
      environments: { production: true },
    });
    expect(preview.rollbackPatch).toEqual({
      status: "disabled",
      environments: { production: false },
    });
    expect(preview.rollbackNotes).toContain('PATCH with {"status":"disabled","environments":{"production":false}}');
  });

  it("marks an identical patch as a no-op with nothing to roll back", () => {
    const preview = buildConfigDiffPreview(before, { status: "disabled" });
    expect(preview.noop).toBe(true);
    expect(preview.changes).toEqual([]);
    expect(preview.rollbackPatch).toEqual({});
    expect(preview.rollbackNotes).toBe("No field would change; nothing to roll back.");
  });
});

describe("admin config routes (#909)", () => {
  it("rejects an invalid PATCH with 400 and never calls the service", async () => {
    const updateSpy = vi.spyOn(featureFlagService, "updateFlag");
    const res = await jsonCall(http.baseUrl, "/api/flags/stellar_atomic_settlement", {
      method: "PATCH",
      headers: WRITER,
      body: JSON.stringify({ rolloutPercentage: 250 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid configuration.");
    expect(res.body.issues).toEqual([
      { path: "rolloutPercentage", message: "must be an integer between 0 and 100" },
    ]);
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it("rejects a preview with an invalid body before reading the flag", async () => {
    const getSpy = vi.spyOn(featureFlagService, "getFlag");
    const res = await jsonCall(http.baseUrl, "/api/flags/stellar_atomic_settlement/preview", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({ status: "maybe" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("refuses preview and PATCH for callers without flags:write", async () => {
    const preview = await jsonCall(http.baseUrl, "/api/flags/stellar_atomic_settlement/preview", {
      method: "POST",
      headers: READ_ONLY,
      body: JSON.stringify({ status: "enabled" }),
    });
    expect(preview.status).toBe(401);

    const patch = await jsonCall(http.baseUrl, "/api/flags/stellar_atomic_settlement", {
      method: "PATCH",
      headers: READ_ONLY,
      body: JSON.stringify({ status: "enabled" }),
    });
    expect(patch.status).toBe(401);
  });
});
