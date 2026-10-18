import express from "express";
import {
  runDegradationMatrixProbes,
  getDegradationMatrixDefinition,
  type DegradationMatrixReport,
} from "../services/dependencyDegradationMatrix";
import { requireAdminScope } from "../middleware/adminAuth";

export const dependencyHealthRouter = express.Router();

/**
 * GET /api/admin/dependency-health
 * Run all dependency probes and return a degradation matrix report.
 * Safe to call from monitoring dashboards — all probes are read-only.
 */
dependencyHealthRouter.get(
  "/",
  requireAdminScope("health:read"),
  async (_req, res) => {
    try {
      const report: DegradationMatrixReport = await runDegradationMatrixProbes();
      res.json({
        success: true,
        report,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to run dependency health checks" });
    }
  }
);

/**
 * GET /api/admin/dependency-health/definition
 * Return the static degradation matrix definition (failure modes, fallbacks,
 * recovery steps) without running probes. Useful for documentation and runbooks.
 */
dependencyHealthRouter.get(
  "/definition",
  requireAdminScope("health:read"),
  async (_req, res) => {
    try {
      const matrix = getDegradationMatrixDefinition();
      res.json({
        success: true,
        dependencies: matrix.map((entry) => ({
          name: entry.name,
          purpose: entry.purpose,
          failureModes: entry.failureModes.map((fm) => ({
            mode: fm.mode,
            description: fm.description,
            severity: fm.severity,
            fallbackBehavior: fm.fallbackBehavior,
            userMessage: fm.userMessage,
            recoverySteps: fm.recoverySteps,
          })),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch dependency health definition" });
    }
  }
);