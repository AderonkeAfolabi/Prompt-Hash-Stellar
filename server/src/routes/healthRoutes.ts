import { Router, type Request, type Response } from "express";
import { requireAdminScope } from "../middleware/adminAuth";
import {
  createHealthMonitor,
  healthMonitor,
  httpStatusFor,
  toPublicHealth,
} from "../services/publicHealth";

/**
 * Public, dependency-aware health endpoints (#1027).
 *
 * GET /api/health/live    — liveness: the process is serving requests. Never
 *                           touches a dependency, so orchestrators don't
 *                           restart a replica because MongoDB blipped.
 * GET /api/health         — readiness: redacted dependency status; 503 (with
 *                           Retry-After) only when a critical dependency is
 *                           down. Served from a short-TTL cache.
 * GET /api/health/details — admin (`health:read`): the full report including
 *                           raw error detail and observed values;
 *                           `?refresh=true` bypasses the cache.
 *
 * The legacy `/health` route is unchanged.
 */
export function createHealthRouter(monitor: ReturnType<typeof createHealthMonitor> = healthMonitor) {
  const router = Router();

  router.get("/live", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get("/", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // Public callers can never force a probe round: they always share the
      // cached report, which bounds the load this endpoint can generate.
      const { report, cached } = await monitor.evaluate();
      const status = httpStatusFor(report.status);
      if (status === 503) res.setHeader("Retry-After", "30");
      res.status(status).json(toPublicHealth(report, cached));
    } catch {
      res.setHeader("Retry-After", "30");
      res.status(503).json({ status: "down", checkedAt: new Date().toISOString(), cached: false, dependencies: [] });
    }
  });

  router.get("/details", requireAdminScope("health:read"), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const { report, cached } = await monitor.evaluate(req.query.refresh === "true");
      res.status(httpStatusFor(report.status)).json({ ...report, cached });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message || "Health evaluation failed" });
    }
  });

  return router;
}

export const healthRouter = createHealthRouter();
