import express, { type Response } from "express";
import {
  featureFlagService,
  KNOWN_FEATURE_FLAGS,
  snapshotFlag,
} from "../services/featureFlagService.js";
import { requireAdminScope, type AdminRequest } from "../middleware/adminAuth.js";
import {
  applyAuditedConfigChange,
  AuditEvidenceUnavailableError,
} from "../services/adminConfigAudit.js";

export const featureFlagRouter = express.Router();

// List known system flag definitions and safe defaults
featureFlagRouter.get("/definitions", (_req, res) => {
  res.json({
    flags: KNOWN_FEATURE_FLAGS,
  });
});

// Admin routes. Every mutation is applied through `applyAuditedConfigChange`
// so it leaves hash-chained audit evidence or is rolled back (#1026).

function auditContext(req: AdminRequest) {
  const idempotencyKey = req.headers["idempotency-key"];
  return {
    actor: req.admin?.sub ?? "unknown-admin",
    requestId: req.correlationId ?? req.requestId ?? null,
    clientIp: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "") || null,
    changeId: typeof idempotencyKey === "string" && idempotencyKey ? idempotencyKey : null,
    reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
  };
}

function sendChangeError(res: Response, err: any, fallbackStatus: number) {
  if (err instanceof AuditEvidenceUnavailableError) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({
      error: err.code,
      message: err.message,
      rolledBack: err.rolledBack,
    });
  }
  return res.status(fallbackStatus).json({ error: err.message });
}

function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

featureFlagRouter.post(
  "/",
  requireAdminScope("flags:write"),
  async (req: AdminRequest, res: Response) => {
    const { name, description, status, environments, rolloutPercentage } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required." });
    }
    const ctx = auditContext(req);
    try {
      const result = await applyAuditedConfigChange({
        ...ctx,
        configType: "feature_flag",
        configKey: name.toLowerCase(),
        operation: "create",
        load: () => featureFlagService.getFlag(name),
        apply: () =>
          featureFlagService.createFlag({
            name,
            description,
            status,
            environments,
            rolloutPercentage,
            // The authenticated admin, never a client-supplied value.
            createdBy: ctx.actor,
          }),
        restore: (before) =>
          featureFlagService.restoreFlag(name, before ? snapshotFlag(before) : null),
        snapshot: snapshotFlag,
      });
      res.setHeader("X-Config-Change-Id", result.changeId);
      return res.json(result.value);
    } catch (err: any) {
      return sendChangeError(res, err, 400);
    }
  }
);

featureFlagRouter.get(
  "/",
  requireAdminScope("flags:read"),
  async (req, res) => {
    try {
      const flags = await featureFlagService.getAllFlags();
      res.json(flags);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

featureFlagRouter.get(
  "/:name",
  requireAdminScope("flags:read"),
  async (req, res) => {
    try {
      const flag = await featureFlagService.getFlag(req.params.name);
      if (!flag) {
        return res.status(404).json({ error: "Flag not found" });
      }
      res.json(flag);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

featureFlagRouter.patch(
  "/:name",
  requireAdminScope("flags:write"),
  async (req: AdminRequest, res: Response) => {
    const name = String(req.params.name);
    const { status, environments, rolloutPercentage } = req.body ?? {};
    try {
      const result = await applyAuditedConfigChange({
        ...auditContext(req),
        configType: "feature_flag",
        configKey: name.toLowerCase(),
        operation: "update",
        load: () => featureFlagService.getFlag(name),
        apply: () =>
          featureFlagService.updateFlag(
            name,
            definedOnly({ status, environments, rolloutPercentage }),
          ),
        restore: (before) =>
          featureFlagService.restoreFlag(name, before ? snapshotFlag(before) : null),
        snapshot: snapshotFlag,
      });
      res.setHeader("X-Config-Change-Id", result.changeId);
      return res.json(result.value);
    } catch (err: any) {
      return sendChangeError(res, err, 400);
    }
  }
);

featureFlagRouter.delete(
  "/:name",
  requireAdminScope("flags:write"),
  async (req: AdminRequest, res: Response) => {
    const name = String(req.params.name);
    try {
      const result = await applyAuditedConfigChange({
        ...auditContext(req),
        configType: "feature_flag",
        configKey: name.toLowerCase(),
        operation: "delete",
        load: () => featureFlagService.getFlag(name),
        apply: async () => {
          await featureFlagService.deleteFlag(name);
          return null;
        },
        restore: (before) =>
          featureFlagService.restoreFlag(name, before ? snapshotFlag(before) : null),
        snapshot: snapshotFlag,
      });
      res.setHeader("X-Config-Change-Id", result.changeId);
      return res.json({ success: true });
    } catch (err: any) {
      return sendChangeError(res, err, 400);
    }
  }
);

// Public route to check if a feature is enabled (for client-side)
featureFlagRouter.post(
  "/check/:name",
  async (req, res) => {
    try {
      const { userId, environment } = req.body;
      const evaluation = await featureFlagService.evaluateFlag(
        req.params.name,
        environment,
        userId
      );
      res.json(evaluation);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

