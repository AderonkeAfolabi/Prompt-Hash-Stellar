import { Router, Response } from "express";
import connectDb from "../db/connectDb";
import { AUDIT_ACTIONS, AuditAction } from "../models/AuditLog";
import { AdminRequest, requireAdminScope } from "../middleware/adminAuth";
import { markPrivate } from "../middleware/etag";
import {
  AUDIT_EXPORT_MAX_LIMIT,
  AUDIT_EXPORT_SCOPES,
  AuditBundleExportFilter,
  AuditExportScope,
  exportAuditBundle,
  recordAuditEvent,
  verifyAuditExport,
  queryAccessAuditLogs,
  exportAccessAuditLogs,
} from "../services/auditTrail";
import { queryConfigChangeEvidence } from "../services/adminConfigAudit";
import {
  AuditExportPolicyError,
  resolveRedactionProfile,
} from "../services/auditExportRedaction";

/**
 * Audit-grade admin activity export (#783).
 *
 * GET  /api/audit/export         — filtered, paged, tamper-evident export
 * POST /api/audit/export/verify  — verify a previously exported bundle
 *
 * Both require the `audit:export` admin scope. The export also takes
 * `purpose` (forensic | internal_investigation | external_disclosure, default
 * external_disclosure), which selects the redaction profile (#911). Forensic
 * exports need `audit:export:full`. See docs/operations/audit-log-usage.md for
 * the export schema and the verification procedure.
 */
export const auditRouter = Router();

function parseDate(value: unknown): Date | undefined | null {
  if (value === undefined || value === "") return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseExportFilter(
  query: Record<string, unknown>,
): { filter: AuditBundleExportFilter } | { error: string } {
  const filter: AuditBundleExportFilter = {};

  if (query.actor) filter.actor = String(query.actor);
  if (query.promptId) filter.promptId = String(query.promptId);

  if (query.action) {
    const actions = String(query.action)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const unknown = actions.filter((a) => !(AUDIT_ACTIONS as readonly string[]).includes(a));
    if (unknown.length > 0) return { error: `Unknown action: ${unknown.join(", ")}` };
    filter.action = actions as AuditAction[];
  }

  if (query.scope) {
    const scope = String(query.scope);
    if (!(scope in AUDIT_EXPORT_SCOPES)) {
      return { error: `scope must be one of: ${Object.keys(AUDIT_EXPORT_SCOPES).join(", ")}` };
    }
    filter.scope = scope as AuditExportScope;
  }

  const since = parseDate(query.since);
  const until = parseDate(query.until);
  if (since === null || until === null) return { error: "since and until must be valid dates." };
  if (since && until && since > until) return { error: "since must not be after until." };
  filter.since = since;
  filter.until = until;

  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_EXPORT_MAX_LIMIT) {
      return { error: `limit must be an integer between 1 and ${AUDIT_EXPORT_MAX_LIMIT}.` };
    }
    filter.limit = limit;
  }

  if (query.after) filter.after = String(query.after);

  return { filter };
}

auditRouter.get(
  "/export",
  requireAdminScope("audit:export"),
  async (req: AdminRequest, res: Response) => {
    markPrivate(res);
    const parsed = parseExportFilter(req.query as Record<string, unknown>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // The redaction profile comes from the caller's scopes and stated purpose,
    // never from a client-chosen profile name (#911).
    let access: ReturnType<typeof resolveRedactionProfile>;
    try {
      access = resolveRedactionProfile({
        purpose: typeof req.query.purpose === "string" ? req.query.purpose : null,
        scopes: req.admin?.scope ?? [],
      });
    } catch (err) {
      if (err instanceof AuditExportPolicyError) {
        res.status(err.code === "invalid_purpose" ? 400 : 403).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }

    try {
      await connectDb();
      const bundle = await exportAuditBundle(parsed.filter, { profile: access.profile });

      // The export itself is admin activity: record who pulled what, without
      // echoing a raw wallet actor filter into the trail.
      await recordAuditEvent({
        action: "audit_export",
        result: "success",
        actor: req.admin?.sub ?? null,
        promptId: parsed.filter.promptId ?? null,
        requestId: req.correlationId ?? null,
        reason: `records=${bundle.recordCount} scope=${parsed.filter.scope ?? "all"} purpose=${access.purpose} profile=${access.profile}`,
      });

      res.json(bundle);
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid export cursor.") {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

auditRouter.post(
  "/export/verify",
  requireAdminScope("audit:export"),
  async (req: AdminRequest, res: Response) => {
    const { records, integrityChecksum, redactionProfile, schemaVersion } = req.body ?? {};
    if (!Array.isArray(records) || typeof integrityChecksum !== "string") {
      res.status(400).json({ error: "An exported bundle with records and integrityChecksum is required." });
      return;
    }
    if (records.length > AUDIT_EXPORT_MAX_LIMIT) {
      res.status(413).json({ error: `A bundle may contain at most ${AUDIT_EXPORT_MAX_LIMIT} records.` });
      return;
    }

    await connectDb();
    res.json(
      await verifyAuditExport({
        records,
        integrityChecksum,
        redactionProfile: typeof redactionProfile === "string" ? redactionProfile : undefined,
        schemaVersion: typeof schemaVersion === "number" ? schemaVersion : undefined,
      }),
    );
  },
);

/**
 * GET /api/audit/access-history
 * Query ownership, role, permission, and access changes.
 */
auditRouter.get(
  "/access-history",
  requireAdminScope("audit:export"),
  async (req: AdminRequest, res: Response) => {
    markPrivate(res);
    const { target, targetType, actor, action, since, until, limit, skip } = req.query;

    const parsedSince = parseDate(since);
    const parsedUntil = parseDate(until);
    if (parsedSince === null || parsedUntil === null) {
      return res.status(400).json({ error: "since and until must be valid dates." });
    }

    try {
      await connectDb();
      const result = await queryAccessAuditLogs({
        target: target ? String(target) : undefined,
        targetType: targetType ? String(targetType) : undefined,
        actor: actor ? String(actor) : undefined,
        action: action ? (String(action) as AuditAction) : undefined,
        since: parsedSince ?? undefined,
        until: parsedUntil ?? undefined,
        limit: limit ? Number(limit) : 50,
        skip: skip ? Number(skip) : 0,
      });

      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({
        error: (err as Error).message || "Failed to query access audit history",
      });
    }
  },
);

/**
 * GET /api/audit/access-history/export
 * Export ownership and access changes in JSON or CSV format.
 */
auditRouter.get(
  "/access-history/export",
  requireAdminScope("audit:export"),
  async (req: AdminRequest, res: Response) => {
    markPrivate(res);
    const { target, targetType, actor, action, since, until, format = "json" } = req.query;

    const parsedSince = parseDate(since);
    const parsedUntil = parseDate(until);
    if (parsedSince === null || parsedUntil === null) {
      return res.status(400).json({ error: "since and until must be valid dates." });
    }

    const exportFormat = String(format).toLowerCase() === "csv" ? "csv" : "json";

    try {
      await connectDb();
      const result = await exportAccessAuditLogs(
        {
          target: target ? String(target) : undefined,
          targetType: targetType ? String(targetType) : undefined,
          actor: actor ? String(actor) : undefined,
          action: action ? (String(action) as AuditAction) : undefined,
          since: parsedSince ?? undefined,
          until: parsedUntil ?? undefined,
        },
        exportFormat,
      );

      res.setHeader("Content-Type", result.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="access-audit-${Date.now()}.${exportFormat}"`,
      );
      return res.send(result.data);
    } catch (err) {
      return res.status(500).json({
        error: (err as Error).message || "Failed to export access audit history",
      });
    }
  },
);


/**
 * GET /api/audit/config-changes
 * Evidence for administrative configuration changes (#1026): who changed
 * which config, from what to what, and under which change id. Filters:
 * configType, configKey (requires configType), actor, changeId, since, until,
 * limit (1-200).
 */
auditRouter.get(
  "/config-changes",
  requireAdminScope("audit:export"),
  async (req: AdminRequest, res: Response) => {
    markPrivate(res);
    const { configType, configKey, actor, changeId, since, until, limit } = req.query;

    if (configType !== undefined && configType !== "feature_flag") {
      return res.status(400).json({ error: "configType must be one of: feature_flag" });
    }
    if (configKey !== undefined && configType === undefined) {
      return res.status(400).json({ error: "configKey requires configType." });
    }
    const parsedSince = parseDate(since);
    const parsedUntil = parseDate(until);
    if (parsedSince === null || parsedUntil === null) {
      return res.status(400).json({ error: "since and until must be valid dates." });
    }
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 200." });
    }

    try {
      await connectDb();
      const records = await queryConfigChangeEvidence({
        configType: configType as "feature_flag" | undefined,
        configKey: configKey ? String(configKey).toLowerCase() : undefined,
        actor: actor ? String(actor) : undefined,
        changeId: changeId ? String(changeId) : undefined,
        since: parsedSince ?? undefined,
        until: parsedUntil ?? undefined,
        limit: parsedLimit,
      });
      return res.json({ success: true, count: records.length, records });
    } catch (err) {
      return res.status(500).json({
        error: (err as Error).message || "Failed to query configuration change evidence",
      });
    }
  },
);
