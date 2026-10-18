import express from "express";
import {
  aggregateTrends,
  persistTrendMetrics,
  buildDailyTrendWindow,
  buildHourlyTrendWindow,
  type TrendWindow,
} from "../services/trendAggregationService";
import AggregatedAnalytics from "../models/AggregatedAnalytics";
import Purchase from "../models/Purchase";
import { requireAdminScope } from "../middleware/adminAuth";

export const trendAnalyticsRouter = express.Router();

/**
 * GET /api/admin/trend-analytics
 * Query historical trend metrics from the aggregated analytics store.
 * Query params: eventType, metricName, startTime, endTime, granularity
 */
trendAnalyticsRouter.get(
  "/",
  requireAdminScope("health:read"),
  async (req, res) => {
    try {
      const { eventType, metricName, startTime, endTime, granularity } = req.query;

      const query: any = {};
      if (eventType) query.eventType = String(eventType);
      if (metricName) query.metricName = String(metricName);
      if (granularity) query.granularity = String(granularity);

      if (startTime || endTime) {
        query.timeWindow = {};
        if (startTime) query.timeWindow.$gte = new Date(String(startTime));
        if (endTime) query.timeWindow.$lte = new Date(String(endTime));
      }

      const metrics = await AggregatedAnalytics.find(query)
        .sort({ timeWindow: 1, metricName: 1 })
        .lean();

      res.json({
        success: true,
        schemaVersion: 1,
        count: metrics.length,
        metrics,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch trend analytics" });
    }
  }
);

/**
 * POST /api/admin/trend-analytics/aggregate
 * Trigger on-demand trend aggregation for a time range.
 * Body: { windowDays: number, creatorWallet?: string }
 */
trendAnalyticsRouter.post(
  "/aggregate",
  requireAdminScope("health:read"),
  async (req, res) => {
    try {
      const { windowDays = 30, creatorWallet } = req.body as {
        windowDays?: number;
        creatorWallet?: string;
      };

      const endTime = new Date();
      const startTime = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      const windows: TrendWindow[] = buildDailyTrendWindow(windowDays);

      const events: Array<{
        eventType: string;
        timestamp: Date;
        value?: number;
        dimensions?: Record<string, string>;
      }> = [];

      const purchases = await Purchase.find({
        createdAt: { $gte: startTime, $lte: endTime },
      }).lean();

      for (const p of purchases) {
        events.push({
          eventType: "purchase",
          timestamp: new Date(p.createdAt),
          value: Number(p.amount) || 0,
          dimensions: { category: p.category ?? "uncategorized", status: p.status ?? "unknown" },
        });
      }

      const result = aggregateTrends(events, windows);
      await persistTrendMetrics(result);

      res.json({
        success: true,
        schemaVersion: result.schemaVersion,
        generatedAt: result.generatedAt,
        metricCount: result.metrics.length,
        redacted: result.redacted,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to aggregate trends" });
    }
  }
);

/**
 * GET /api/admin/trend-analytics/export
 * Export trend metrics as a schema-versioned report.
 * Query params: startTime, endTime, format (json|csv)
 */
trendAnalyticsRouter.get(
  "/export",
  requireAdminScope("health:read"),
  async (req, res) => {
    try {
      const { startTime, endTime, format = "json" } = req.query;

      const query: any = {};
      if (startTime || endTime) {
        query.timeWindow = {};
        if (startTime) query.timeWindow.$gte = new Date(String(startTime));
        if (endTime) query.timeWindow.$lte = new Date(String(endTime));
      }

      const metrics = await AggregatedAnalytics.find(query)
        .sort({ timeWindow: 1, metricName: 1 })
        .lean();

      const report = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        startTime: startTime ? String(startTime) : null,
        endTime: endTime ? String(endTime) : null,
        redacted: true,
        metrics: metrics.map((m) => ({
          eventType: m.eventType,
          timeWindow: m.timeWindow,
          granularity: m.granularity,
          dimensions: m.dimensions,
          metricName: m.metricName,
          metricType: m.metricType,
          value: m.value,
          count: m.count,
        })),
      };

      if (format === "csv") {
        const header =
          "eventType,timeWindow,granularity,dimensions,metricName,metricType,value,count";
        const rows = report.metrics.map(
          (m) =>
            `${m.eventType},${m.timeWindow},${m.granularity},"${JSON.stringify(m.dimensions)}",${m.metricName},${m.metricType},${m.value},${m.count}`
        );
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="trend-analytics.csv"');
        res.send([header, ...rows].join("\n"));
      } else {
        res.json({ success: true, report });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to export trend analytics" });
    }
  }
);